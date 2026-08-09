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
  VinCheckDownloadFormat,
  VinCheckListDto,
  VinHistoryPreviewDto,
  VinHistoryUnlockDto,
} from './dto/vin-history.dto';
import { VinHistoryPayloadV1 } from './vin-history-payload-v1';
import { resolveVinHistoryPdfLocale } from './vin-history-pdf.i18n';
import { renderVinHistoryPdf, vinHistoryPdfFilename } from './vin-history-pdf.renderer';
import {
  VIN_HISTORY_PROVIDER,
  VinHistoryPreviewCounts,
  VinHistoryProvider,
} from './vin-history.provider';

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

/**
 * Statuses a settlement must not re-enter.
 *
 * Stripe redelivers a webhook for days, and each delivery arrives at `fulfill`
 * with the same payment and purchase ids. Only `ready` used to stop it, so a
 * purchase that had already been refunded would run the whole path again — a
 * fresh billable provider lookup, and, if the provider had recovered in the
 * meantime, delivery of the report the buyer's money had already been returned
 * for. `failed` is terminal for the opposite reason: it means the refund itself
 * did not go through and an operator has to look, which an automatic retry
 * would paper over.
 *
 * Retrying a genuinely transient outage is still possible and still supported —
 * it goes through `unlock`, which reopens the purchase to `pending` deliberately
 * and re-uses or re-creates the payment. That is an explicit re-attempt with a
 * live payer behind it, not a redelivery a refunded payment can ride in on.
 */
const TERMINAL_PURCHASE_STATUSES: ReadonlySet<string> = new Set<VinHistoryPurchaseStatus>([
  'ready',
  'refunded',
  'failed',
]);

/**
 * Fewest records a report must carry to be worth charging for.
 *
 * A provider that answers 200 with nothing in it is not a failure it can be
 * detected by `try`/`catch` — it is a valid response that happens to be
 * worthless, and every consumer review of the shortlisted providers is
 * dominated by exactly that complaint. One record is the deliberately
 * conservative floor: it refuses only the genuinely empty answer, so no buyer
 * who received something is refunded against their will. Raise it once F3-4 has
 * measured the real hit rate for German VINs.
 */
const MIN_SELLABLE_RECORD_COUNT = 1;

/**
 * How often a purchase may fail to render before the renderer stops trying.
 *
 * The document is produced at fulfilment AND lazily on the first download,
 * which makes the download path the backfill for every purchase made before it
 * existed — cheaper and more honest than a migration that re-reads every old
 * payload out of R2 to render documents most buyers never ask for. The flip
 * side is that a payload this renderer cannot handle would otherwise be retried
 * on every download forever, so the attempts are capped. A render failure never
 * costs the buyer anything: the sale stands and the JSON stays available.
 */
const MAX_PDF_RENDER_ATTEMPTS = 3;

/** The ledger reason for every refund this module issues. */
const REFUND_REASON = 'vin_history_provider_failed';

/**
 * A provider answer that arrived intact and holds nothing to sell.
 *
 * Carried as an Error so it travels the same path as a provider outage: caught
 * in `fulfill`, refunded by `failAndRefund`, surfaced to the caller as
 * `provider_failed` with `refunded: true`. The buyer's experience of "the
 * lookup did not produce a report, your money is back" is identical either way.
 */
