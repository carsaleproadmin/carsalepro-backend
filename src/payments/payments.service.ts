import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { OrderStatus, Prisma, Report } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PpvCheckoutResponseDto, ReportPurchaseListDto } from './dto/ppv-response.dto';
import {
  StripeCharge,
  StripeCheckoutSession,
  StripeEvent,
  StripePaymentIntent,
  StripeService,
} from './stripe.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly webOrigin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly settings: SettingsService,
    private readonly moduleRef: ModuleRef,
    config: ConfigService<AppConfig, true>,
  ) {
    this.webOrigin = config.get('web', { infer: true }).origin.replace(/\/$/, '');
  }

  /**
   * Start (or short-circuit) a pay-per-view purchase for a report by its code.
   * Returns `{ alreadyOwned }` if the user can already access it, otherwise a
   * Stripe Checkout URL — or, in mock mode, auto-completes and returns a URL.
   */
  async createPpvCheckout(userId: string, reportCode: string): Promise<PpvCheckoutResponseDto> {
    const report = await this.prisma.report.findFirst({
      where: { code: reportCode, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!report) {
      throw new NotFoundException({
        error: { code: 'not_found', message: `Report ${reportCode} not found` },
      });
    }

    const existingPurchase = await this.prisma.reportPurchase.findUnique({
      where: { userId_reportId: { userId, reportId: report.id } },
    });
    if (existingPurchase) {
      return { alreadyOwned: true };
    }

    const amountCents = await this.settings.getCents('payPerViewPriceEur');
    const payment = await this.prisma.payment.create({
      data: {
        purpose: 'ppv',
        userId,
        amountCents,
        status: 'pending',
      },
    });

    // Mock mode: no Stripe key — complete the purchase immediately so the flow
    // is fully testable without Stripe.
    if (!this.stripe.configured) {
      await this.fulfillPurchase(payment.id, report.id, userId);
      return {
        checkoutUrl: `${this.webOrigin}/account/reports?ppv=mock`,
        mock: true,
      };
    }

    const { checkoutUrl } = await this.stripe.createPpvCheckout({
      paymentId: payment.id,
      reportId: report.id,
      userId,
      reportCode: report.code,
      amountCents,
      successUrl: `${this.webOrigin}/account/reports?ppv=success`,
      cancelUrl: `${this.webOrigin}/report/${report.code}`,
    });

    const session = checkoutUrl.match(/cs_[A-Za-z0-9_]+/)?.[0];
    if (session) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripeCheckoutSessionId: session },
      });
    }

    return { checkoutUrl };
  }

  /**
   * Process a Stripe webhook event. Idempotent: a StripeWebhookEvent row guards
   * against replays. On `checkout.session.completed` for a PPV payment the
   * Payment is marked succeeded and the ReportPurchase is created.
   */
  async handleWebhook(event: StripeEvent): Promise<void> {
    const seen = await this.prisma.stripeWebhookEvent.findUnique({ where: { id: event.id } });
    if (seen) {
      this.logger.log(`Stripe event ${event.id} already processed — skipping`);
      return;
    }
    await this.prisma.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as StripeCheckoutSession;
        const meta = session.metadata ?? {};
        if (meta.purpose === 'ppv' && meta.paymentId && meta.reportId && meta.userId) {
          await this.fulfillPurchase(meta.paymentId, meta.reportId, meta.userId);
          this.logger.log(`PPV purchase fulfilled for payment ${meta.paymentId}`);
        } else if (meta.purpose === 'gold' && meta.paymentId && meta.listingId) {
          await this.activateGoldListing(meta.paymentId, meta.listingId);
          this.logger.log(`Gold listing ${meta.listingId} activated for payment ${meta.paymentId}`);
        }
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata ?? {};
        if (meta.purpose === 'order' && meta.orderId && meta.paymentId) {
          await this.settleOrderPayment(meta.paymentId, meta.orderId, meta.userId);
          this.logger.log(`Order ${meta.orderId} paid via payment ${meta.paymentId}`);
        }
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as StripeCharge;
        const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (piId) {
          const payment = await this.prisma.payment.findUnique({
            where: { stripePaymentIntentId: piId },
          });
          if (payment) {
            await this.markPaymentRefunded(payment.id);
            this.logger.log(`Payment ${payment.id} marked refunded (charge.refunded)`);
          }
        }
        break;
      }
      default:
        // Other event types are intentionally a no-op for now.
        break;
    }
  }

  /**
   * Idempotently settle an order payment: mark the Payment succeeded, transition
   * the order CREATED → PAID and run dispatch. Safe to call multiple times — the
   * transition is a no-op once the order has left CREATED. OrdersService is
   * resolved lazily (ModuleRef) to avoid a circular module dependency.
   */
  async settleOrderPayment(paymentId: string, orderId: string, _userId?: string): Promise<void> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'succeeded' } })
      .catch(() => undefined);

    const orders = await this.resolveOrdersService();
    if (!orders) return;
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.CREATED) return;
    await orders.transition(orderId, OrderStatus.PAID, 'system');
    await orders.dispatch(orderId);
  }

  /** Mark a Payment as refunded. Idempotent. */
  async markPaymentRefunded(paymentId: string): Promise<void> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'refunded' } })
      .catch(() => undefined);
  }

  /**
   * Lazily resolve OrdersService. Returns null if the orders module isn't loaded
   * (keeps PaymentsModule usable standalone, e.g. in narrow tests).
   */
  private async resolveOrdersService(): Promise<{
    transition: (orderId: string, to: OrderStatus, actor: string) => Promise<unknown>;
    dispatch: (orderId: string) => Promise<unknown>;
  } | null> {
    try {
      const { OrdersService } = await import('../orders/orders.service');
      return this.moduleRef.get(OrdersService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Idempotently mark a Gold payment succeeded and activate its listing
   * (ACTIVE, package 'gold', publishedAt now, expiresAt now + duration). Safe to
   * call from both the mock path and the Stripe webhook.
   */
  async activateGoldListing(paymentId: string, listingId: string): Promise<void> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'succeeded' } })
      .catch(() => undefined);

    const durationDays = await this.settings.getNumber('listingDurationDays');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 86_400_000);

    await this.prisma.listing
      .update({
        where: { id: listingId },
        data: {
          status: 'ACTIVE',
          package: 'gold',
          publishedAt: now,
          expiresAt,
        },
      })
      .catch(() => undefined);
  }

  /** List the reports a user has purchased (pay-per-view), newest first. */
  async listPurchases(userId: string): Promise<ReportPurchaseListDto> {
    const purchases = await this.prisma.reportPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const reportIds = purchases.map((p) => p.reportId);
    const reports = reportIds.length
      ? await this.prisma.report.findMany({ where: { id: { in: reportIds } } })
      : [];
    const byId = new Map(reports.map((r) => [r.id, r]));

    const items = purchases
      .map((p) => {
        const r = byId.get(p.reportId);
        if (!r) return null;
        return {
          reportId: r.id,
          code: r.code,
          vehicle: { make: r.make, model: r.model, year: r.year },
          purchasedAt: p.createdAt.toISOString(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items };
  }

  /**
   * Return the report only if the user may access it: as OWNER (report.userId
   * matches, or a DeviceLink connects the user to report.deviceId) or via a
   * ReportPurchase. Otherwise throw 402 payment_required.
   */
  async assertReportAccess(userId: string, reportId: string): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        error: { code: 'not_found', message: `Report ${reportId} not found` },
      });
    }

    if (report.userId === userId) return report;

    const link = await this.prisma.deviceLink.findFirst({
      where: { userId, deviceId: report.deviceId },
    });
    if (link) return report;

    const purchase = await this.prisma.reportPurchase.findUnique({
      where: { userId_reportId: { userId, reportId } },
    });
    if (purchase) return report;

    throw new ForbiddenException({
      error: { code: 'payment_required', message: 'Purchase required to access this report' },
    });
  }

  /**
   * Idempotently mark a payment succeeded and record the ReportPurchase. Safe to
   * call multiple times for the same (userId, reportId) — the @@unique guard
   * collapses duplicates.
   */
  private async fulfillPurchase(
    paymentId: string,
    reportId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'succeeded' } })
      .catch(() => undefined);

    try {
      await this.prisma.reportPurchase.create({
        data: { userId, reportId, paymentId },
      });
    } catch (err) {
      // P2002 = unique violation (already purchased). Idempotent no-op.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }
}
