import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Payment, Prisma, Role, VinHistoryPurchase, VinHistoryReport } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import { StripeService } from '../payments/stripe.service';
import {
  VinCheckDetailDto,
  VinCheckDownloadDto,
  VinCheckListDto,
  VinHistoryPreviewDto,
  VinHistoryUnlockDto,
} from './dto/vin-history.dto';
import { VinHistoryPayloadV1 } from './vin-history-payload-v1';
import { VIN_HISTORY_PROVIDER, VinHistoryProvider } from './vin-history.provider';

/**
 * Operator-facing alert for a VIN history that was paid for and could not be
 * delivered.
 *
 * `notification-types.ts` belongs to the notifications module and is not edited
 * here; both `TYPE_DEFAULT_CHANNELS` and `renderTemplate` fall back safely for
 * an unknown type (in-app only, subject = the type string), so the alert lands
 * in the admin bell today. Adding `vin_history.failed` to the type union and the
 * template catalogue — which would also give it an email — is a follow-up in
 * that module.
 */
const VIN_HISTORY_FAILED = 'vin_history.failed' as NotificationType;

/** Purchase lifecycle. `refunded` is terminal-good; `failed` needs a human. */
export type VinHistoryPurchaseStatus = 'pending' | 'ready' | 'failed' | 'refunded';