class EmptyProviderResponseError extends Error {
  constructor(vin: string, recordCount: number) {
    super(
      `Provider returned no usable history for ${vin} ` +
        `(${recordCount} records, minimum ${MIN_SELLABLE_RECORD_COUNT})`,
    );
    this.name = 'EmptyProviderResponseError';
  }
}

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
    // A warm cache answers from the payload we already hold; otherwise the
    // provider's FREE probe. Note what does NOT happen here: the probe's answer
    // is never written to the report cache. A real provider's free probe returns
    // counts and nothing else, and caching it would leave a hollow report row
    // that the next unlock would sell as a full one.
    const probe = payload ? null : await this.provider.preview(vin);
    const summary = payload ? payload.summary : probe!;
    const counts: VinHistoryPreviewCounts = payload
      ? {
          // Array lengths, so the free preview and the paid report can never
          // disagree about how much is in there.
          mileageRecordCount: (payload.mileageRecords ?? []).length,
          damageRecordCount: (payload.damageRecords ?? []).length,
          registrationCount: (payload.registrations ?? []).length,
          recallCount: (payload.recalls ?? []).length,
          inspectionCount: (payload.inspections ?? []).length,
        }
      : {
          // Straight from the provider, null included. Null means "not published
          // before you pay" and must NOT be flattened to 0 — "0 accident
          // records" is a claim about the car. The old code answered 0 for four
          // of these and substituted the COUNTRY count for registrations, which
          // happened to match in the mock and is simply wrong for a car
          // registered twice in one country.
          mileageRecordCount: probe!.mileageRecordCount ?? null,
          damageRecordCount: probe!.damageRecordCount ?? null,
          registrationCount: probe!.registrationCount ?? null,
          recallCount: probe!.recallCount ?? null,
          inspectionCount: probe!.inspectionCount ?? null,
        };

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
        countriesCount: (summary.countriesSeen ?? []).length,
        ...counts,
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
      // Conditional, because this row may have been made `ready` by a request
      // running alongside this one — the check above read it before that
      // happened. A blind write here would reset a completed sale to `pending`
      // and send this attempt on to open a second payment for it.
      await this.prisma.vinHistoryPurchase.updateMany({
        where: { id: purchase.id, status: { not: 'ready' } },
        data: { status: 'pending', failureReason: null, provider: this.provider.name },
      });
      purchase = await this.prisma.vinHistoryPurchase.findUniqueOrThrow({
        where: { id: purchase.id },
      });
      if (purchase.status === 'ready') {
        return {
          purchaseId: purchase.id,
          status: 'ready',
          alreadyOwned: true,
          amountCents,
          currency: 'EUR',
        };
      }
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

    // Money already in, fulfilment not finished. Sending this caller to a fresh
    // Checkout would charge them a second time for a purchase that is paid for
    // — the state is reached by a settled payment whose refund failed, or by a
    // webhook still in flight. The honest answer is "we have your money, the
    // report is coming", with no payment page attached.
    if (payment.status === 'succeeded') {
      return { purchaseId: purchase.id, status: 'pending', amountCents, currency: 'EUR' };
    }

    const { checkoutUrl, sessionId } = await this.stripe.createVinHistoryCheckout({
      paymentId: payment.id,
      purchaseId: purchase.id,
      userId,
      vin,
      amountCents,
      successUrl: `${this.webOrigin}/account/vin-checks?purchase=success`,
      cancelUrl: `${this.webOrigin}/vin/${vin}`,
    });

    // Stripe hands us the session id. It used to be scraped out of the URL with
    // a regex whose failure was silent: no match, no id, and reconciliation
    // left with nothing to ask Stripe about for that payment.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: sessionId },
    });

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
    const payload = this.soldPayload(purchase, purchase.report);
    return {
      ...this.toItem(purchase, purchase.report),
      // The paid artefact. Null until the purchase is ready — a pending or
      // refunded purchase must not leak the data it did not pay for.
      payload: purchase.status === 'ready' ? payload : null,
      pdfLocale: purchase.pdfLocale,
    };
  }

  /**
   * A short-lived PRIVATE signed URL for what the buyer paid for.
   *
   * `pdf` (the default) is the rendered document — that is what a person means
   * by "download my report"; `json` is the archived payload, for anyone
   * integrating against it. The PDF is rendered on demand when it is missing,
   * which is also how purchases made before the document existed get one.
   *
   * `createPrivateSignedUrl` is used rather than `createPresignedDownloadUrl`
   * because the latter short-circuits to `R2_PUBLIC_URL` when that is set, which
   * would make every purchased report world-readable the day an operator
   * configures a public bucket base. The signed URL carries a
   * `Content-Disposition` filename so the browser saves
   * `carsalepro-vin-history-<VIN>.pdf` rather than a cuid.
   */
  async downloadMine(
    userId: string,
    id: string,
    format: VinCheckDownloadFormat = 'pdf',
  ): Promise<VinCheckDownloadDto> {
    const purchase = await this.requireOwnedPurchase(userId, id);

    // This buyer's own snapshot, falling back to the shared archive only for
    // purchases fulfilled before per-purchase keys existed.
    const key =
      purchase.status !== 'ready' || !this.r2.isConfigured()
        ? null
        : format === 'pdf'
          ? await this.ensurePdfKey(purchase, purchase.report)
          : (purchase.s3Key ?? purchase.report?.rawS3Key ?? null);

    if (!key) {
      throw new NotFoundException({
        error: {
          code: 'download_unavailable',
          message: 'No archived copy of this VIN history is available for download.',
        },
      });
    }

    const contentType = format === 'pdf' ? 'application/pdf' : 'application/json';
    const filename =
      format === 'pdf'
        ? vinHistoryPdfFilename(purchase.vin)
        : `carsalepro-vin-history-${purchase.vin}.json`;
    const { url, expiresAt } = await this.r2.createPrivateSignedUrl(key, undefined, {
      filename,
      contentType,
    });
    return { url, expiresAt: expiresAt.toISOString(), contentType, format, filename };
  }

  // ============================================================
  // The rendered document
  // ============================================================

  /**
   * The R2 key of this purchase's PDF, rendering it first if need be.
   *
   * Returns null instead of throwing, always. A missing document is a degraded
   * download, never a failed sale and never a broken JSON view — which is why
   * `fulfill` can call this without a guard and why the buyer keeps everything
   * they paid for when a render goes wrong.
   *
   * The key carries the locale, so a buyer who switches language gets a second
   * document rather than an overwritten one, and the row points at the newest.
   */
  private async ensurePdfKey(
    purchase: VinHistoryPurchase,
    report: { payload: Prisma.JsonValue } | null = null,
  ): Promise<string | null> {
    if (purchase.status !== 'ready' || !this.r2.isConfigured()) return null;

    const locale = resolveVinHistoryPdfLocale(await this.buyerLocale(purchase.userId));
    if (purchase.pdfS3Key && purchase.pdfLocale === locale) return purchase.pdfS3Key;

    // Capped. A payload this renderer cannot handle must not be re-attempted on
    // every download for the rest of the purchase's life.
    if (purchase.pdfAttempts >= MAX_PDF_RENDER_ATTEMPTS) return purchase.pdfS3Key ?? null;

    const payload = this.soldPayload(purchase, report);
    if (!payload) return purchase.pdfS3Key ?? null;

    const provider = purchase.provider ?? this.provider.name;
    const key = `vin-history/${provider}/${purchase.vin}/${purchase.id}-${locale}.pdf`;
    try {
      const pdf = await renderVinHistoryPdf(payload, {
        locale,
        purchaseId: purchase.id,
        purchasedAt: purchase.readyAt ?? purchase.createdAt,
      });
      await this.r2.putObject(key, pdf, 'application/pdf');
      await this.prisma.vinHistoryPurchase.update({
        where: { id: purchase.id },
        data: { pdfS3Key: key, pdfLocale: locale, pdfRenderedAt: new Date() },
      });
      return key;
    } catch (err) {
      this.logger.warn(
        `VIN history PDF render failed for purchase ${purchase.id}: ${(err as Error).message}`,
      );
      await this.prisma.vinHistoryPurchase
        .update({ where: { id: purchase.id }, data: { pdfAttempts: { increment: 1 } } })
        .catch(() => undefined);
      // A stale document in another language still beats no document at all.
      return purchase.pdfS3Key ?? null;
    }
  }

  /** The document is rendered in the buyer's own language. */
  private async buyerLocale(userId: string): Promise<string | null> {
    const user = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { locale: true } })
      .catch(() => null);
    return user?.locale ?? null;
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
   *
   * The attachment is a compare-and-set on the value this attempt actually
   * observed — `null` included — rather than a blind write. Reading
   * `purchase.paymentId` and then updating is correct in sequence and empty
   * under concurrency: a double-click has both requests read the row before
   * either writes it, both conclude there is no payment to reuse, and both open
   * one. The unique index on `(userId, vin)` keeps that to a single purchase, so
   * the second payment is not even visible in the product — it is an orphaned
   * successful charge that the admin finance summary counts as revenue.
   *
   * Losing the CAS is therefore normal, not exceptional: the loser deletes the
   * row it just created and re-reads. That deletion is safe because the payment
   * has not been through Checkout yet — it is created here and only handed to
   * Stripe by the caller afterwards.
   */
  private async reusableOrNewPayment(
    purchase: VinHistoryPurchase,
    userId: string,
    amountCents: number,
  ): Promise<Payment> {
    let observed = purchase.paymentId;

    // Bounded: each iteration either returns or observes a payment id written
    // by someone else, and a purchase cannot change hands indefinitely inside
    // one request. The cap exists so a pathological interleaving fails loudly
    // instead of spinning.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (observed) {
        const existing = await this.prisma.payment.findUnique({ where: { id: observed } });
        // `succeeded` counts as reusable, not as spent. A concurrent attempt
        // that has already settled means the money for this purchase is in —
        // opening a second payment beside it is the double charge itself. Only
        // `refunded` and `failed` are genuinely finished and warrant a new one.
        //
        // The amount is checked here too, not only on the `pending` branch: a
        // settled payment for a different amount is a price change between the
        // two attempts, and answering with it would report the wrong sum to the
        // caller. It cannot be re-charged either way — the caller refuses to
        // open a Checkout for a `succeeded` payment.
        if (existing && existing.status === 'succeeded' && existing.amountCents === amountCents) {
          return existing;
        }
        if (existing && existing.status === 'pending' && existing.amountCents === amountCents) {
          return existing;
        }
        // Superseded: a stale `pending` row (wrong amount) would otherwise stay
        // open forever once the purchase points elsewhere, and every
        // reconciliation pass would have to explain it. The CAS loser below is
        // deleted outright; this one is kept as `failed` because it may already
        // have a Checkout session behind it.
        if (existing && existing.status === 'pending') {
          await this.prisma.payment
            .update({ where: { id: existing.id }, data: { status: 'failed' } })
            .catch(() => undefined);
        }
      }

      const payment = await this.prisma.payment.create({
        data: { purpose: 'vin_history', userId, amountCents, status: 'pending' },
      });
      const claimed = await this.prisma.vinHistoryPurchase.updateMany({
        where: { id: purchase.id, paymentId: observed },
        data: { paymentId: payment.id },
      });
      if (claimed.count === 1) return payment;

      // Someone else attached a payment between our read and our write. Drop
      // ours before it can be charged, then look at what they attached.
      await this.prisma.payment.delete({ where: { id: payment.id } }).catch(() => undefined);
      const current = await this.prisma.vinHistoryPurchase.findUnique({
        where: { id: purchase.id },
      });
      observed = current?.paymentId ?? null;
    }

    throw new ServiceUnavailableException({
      error: {
        code: 'payment_conflict',
        message: 'Could not start this purchase. Please try again — you have not been charged.',
      },
    });
  }

  /**
   * Mark the payment succeeded and attach a report to the purchase.
   *
   * Idempotent: a replayed webhook for a purchase that has already reached a
   * terminal status is a no-op, and nothing here runs before that is checked —
   * not the payment write, not the provider lookup.
   */
  private async fulfill(
    paymentId: string,
    purchaseId: string,
    vin: string,
  ): Promise<{ ok: boolean }> {
    const purchase = await this.prisma.vinHistoryPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return { ok: false };
    if (TERMINAL_PURCHASE_STATUSES.has(purchase.status)) {
      return { ok: purchase.status === 'ready' };
    }

    // The purchase status is not the whole story: money can leave after the row
    // was written. A chargeback or an out-of-band refund marks the PAYMENT
    // `refunded` while the purchase sits at `pending`, and fulfilling that would
    // pay the provider for a report we have already been made to give back.
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (payment?.status === 'refunded') {
      this.logger.warn(
        `fulfill: payment ${paymentId} is refunded — refusing to deliver purchase ${purchaseId}`,
      );
      await this.prisma.vinHistoryPurchase.updateMany({
        where: { id: purchaseId, status: { not: 'ready' } },
        data: { status: 'refunded', failureReason: 'payment_refunded' },
      });
      return { ok: false };
    }

    // Settled at Stripe, so the payment is truthfully `succeeded` — but never
    // walk one back out of `refunded`. That status is the ledger's record that
    // the money left again; overwriting it here is how a refunded sale came to
    // read as a successful one. `updateMany` also spares the missing-row catch
    // this used to need.
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: { not: 'refunded' } },
      data: { status: 'succeeded' },
    });

    try {
      const report = await this.resolveReport(vin);

      // A warm cache can hold a report that predates MIN_SELLABLE_RECORD_COUNT
      // (or was cached before this check existed). Re-checking here means the
      // rule is enforced on what is actually being SOLD, not only on what was
      // just fetched.
      if (report.recordCount < MIN_SELLABLE_RECORD_COUNT) {
        throw new EmptyProviderResponseError(vin, report.recordCount);
      }

      const payload = report.payload as unknown as VinHistoryPayloadV1;
      // The buyer's own copy, written before the purchase is marked ready so a
      // `ready` purchase is never left without the artefact it promises.
      // Best-effort by design: an R2 outage returns null and must not turn a
      // successful paid lookup into a refund.
      const s3Key = await this.archive(vin, payload, purchaseId);

      const ready = await this.prisma.vinHistoryPurchase.update({
        where: { id: purchaseId },
        data: {
          status: 'ready',
          reportId: report.id,
          provider: report.provider,
          readyAt: new Date(),
          failureReason: null,
          // Immutable snapshot: the shared report row this was copied from is a
          // cache and the next buyer of this VIN will overwrite it.
          payload: report.payload as Prisma.InputJsonValue,
          s3Key,
        },
      });

      // Render the document now so the first download is instant. Deliberately
      // AFTER the purchase is `ready` and deliberately unguarded: ensurePdfKey
      // swallows its own failures, because a renderer bug must not undo a sale
      // that has already been paid for and delivered.
      await this.ensurePdfKey(ready);
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

    // An empty answer is a normal outcome, not an incident: the provider is up,
    // it simply holds nothing for this VIN, and the buyer has already been
    // refunded. Alerting on it would page every admin on every such lookup —
    // and by our own reading of the shortlisted providers, empty answers are
    // the common complaint, so the alert would train them to ignore the channel
    // that also carries "the refund did not go through".
    const isRoutine = err instanceof EmptyProviderResponseError && refunded;
    if (!isRoutine) {
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
  }

  /** Issue the refund and record the ledger row. Returns false if it failed. */
  private async refundPayment(payment: Payment, reason: string): Promise<boolean> {
    // Set once the ledger row says the money went back, so a failure AFTER that
    // point cannot rewrite a successful refund as a failed one.
    let recorded = false;
    try {
      let stripeRefundId: string;
      if (this.stripe.configured && payment.stripePaymentIntentId) {
        const refund = await this.stripe.createRefund(
          payment.stripePaymentIntentId,
          payment.amountCents,
          REFUND_REASON,
          // `Refund.paymentId` is unique here, so the payment id is this
          // refund's identity and is stable across every retry of it.
          `refund_payment_${payment.id}`,
        );
        stripeRefundId = refund.id;
      } else {
        // Mock mode (or a Checkout session with no captured PaymentIntent yet):
        // there is nothing to call, but the ledger must still show the money
        // going back, or a reconciliation would find an unexplained charge.
        stripeRefundId = `re_local_${payment.id}`;
      }

      // Upsert on the payment rather than create-and-swallow-P2002.
      // `Refund.paymentId` is unique, so a second row was never possible; what
      // the old catch actually did was leave an EARLIER row untouched. After a
      // first attempt that failed, the retry that succeeded would leave that row
      // reading `failed` for ever — money returned, still shown as owed.
      //
      // `status` is written explicitly. It defaults to 'pending', so every VIN
      // history refund that had in fact settled was sitting in the admin refund
      // queue as unresolved, and the finance summary could not be narrowed to
      // refunds that really happened.
      await this.prisma.refund.upsert({
        where: { paymentId: payment.id },
        create: {
          paymentId: payment.id,
          amountCents: payment.amountCents,
          reason: REFUND_REASON,
          stripeRefundId,
          status: 'succeeded',
          attempts: 1,
          lastAttemptAt: new Date(),
        },
        update: {
          amountCents: payment.amountCents,
          stripeRefundId,
          status: 'succeeded',
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          lastError: null,
          nextRetryAt: null,
        },
      });
      recorded = true;

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'refunded' },
      });
      this.logger.log(
        `Refunded ${payment.amountCents} cents for failed VIN history payment ${payment.id} (${reason})`,
      );
      return true;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Refund FAILED for VIN history payment ${payment.id}: ${message}`);
      if (!recorded) await this.parkFailedRefund(payment, message);
      return false;
    }
  }

  /**
   * Record a refund that did not go through.
   *
   * A `Refund` row is the ledger's statement that money is owed back, so a
   * failed attempt gets one too — otherwise the only trace of a payment we kept
   * by accident is a log line and one notification.
   *
   * Written TERMINAL (`nextRetryAt: null`) on purpose:
   * `OrdersService.retryStuckRefunds` selects only refunds that belong to an
   * ORDER, and a VIN history refund has none. Scheduling a retry here would put
   * a row in a queue nobody drains, which reads as "being handled" and is not.
   * This needs a human, which is exactly what the admin alert beside it says.
   */
  private async parkFailedRefund(payment: Payment, error: string): Promise<void> {
    const data = {
      amountCents: payment.amountCents,
      status: 'failed',
      lastError: error.slice(0, 500),
      lastAttemptAt: new Date(),
      nextRetryAt: null,
    };
    await this.prisma.refund
      .upsert({
        where: { paymentId: payment.id },
        create: { paymentId: payment.id, reason: REFUND_REASON, attempts: 1, ...data },
        update: { attempts: { increment: 1 }, ...data },
      })
      .catch((err: unknown) => {
        // The refund already failed; losing the record of that must not throw
        // into the caller as well.
        this.logger.error(
          `Could not record the failed VIN history refund for payment ${payment.id}: ` +
            (err as Error).message,
        );
      });
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

    // Refuse BEFORE the upsert so an empty answer is never cached: a VIN that
    // gains its first record tomorrow must not stay unsellable for the rest of
    // the cache window. The provider is re-queried on the next attempt, which is
    // the same trade the existing failure path already makes.
    if (payload.summary.recordCount < MIN_SELLABLE_RECORD_COUNT) {
      throw new EmptyProviderResponseError(vin, payload.summary.recordCount);
    }

    const cacheDays = await this.settings.getNumber('vinHistoryCacheDays');
    const expiresAt = new Date(Date.now() + cacheDays * 86_400_000);

    return this.prisma.vinHistoryReport.upsert({
      where: { vin_provider: { vin, provider: this.provider.name } },
      create: {
        vin,
        provider: this.provider.name,
        payload: payload as unknown as Prisma.InputJsonValue,
        recordCount: payload.summary.recordCount,
        expiresAt,
      },
      update: {
        payload: payload as unknown as Prisma.InputJsonValue,
        recordCount: payload.summary.recordCount,
        fetchedAt: new Date(),
        expiresAt,
      },
    });
  }

  /**
   * Archive one buyer's copy of the payload.
   *
   * The key carries the purchase id, so it is unique by construction and no
   * later buyer of the same VIN can overwrite it — that is the whole point. The
   * shared `VinHistoryReport` row is a provider cache and is expected to be
   * overwritten; the artefact a buyer paid for is not.
   *
   * Best-effort: an R2 outage must not turn a successful paid lookup into a
   * refund, so a failure here returns null and the purchase still completes
   * (the payload snapshot in the database is unaffected either way).
   *
   * GDPR: `MeService.erase` does NOT sweep this prefix, and deliberately so.
   * The object holds vehicle history and nothing about the buyer — the same
   * content the shared cache keeps for every other buyer of that VIN, which an
   * erasure has never removed either. The purchase row itself cascades with the
   * user, so the object is orphaned rather than exposed.
   */
  private async archive(
    vin: string,
    payload: VinHistoryPayloadV1,
    purchaseId: string,
  ): Promise<string | null> {
    if (!this.r2.isConfigured()) return null;
    const key = `vin-history/${this.provider.name}/${vin}/${purchaseId}.json`;
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

  /**
   * The payload this buyer was actually sold.
   *
   * The purchase's own snapshot wins. The shared report is consulted only as a
   * fallback for purchases fulfilled before the snapshot column existed — for
   * everyone else that row is a cache another buyer may already have refreshed.
   */
  private soldPayload(
    purchase: { payload: Prisma.JsonValue | null },
    report: { payload: Prisma.JsonValue } | null,
  ): VinHistoryPayloadV1 | null {
    const raw = purchase.payload ?? report?.payload ?? null;
    return raw ? (raw as unknown as VinHistoryPayloadV1) : null;
  }

  private toItem(
    purchase: VinHistoryPurchase,
    report: { expiresAt: Date; payload: Prisma.JsonValue } | null,
  ) {
    const payload = this.soldPayload(purchase, report);
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
