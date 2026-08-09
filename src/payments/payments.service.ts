import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { OrderStatus, Payment, Prisma, Report, Role } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PpvCheckoutResponseDto, ReportPurchaseListDto } from './dto/ppv-response.dto';
import {
  StripeAccount,
  StripeCharge,
  StripeCheckoutSession,
  StripeEvent,
  StripePaymentIntent,
  StripeService,
  StripeTransfer,
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
    private readonly notifications: NotificationsService,
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
    // A revoked purchase is NOT ownership. `@@unique([userId, reportId])` makes
    // the row eternal, so treating its mere existence as "owned" meant a refund
    // permanently locked that buyer out of that report: access denied, and no
    // way to buy it again.
    if (existingPurchase && !existingPurchase.revokedAt) {
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
        amountCents,
        currency: 'EUR',
      };
    }

    const { checkoutUrl, sessionId } = await this.stripe.createPpvCheckout({
      paymentId: payment.id,
      reportId: report.id,
      userId,
      reportCode: report.code,
      amountCents,
      successUrl: `${this.webOrigin}/account/reports?ppv=success`,
      cancelUrl: `${this.webOrigin}/report/${report.code}`,
    });

    // Stripe hands us the session id; it used to be scraped out of the URL with
    // a regex whose failure was silent, leaving the payment with no session id
    // and reconciliation with nothing to ask Stripe about.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: sessionId },
    });

    return { checkoutUrl, amountCents, currency: 'EUR' };
  }

  /**
   * How long a claim may sit before another delivery is allowed to steal it. A
   * process that dies mid-handler would otherwise wedge the event for ever, and
   * Stripe would keep redelivering something nothing is allowed to run.
   */
  private static readonly WEBHOOK_CLAIM_STALE_MS = 5 * 60_000;

  /**
   * Process a Stripe webhook event exactly once — claim, handle, complete.
   *
   * The dedupe row used to be written only AFTER successful handling. That makes
   * a *replay* a no-op but does nothing about two deliveries of the SAME event
   * arriving at once: both found no row, and both ran the handler. For a
   * `payment_intent.succeeded` that is a double settlement; for a
   * `transfer.created`, a payout confirmed twice.
   *
   * So the row is now inserted FIRST, as a claim. The loser of the race finds it
   * and returns. On success the claim becomes `processed`; on an exception the
   * claim is DELETED, so Stripe's own retry can pick the event up again exactly
   * as before. Signature verification stays in the controller, ahead of all of
   * this.
   */
  async handleWebhook(event: StripeEvent): Promise<void> {
    const claimed = await this.claimWebhookEvent(event);
    if (!claimed) {
      this.logger.log(`Stripe event ${event.id} is already claimed or processed — skipping`);
      return;
    }

    try {
      await this.processWebhook(event);
    } catch (err) {
      // Release the claim so the redelivery is not swallowed by our own lock.
      await this.prisma.stripeWebhookEvent
        .deleteMany({ where: { id: event.id, status: 'claimed' } })
        .catch(() => undefined);
      throw err;
    }

    await this.prisma.stripeWebhookEvent
      .updateMany({
        where: { id: event.id },
        data: { status: 'processed', processedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /**
   * Take the exclusive right to handle this event. Returns false when another
   * delivery holds it or has already finished it.
   */
  private async claimWebhookEvent(event: StripeEvent): Promise<boolean> {
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          id: event.id,
          type: event.type,
          status: 'claimed',
          claimedAt: new Date(),
          attempts: 1,
        },
      });
      return true;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
    }

    // A row exists. Steal it only if it is a claim that has gone stale — a
    // `processed` row is final, and a fresh claim belongs to a live handler.
    const staleBefore = new Date(Date.now() - PaymentsService.WEBHOOK_CLAIM_STALE_MS);
    const stolen = await this.prisma.stripeWebhookEvent.updateMany({
      where: { id: event.id, status: 'claimed', claimedAt: { lt: staleBefore } },
      data: { claimedAt: new Date(), attempts: { increment: 1 } },
    });
    if (stolen.count > 0) {
      this.logger.warn(`Stripe event ${event.id}: stole a stale claim`);
      return true;
    }
    return false;
  }

  /** Dispatch a verified, not-yet-processed Stripe event to its handler. */
  private async processWebhook(event: StripeEvent): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as StripeCheckoutSession;
        const meta = session.metadata ?? {};
        // Capture the PaymentIntent before settling anything.
        //
        // A Checkout Session only reveals which PaymentIntent it captured once
        // it completes, and this is the single place we ever hear about it.
        // Without it `Payment.stripePaymentIntentId` stays null for every
        // Checkout-based purchase, and a later refund silently falls through to
        // the mock branch: the ledger records the money going back while
        // Stripe never returns it. It is also the only handle reconciliation
        // has for asking Stripe what became of a payment.
        if (meta.paymentId) {
          await this.recordPaymentIntent(meta.paymentId, session.payment_intent);
        }
        if (meta.purpose === 'ppv' && meta.paymentId && meta.reportId && meta.userId) {
          await this.fulfillPurchase(meta.paymentId, meta.reportId, meta.userId);
          this.logger.log(`PPV purchase fulfilled for payment ${meta.paymentId}`);
        } else if (meta.purpose === 'gold' && meta.paymentId && meta.listingId) {
          await this.activateGoldListing(meta.paymentId, meta.listingId);
          this.logger.log(`Gold listing ${meta.listingId} activated for payment ${meta.paymentId}`);
        } else if (
          meta.purpose === 'vin_history' &&
          meta.paymentId &&
          meta.purchaseId &&
          meta.vin
        ) {
          const vinHistory = await this.resolveVinHistoryService();
          if (vinHistory) {
            await vinHistory.fulfillFromWebhook(meta.paymentId, meta.purchaseId, meta.vin);
            this.logger.log(`VIN history purchase ${meta.purchaseId} settled`);
          } else {
            // Throwing leaves the event unrecorded, so Stripe redelivers it once
            // the module is up — better than silently keeping the money.
            throw new Error('VinHistoryService unavailable — cannot settle vin_history payment');
          }
        }
        break;
      }
      case 'payment_intent.amount_capturable_updated': {
        // Manual capture's "the hold is in place" event: the customer's card was
        // authorized and the funds are reserved, but NOTHING has been taken.
        // This is what starts the inspector search — `payment_intent.succeeded`
        // no longer fires at this point, and an installation that is not
        // subscribed to this event will authorize every order and leave it in
        // CREATED for ever.
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata ?? {};
        if (meta.purpose === 'order' && meta.orderId && meta.paymentId) {
          const orders = await this.resolveOrdersService();
          if (!orders) {
            // Throwing leaves the event unclaimed, so Stripe redelivers once the
            // module is up — better than a hold nobody is counting down.
            throw new Error('OrdersService unavailable — cannot authorize order payment');
          }
          await orders.authorizeOrderPayment(meta.paymentId, meta.orderId);
          this.logger.log(`Order ${meta.orderId} authorized (hold placed) — searching`);
        }
        break;
      }
      case 'payment_intent.succeeded': {
        // Under manual capture this now means "the capture we asked for went
        // through", and the work below is already done by
        // `OrdersService.captureOrderPayment`. The CREATED → PAID → dispatch
        // branch inside `settleOrderPayment` is KEPT deliberately: orders
        // created before manual capture shipped still carry automatic-capture
        // intents, and this is the only event that ever settles them.
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata ?? {};
        if (meta.purpose === 'order' && meta.orderId && meta.paymentId) {
          await this.settleOrderPayment(meta.paymentId, meta.orderId, meta.userId);
          this.logger.log(`Order ${meta.orderId} captured via payment ${meta.paymentId}`);
        }
        break;
      }
      case 'payment_intent.canceled': {
        // The hold is gone: released by us, cancelled in the dashboard, or
        // expired at Stripe (an uncaptured authorization dies after 7 days).
        // Either way the customer's money is free and the order cannot proceed.
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata ?? {};
        if (meta.purpose === 'order' && meta.paymentId) {
          await this.cancelOrderPayment(meta.paymentId, meta.orderId);
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        // The card was refused. The order stays CREATED on purpose — the same
        // PaymentIntent is still payable with another card, and cancelling here
        // would destroy an order the customer is one retry away from placing.
        const pi = event.data.object as StripePaymentIntent;
        const meta = pi.metadata ?? {};
        if (meta.purpose === 'order' && meta.paymentId) {
          await this.prisma.payment
            .updateMany({
              where: { id: meta.paymentId, status: { in: ['pending', 'failed'] } },
              data: { status: 'failed' },
            })
            .catch(() => undefined);
          this.logger.warn(`Order payment ${meta.paymentId} failed — order left CREATED`);
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
      case 'account.updated': {
        // Connect account onboarding progressed → recompute the inspector's flag.
        const acct = event.data.object as StripeAccount;
        const accountId = acct.id ?? (typeof event.account === 'string' ? event.account : null);
        if (accountId) {
          await this.syncConnectedAccount(accountId, acct);
        }
        break;
      }
      case 'transfer.created': {
        // Confirm the payout is paid (idempotent no-op if already recorded).
        await this.confirmTransfer(event.data.object as StripeTransfer);
        break;
      }
      case 'charge.dispute.created': {
        // A customer filed a chargeback → flag the order so an admin (E9) handles it.
        const dispute = event.data.object as { payment_intent?: string | { id: string } | null };
        const piId =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : (dispute.payment_intent?.id ?? null);
        if (piId) {
          await this.flagChargeback(piId);
        }
        break;
      }
      default:
        // `transfer.failed` (and the API-typed `transfer.reversed`) signal a payout
        // that did not land → mark the Payout failed. Matched on the raw string so
        // we stay compatible across Stripe API event-union versions.
        if ((event.type as string) === 'transfer.failed' || event.type === 'transfer.reversed') {
          await this.failTransfer(event.data.object as StripeTransfer);
        }
        // All other event types are intentionally a no-op.
        break;
    }
  }

  /**
   * The money has been TAKEN. Mark the Payment succeeded and, if the order has
   * not moved yet, take it CREATED → PAID and dispatch. Safe to call repeatedly
   * — the transition is a no-op once the order has left CREATED. OrdersService
   * is resolved lazily (ModuleRef) to avoid a circular module dependency.
   *
   * Under manual capture the normal caller of the CREATED → PAID branch is
   * `OrdersService.authorizeOrderPayment`, not this method: capture happens at
   * ACCEPTANCE, by which time the order is long past CREATED. The branch stays
   * because pre-deploy orders hold automatic-capture intents whose only
   * settlement signal is `payment_intent.succeeded`, and dropping it would
   * strand every one of them in CREATED.
   *
   * It deliberately does NOT open a search window. Money that is already
   * captured has no hold to release, and `expireUnfilledSearches` skips a null
   * `searchExpiresAt` precisely so those orders are left alone.
   */
  async settleOrderPayment(paymentId: string, orderId: string, _userId?: string): Promise<void> {
    await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'succeeded' } })
      .catch(() => undefined);
    // Written once and never moved: `capturedAt` is the only thing that tells an
    // old charge apart from a fresh capture, and the reconciler reads it.
    await this.prisma.payment
      .updateMany({ where: { id: paymentId, capturedAt: null }, data: { capturedAt: new Date() } })
      .catch(() => undefined);

    const orders = await this.resolveOrdersService();
    if (!orders) return;
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.CREATED) return;
    await orders.transition(orderId, OrderStatus.PAID, 'system');
    await orders.dispatch(orderId);
  }

  /**
   * A hold on an order payment is gone. Record it and, if the order is still
   * waiting, cancel it — there is no money behind it any more.
   *
   * Guarded on the uncaptured statuses: a `payment_intent.canceled` that
   * arrives for a payment we have already CAPTURED would otherwise rewrite a
   * live charge as released, and the order would be cancelled out from under an
   * inspector who is on site.
   */
  async cancelOrderPayment(paymentId: string, orderId?: string): Promise<void> {
    const updated = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: { in: ['pending', 'authorized', 'failed'] } },
      data: { status: 'cancelled', canceledAt: new Date() },
    });
    if (updated.count === 0) return;

    if (!orderId) return;
    const orders = await this.resolveOrdersService();
    if (!orders) return;
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.PAID &&
      order.status !== OrderStatus.UNASSIGNED
    ) {
      // Past assignment the money question is an operator's, not a webhook's.
      this.logger.error(
        `payment_intent.canceled on order ${orderId} in status ${order.status} — needs an operator`,
      );
      return;
    }
    await orders.transition(orderId, OrderStatus.CANCELLED, 'system');
    this.logger.warn(`Order ${orderId} cancelled — its authorization hold is gone`);
  }

  /**
   * Attach the captured PaymentIntent to a Payment. Idempotent.
   *
   * `updateMany` guarded on a null column rather than `update`: the column is
   * unique, and a redelivered webhook carries the same `pi_` — a blind write
   * would trip the unique constraint on the second delivery and abort settling
   * a purchase that is otherwise fine. Guarding on null also means a value we
   * already hold is never overwritten by a later event for the same session.
   */
  private async recordPaymentIntent(
    paymentId: string,
    paymentIntent: StripeCheckoutSession['payment_intent'],
  ): Promise<void> {
    // Null for a zero-amount session, and an expanded object if anyone ever
    // adds `expand` to the session create call.
    const piId =
      typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null);
    if (!piId) return;
    await this.prisma.payment.updateMany({
      where: { id: paymentId, stripePaymentIntentId: null },
      data: { stripePaymentIntentId: piId },
    });
  }

  /**
   * Mark a Payment as refunded AND withdraw whatever it bought. Idempotent.
   *
   * The two halves are one operation: money back, access gone. Marking only the
   * payment left a refunded buyer holding a permanent entitlement to the report
   * or VIN history they no longer paid for.
   */
  async markPaymentRefunded(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment
      .update({ where: { id: paymentId }, data: { status: 'refunded' } })
      .catch(() => null);
    if (!payment) return;
    await this.revokeEntitlementsFor(payment);
  }

  /**
   * Withdraw the access a payment granted. Idempotent, and a no-op for payments
   * that grant none (an order payment buys an inspection, not a document).
   *
   * A `ReportPurchase` is revoked in place rather than deleted:
   * `@@unique([userId, reportId])` means the row is the buyer's entire history
   * with that report, and deleting it would erase the record of a sale that did
   * happen. `revokedAt` is therefore read by BOTH access paths —
   * `assertReportAccess` denies it, and `createPpvCheckout` lets the same buyer
   * purchase again.
   */
  async revokeEntitlementsFor(payment: Pick<Payment, 'id'>): Promise<void> {
    const [vinChecks, reportPurchases] = await Promise.all([
      // `status: 'ready'` ONLY. Revocation withdraws access, and a purchase that
      // never reached `ready` never granted any — so there is nothing to take
      // away, and moving it to `refunded` does two kinds of damage. It destroys
      // `failureReason`, which is the only record of WHY the provider failed;
      // and it asserts "this buyer's money went back" on a row whose refund may
      // itself have failed, which is precisely the case the ledger must not lie
      // about. A failed purchase stays `failed`; the money is tracked on the
      // Payment and the Refund, where it belongs.
      this.prisma.vinHistoryPurchase.updateMany({
        where: { paymentId: payment.id, status: 'ready' },
        data: { status: 'refunded', failureReason: 'payment_refunded' },
      }),
      this.prisma.reportPurchase.updateMany({
        where: { paymentId: payment.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'payment_refunded' },
      }),
    ]);

    if (vinChecks.count > 0 || reportPurchases.count > 0) {
      this.logger.log(
        `Payment ${payment.id} refunded — revoked ${reportPurchases.count} report purchase(s) ` +
          `and ${vinChecks.count} VIN check(s)`,
      );
    }
  }

  /**
   * Recompute an inspector's `stripeOnboarded` flag from a connected account.
   * Onboarded = (charges_enabled OR payouts_enabled) AND details_submitted.
   * Idempotent: looks the profile up by stripeAccountId; no-op if unknown.
   */
  async syncConnectedAccount(
    accountId: string,
    acct?: StripeAccount,
  ): Promise<void> {
    const profile = await this.prisma.inspectorProfile.findUnique({
      where: { stripeAccountId: accountId },
    });
    if (!profile) return;

    const account = acct ?? (await this.stripe.retrieveAccount(accountId));
    const onboarded =
      (account.charges_enabled === true || account.payouts_enabled === true) &&
      account.details_submitted === true;

    if (profile.stripeOnboarded === onboarded) return; // idempotent
    await this.prisma.inspectorProfile.update({
      where: { stripeAccountId: accountId },
      data: { stripeOnboarded: onboarded },
    });
    this.logger.log(
      `Inspector ${profile.userId} stripeOnboarded → ${onboarded} (account.updated)`,
    );
  }

  /** Confirm a transfer landed → mark its Payout 'paid'. Idempotent. */
  async confirmTransfer(transfer: StripeTransfer): Promise<void> {
    const payout = await this.prisma.payout.findUnique({
      where: { stripeTransferId: transfer.id },
    });
    if (payout && payout.status !== 'paid') {
      await this.prisma.payout
        .update({ where: { id: payout.id }, data: { status: 'paid' } })
        .catch(() => undefined);
    }
  }

  /**
   * Stripe told us a transfer failed or was reversed AFTER we recorded it as
   * paid. Put the payout back in the retry queue rather than leaving it in a
   * terminal 'failed' state nothing ever revisits, and alert operators — money
   * is owed and it is no longer moving.
   */
  async failTransfer(transfer: StripeTransfer): Promise<void> {
    const payout = await this.prisma.payout.findUnique({
      where: { stripeTransferId: transfer.id },
      include: { order: { select: { id: true, number: true, inspectorId: true } } },
    });
    if (!payout) return;

    const reason = 'stripe reported the transfer failed or was reversed';
    this.logger.warn(`Payout ${payout.id} failed (transfer failed/reversed)`);

    // Delegate: the attempt counter, the backoff schedule, the cap and the
    // operator alert all live in OrdersService.parkPayout. The bare
    // `attempts: { increment: 1 }` this replaced could push a payout PAST the
    // cap, and the retry cron filters on `attempts < cap` — so the row then sat
    // there claiming a nextRetryAt that nothing would ever act on.
    const orders = await this.resolveOrdersService();
    if (orders) {
      await orders.parkPayoutForFailedTransfer(payout.orderId, reason);
      return;
    }

    // OrdersService unavailable (a narrow test graph): make the payout terminal
    // and visible rather than leaving it looking healthy.
    await this.prisma.payout
      .update({
        where: { id: payout.id },
        data: {
          status: 'failed',
          stripeTransferId: null, // freed so a retry can record its own transfer
          lastError: reason,
          lastAttemptAt: new Date(),
          nextRetryAt: null,
        },
      })
      .catch(() => undefined);
    await this.alertAdmins('payout.failed', {
      orderId: payout.orderId,
      orderNumber: payout.order.number,
      amountCents: payout.amountCents,
      reason,
      attempts: payout.attempts,
      terminal: true,
    });
  }

  /** Fan a notification out to every active admin. Never throws. */
  private async alertAdmins(
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify(admin.id, type, payload);
    }
  }

  /**
   * Flag an order as charged-back. Records an OrderEvent of type 'chargeback'
   * against the order behind the disputed PaymentIntent. Admin handling is E9.
   * Idempotent: writing a second event is harmless (events are append-only).
   */
  async flagChargeback(paymentIntentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (!payment?.orderId) {
      this.logger.warn(`charge.dispute.created: no order for PI ${paymentIntentId}`);
      return;
    }
    await this.prisma.orderEvent.create({
      data: {
        orderId: payment.orderId,
        actor: 'system',
        type: 'chargeback',
        payload: { paymentIntentId },
      },
    });
    this.logger.warn(`Chargeback flagged on order ${payment.orderId} (PI ${paymentIntentId})`);
  }

  /**
   * Lazily resolve OrdersService. Returns null if the orders module isn't loaded
   * (keeps PaymentsModule usable standalone, e.g. in narrow tests).
   */
  private async resolveOrdersService(): Promise<{
    transition: (orderId: string, to: OrderStatus, actor: string) => Promise<unknown>;
    dispatch: (orderId: string) => Promise<unknown>;
    parkPayoutForFailedTransfer: (orderId: string, reason: string) => Promise<void>;
    authorizeOrderPayment: (paymentId: string, orderId: string) => Promise<void>;
  } | null> {
    try {
      const { OrdersService } = await import('../orders/orders.service');
      return this.moduleRef.get(OrdersService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Lazily resolve VinHistoryService. Same pattern as OrdersService above:
   * VinHistoryModule imports PaymentsModule for StripeService, so importing it
   * back here would be a cycle. Returns null when the module is not loaded.
   */
  private async resolveVinHistoryService(): Promise<{
    fulfillFromWebhook: (paymentId: string, purchaseId: string, vin: string) => Promise<void>;
  } | null> {
    try {
      const { VinHistoryService } = await import('../vin-history/vin-history.service');
      return this.moduleRef.get(VinHistoryService, { strict: false });
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

    const listing = await this.prisma.listing
      .update({
        where: { id: listingId },
        data: {
          status: 'ACTIVE',
          package: 'gold',
          publishedAt: now,
          expiresAt,
        },
      })
      .catch(() => null);

    // E11: notify the seller their Gold listing is live (non-throwing).
    // Reads the listing's own denormalised columns — `report` is null for a
    // manual listing, and Gold is sold to both provenances.
    if (listing) {
      await this.notifications.notify(listing.sellerId, 'listing.published', {
        listingId: listing.id,
        make: listing.make,
        model: listing.model,
      });
    }
  }

  /** List the reports a user has purchased (pay-per-view), newest first. */
  async listPurchases(userId: string): Promise<ReportPurchaseListDto> {
    const purchases = await this.prisma.reportPurchase.findMany({
      // A revoked purchase was refunded: it is history, not a holding.
      where: { userId, revokedAt: null },
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
    if (purchase && !purchase.revokedAt) return report;

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
      // P2002 = unique violation: this buyer already has a row for this report.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      // If that row was REVOKED, this is a re-purchase after a refund and the
      // entitlement has to come back — the unique constraint means there will
      // never be a second row to carry it. Anything else is a plain replay.
      const revived = await this.prisma.reportPurchase.updateMany({
        where: { userId, reportId, revokedAt: { not: null } },
        data: { revokedAt: null, revokedReason: null, paymentId },
      });
      if (revived.count === 0) return;
    }

    // E11: notify the buyer their PPV report is unlocked (only on a fresh
    // purchase — the idempotent replay above returns before reaching here).
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    const amountCents = await this.prisma.payment
      .findUnique({ where: { id: paymentId }, select: { amountCents: true } })
      .then((p) => p?.amountCents ?? 0);
    await this.notifications.notify(userId, 'ppv.purchased', {
      reportId,
      reportCode: report?.code,
      amountCents,
    });
  }
}