@Injectable()
export class VinHistoryService {
  private readonly logger = new Logger(VinHistoryService.name);
  private readonly webOrigin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeService,
    private readonly r2: R2Service,
    private readonly notifications: NotificationsService,
    @Inject(VIN_HISTORY_PROVIDER) private readonly provider: VinHistoryProvider,
    config: ConfigService<AppConfig, true>,
  ) {
    this.webOrigin = config.get('web', { infer: true }).origin.replace(/\/$/, '');
  }

  // ============================================================
  // Free preview
  // ============================================================

  /**
   * Counts and booleans for a VIN, free and unauthenticated.
   *
   * Served from the cache when one is warm, otherwise from the provider's FREE
   * availability probe — never from `fetch`, which is the billable call. With
   * only the mock provider available the numbers are generated and the response
   * says so (`synthetic: true`); the caller must surface that.
   *
   * The response is caller-independent on purpose. `@Public()` bypasses the JWT
   * guard entirely, so there is no authenticated identity here to personalise
   * with — 'do I already own this?' is answered by `GET /api/v1/me/vin-checks`,
   * which is authenticated and cannot be wrong.
   */
  async preview(vinRaw: string): Promise<VinHistoryPreviewDto> {
    const vin = vinRaw.toUpperCase();
    const cached = await this.findFreshReport(vin);

    const payload = cached ? (cached.payload as unknown as VinHistoryPayloadV1) : null;
    const summary = payload ? payload.summary : await this.provider.preview(vin);

    const [priceCents, cacheDays] = await Promise.all([
      this.settings.getCents('vinHistoryPriceEur'),
      this.settings.getNumber('vinHistoryCacheDays'),
    ]);

    return {
      vin,
      provider: payload?.provider ?? this.provider.name,
      synthetic: payload ? payload.synthetic : this.provider.synthetic,
      purchasable: this.provider.configured,
      summary: {
        recordCount: summary.recordCount,
        ownersCount: summary.ownersCount,
        // The COUNT, never the list — see VinHistoryPreviewSummaryDto.
        countriesCount: summary.countriesSeen.length,
        mileageRecordCount: payload ? payload.mileageRecords.length : 0,
        damageRecordCount: payload ? payload.damageRecords.length : 0,
        registrationCount: payload ? payload.registrations.length : summary.countriesSeen.length,
        recallCount: payload ? payload.recalls.length : 0,
        inspectionCount: payload ? payload.inspections.length : 0,
        hasAccidentRecords: summary.hasAccidentRecords,
        hasSalvageOrTotalLoss: summary.hasSalvageOrTotalLoss,
        hasOdometerRollback: summary.hasOdometerRollback,
        hasStolenRecord: summary.hasStolenRecord,
        hasOpenRecalls: summary.hasOpenRecalls,
        lastRecordedMileageKm: summary.lastRecordedMileageKm,
      },
      priceCents,
      currency: 'EUR',
      cacheDays,
    };
  }

  // ============================================================
  // Paid unlock
  // ============================================================

  /**
   * Buy the full history for a VIN.
   *
   * Idempotent on `(userId, vin)`: a user cannot be charged twice for the same
   * VIN however many times the button is pressed. A previously failed or
   * refunded purchase may be retried — the row is reused, so the uniqueness
   * guarantee survives the retry.
   */
  async unlock(userId: string, vinRaw: string): Promise<VinHistoryUnlockDto> {
    const vin = vinRaw.toUpperCase();

    // The load-bearing refusal. With no real provider configured, the only data
    // available is generated — charging for it would be selling invented facts
    // about someone's car. No payment row is created, so nothing to refund.
    if (!this.provider.configured) {
      throw new ServiceUnavailableException({
        error: {
          code: 'provider_unavailable',
          message:
            'VIN history is temporarily unavailable — no data provider is configured. ' +
            'You have not been charged.',
        },
      });
    }

    const amountCents = await this.settings.getCents('vinHistoryPriceEur');
    const existing = await this.prisma.vinHistoryPurchase.findUnique({
      where: { userId_vin: { userId, vin } },
    });

    if (existing?.status === 'ready') {
      return {
        purchaseId: existing.id,
        status: 'ready',
        alreadyOwned: true,
        amountCents,
        currency: 'EUR',
      };
    }

    // A pending purchase with a pending payment is the same attempt resumed, not
    // a second sale: reuse both rows so a double-click cannot create two charges.
    let purchase = existing;
    if (purchase) {
      purchase = await this.prisma.vinHistoryPurchase.update({
        where: { id: purchase.id },
        data: { status: 'pending', failureReason: null, provider: this.provider.name },
      });
    } else {
      purchase = await this.createPurchase(userId, vin);
      if (purchase === null) {
        // Lost a concurrent race on the unique index — the winner's row is the
        // truth. Re-read and answer from it.
        const winner = await this.prisma.vinHistoryPurchase.findUniqueOrThrow({
          where: { userId_vin: { userId, vin } },
        });
        return {
          purchaseId: winner.id,
          status: winner.status,
          alreadyOwned: winner.status === 'ready',
          amountCents,
          currency: 'EUR',
        };
      }
    }

    const payment = await this.reusableOrNewPayment(purchase, userId, amountCents);

    if (!this.stripe.configured) {
      const result = await this.fulfill(payment.id, purchase.id, vin);
      if (!result.ok) {
        throw new BadGatewayException({
          error: {
            code: 'provider_failed',
            message:
              'The VIN history provider did not answer. Your payment has been refunded in full.',
            refunded: true,
          },
        });
      }
      return {
        purchaseId: purchase.id,
        status: 'ready',
        mock: true,
        amountCents,
        currency: 'EUR',
        checkoutUrl: `${this.webOrigin}/account/vin-checks?vin=mock`,
      };
    }

    const { checkoutUrl } = await this.stripe.createVinHistoryCheckout({
      paymentId: payment.id,
      purchaseId: purchase.id,
      userId,
      vin,
      amountCents,
      successUrl: `${this.webOrigin}/account/vin-checks?purchase=success`,
      cancelUrl: `${this.webOrigin}/vin/${vin}`,
    });

    const session = checkoutUrl.match(/cs_[A-Za-z0-9_]+/)?.[0];
    if (session) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripeCheckoutSessionId: session },
      });
    }

    return { purchaseId: purchase.id, status: 'pending', checkoutUrl, amountCents, currency: 'EUR' };
  }

  /**
   * Webhook entry point, resolved lazily by `PaymentsService`.
   *
   * Never throws: a Stripe webhook that 500s is retried forever, and a provider
   * outage is not something Stripe can fix by redelivering. Failures are handled
   * here (refund + admin alert) and the webhook still reports success.
   */
  async fulfillFromWebhook(paymentId: string, purchaseId: string, vin: string): Promise<void> {
    try {
      await this.fulfill(paymentId, purchaseId, vin.toUpperCase());
    } catch (err) {
      this.logger.error(
        `VIN history fulfilment crashed for purchase ${purchaseId}: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // Buyer's archive
  // ============================================================

  async listMine(userId: string): Promise<VinCheckListDto> {
    const rows = await this.prisma.vinHistoryPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { report: { select: { expiresAt: true, payload: true } } },
    });
    return { items: rows.map((r) => this.toItem(r, r.report)) };
  }

  async getMine(userId: string, id: string): Promise<VinCheckDetailDto> {
    const purchase = await this.requireOwnedPurchase(userId, id);
    const payload = purchase.report
      ? (purchase.report.payload as unknown as VinHistoryPayloadV1)
      : null;
    return {
      ...this.toItem(purchase, purchase.report),
      // The paid artefact. Null until the purchase is ready — a pending or
      // refunded purchase must not leak the data it did not pay for.
      payload: purchase.status === 'ready' ? payload : null,
    };
  }

  /**
   * A short-lived PRIVATE signed URL for the archived payload.
   *
   * `createPrivateSignedUrl` is used rather than `createPresignedDownloadUrl`
   * because the latter short-circuits to `R2_PUBLIC_URL` when that is set, which
   * would make every purchased report world-readable the day an operator
   * configures a public bucket base.
   */
  async downloadMine(userId: string, id: string): Promise<VinCheckDownloadDto> {
    const purchase = await this.requireOwnedPurchase(userId, id);
    if (purchase.status !== 'ready' || !purchase.report?.rawS3Key || !this.r2.isConfigured()) {
      throw new NotFoundException({
        error: {
          code: 'download_unavailable',
          message: 'No archived copy of this VIN history is available for download.',
        },
      });
    }
    const { url, expiresAt } = await this.r2.createPrivateSignedUrl(purchase.report.rawS3Key);
    return { url, expiresAt: expiresAt.toISOString(), contentType: 'application/json' };
  }

  // ============================================================
  // Internals
  // ============================================================

  private async createPurchase(
    userId: string,
    vin: string,
  ): Promise<VinHistoryPurchase | null> {
    try {
      return await this.prisma.vinHistoryPurchase.create({
        data: { userId, vin, status: 'pending', provider: this.provider.name },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  /**
   * Reuse the purchase's still-pending payment rather than opening a second one.
   * Two pending payments for one purchase is how a user ends up charged twice
   * when both checkouts are eventually completed.
   */
  private async reusableOrNewPayment(
    purchase: VinHistoryPurchase,
    userId: string,
    amountCents: number,
  ): Promise<Payment> {
    if (purchase.paymentId) {
      const existing = await this.prisma.payment.findUnique({ where: { id: purchase.paymentId } });
      if (existing && existing.status === 'pending' && existing.amountCents === amountCents) {
        return existing;
      }
    }
    const payment = await this.prisma.payment.create({
      data: { purpose: 'vin_history', userId, amountCents, status: 'pending' },
    });
    await this.prisma.vinHistoryPurchase.update({
      where: { id: purchase.id },
      data: { paymentId: payment.id },
    });
    return payment;
  }

  /**
   * Mark the payment succeeded and attach a report to the purchase.
   * Idempotent: a replayed webhook for an already-ready purchase is a no-op.
   */
  private async fulfill(
    paymentId: string,
    purchaseId: string,
    vin: string,
  ): Promise<{ ok: boolean }> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'succeeded' } })
      .catch(() => undefined);

    const purchase = await this.prisma.vinHistoryPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return { ok: false };
    if (purchase.status === 'ready') return { ok: true };

    try {
      const report = await this.resolveReport(vin);
      await this.prisma.vinHistoryPurchase.update({
        where: { id: purchaseId },
        data: {
          status: 'ready',
          reportId: report.id,
          provider: report.provider,
          readyAt: new Date(),
          failureReason: null,
        },
      });
      return { ok: true };
    } catch (err) {
      await this.failAndRefund(purchase, paymentId, err as Error);
      return { ok: false };
    }
  }

  /**
   * A paid lookup that could not be delivered.
   *
   * Keeping the money for an undeliverable report is the failure mode this whole
   * path exists to prevent, so the refund is automatic and immediate rather than
   * a support ticket. The purchase ends `refunded` when the money is back and
   * `failed` when even the refund did not go through — the second case is a
   * human's problem and is why admins are alerted either way.
   */
  private async failAndRefund(
    purchase: VinHistoryPurchase,
    paymentId: string,
    err: Error,
  ): Promise<void> {
    const reason = err.message.slice(0, 480);
    this.logger.error(`VIN history provider failed for ${purchase.vin}: ${reason}`);

    await this.prisma.vinHistoryPurchase.update({
      where: { id: purchase.id },
      data: { status: 'failed', failureReason: reason },
    });

    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    let refunded = false;
    if (payment) {
      refunded = await this.refundPayment(payment, reason);
    }

    if (refunded) {
      await this.prisma.vinHistoryPurchase.update({
        where: { id: purchase.id },
        data: { status: 'refunded' },
      });
    }

    await this.alertAdmins({
      purchaseId: purchase.id,
      userId: purchase.userId,
      vin: purchase.vin,
      provider: this.provider.name,
      amountCents: payment?.amountCents ?? 0,
      reason,
      refunded,
    });
  }

  /** Issue the refund and record the ledger row. Returns false if it failed. */
  private async refundPayment(payment: Payment, reason: string): Promise<boolean> {
    try {
      let stripeRefundId: string;
      if (this.stripe.configured && payment.stripePaymentIntentId) {
        const refund = await this.stripe.createRefund(
          payment.stripePaymentIntentId,
          payment.amountCents,
          'vin_history_provider_failed',
        );
        stripeRefundId = refund.id;
      } else {
        // Mock mode (or a Checkout session with no captured PaymentIntent yet):
        // there is nothing to call, but the ledger must still show the money
        // going back, or a reconciliation would find an unexplained charge.
        stripeRefundId = `re_local_${payment.id}`;
      }

      await this.prisma.refund
        .create({
          data: {
            paymentId: payment.id,
            amountCents: payment.amountCents,
            reason: 'vin_history_provider_failed',
            stripeRefundId,
          },
        })
        .catch((err: unknown) => {
          // Already refunded (replay) — the row is the idempotency marker.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
          throw err;
        });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'refunded' },
      });
      this.logger.log(
        `Refunded ${payment.amountCents} cents for failed VIN history payment ${payment.id} (${reason})`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Refund FAILED for VIN history payment ${payment.id}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Fan an alert out to every active admin. Never throws. */
  private async alertAdmins(payload: Record<string, unknown>): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify(admin.id, VIN_HISTORY_FAILED, payload);
    }
  }

  /** The cached report for this VIN, or null when absent/expired. */
  private async findFreshReport(vin: string): Promise<VinHistoryReport | null> {
    const cached = await this.prisma.vinHistoryReport.findUnique({
      where: { vin_provider: { vin, provider: this.provider.name } },
    });
    return cached && cached.expiresAt.getTime() > Date.now() ? cached : null;
  }

  /**
   * Cache-or-fetch. Providers charge per lookup, so a warm cache is shared
   * across buyers: two users unlocking the same VIN inside the window each pay
   * the platform, and the provider is queried once.
   */
  private async resolveReport(vin: string): Promise<VinHistoryReport> {
    const fresh = await this.findFreshReport(vin);
    if (fresh) return fresh;

    const payload = await this.provider.fetch(vin);
    const cacheDays = await this.settings.getNumber('vinHistoryCacheDays');
    const expiresAt = new Date(Date.now() + cacheDays * 86_400_000);
    const rawS3Key = await this.archive(vin, payload);

    return this.prisma.vinHistoryReport.upsert({
      where: { vin_provider: { vin, provider: this.provider.name } },
      create: {
        vin,
        provider: this.provider.name,
        payload: payload as unknown as Prisma.InputJsonValue,
        recordCount: payload.summary.recordCount,
        rawS3Key,
        expiresAt,
      },
      update: {
        payload: payload as unknown as Prisma.InputJsonValue,
        recordCount: payload.summary.recordCount,
        rawS3Key,
        fetchedAt: new Date(),
        expiresAt,
      },
    });
  }

  /**
   * Archive the payload so a buyer can download the artefact they paid for even
   * after the cache is refreshed with newer data. Best-effort: an R2 outage must
   * not turn a successful paid lookup into a refund.
   */
  private async archive(vin: string, payload: VinHistoryPayloadV1): Promise<string | null> {
    if (!this.r2.isConfigured()) return null;
    const key = `vin-history/${this.provider.name}/${vin}.json`;
    try {
      await this.r2.putObject(key, JSON.stringify(payload, null, 2), 'application/json');
      return key;
    } catch (err) {
      this.logger.warn(`Could not archive VIN history for ${vin}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Load a purchase the caller owns, or 404.
   *
   * A stranger's purchase is a 404, NOT a 403: a 403 confirms the id exists,
   * which turns this route into an oracle for enumerating purchase ids.
   */
  private async requireOwnedPurchase(
    userId: string,
    id: string,
  ): Promise<
    Prisma.VinHistoryPurchaseGetPayload<{
      include: { report: { select: { expiresAt: true; payload: true; rawS3Key: true } } };
    }>
  > {
    const purchase = await this.prisma.vinHistoryPurchase.findFirst({
      where: { id, userId },
      include: { report: { select: { expiresAt: true, payload: true, rawS3Key: true } } },
    });
    if (!purchase) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'VIN check not found' },
      });
    }
    return purchase;
  }

  private toItem(
    purchase: VinHistoryPurchase,
    report: { expiresAt: Date; payload: Prisma.JsonValue } | null,
  ) {
    const payload = report ? (report.payload as unknown as VinHistoryPayloadV1) : null;
    return {
      id: purchase.id,
      vin: purchase.vin,
      status: purchase.status,
      provider: purchase.provider,
      synthetic: payload ? payload.synthetic === true : this.provider.synthetic,
      failureReason: purchase.failureReason,
      createdAt: purchase.createdAt.toISOString(),
      readyAt: purchase.readyAt ? purchase.readyAt.toISOString() : null,
      expiresAt: report ? report.expiresAt.toISOString() : null,
    };
  }
}
