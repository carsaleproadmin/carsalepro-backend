import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
// The published CJS entry only re-exports the constructor, not the resource
// type namespace (Event, Checkout, …). Pull those types from the CJS core
// declaration (matches the CJS runtime value) and re-export them so the rest
// of the app depends only on these aliases — not on Stripe's internal layout.
import type { Stripe as StripeNamespace } from 'stripe/cjs/stripe.core.js';
import { AppConfig } from '../config/configuration';

export type StripeEvent = StripeNamespace.Event;
export type StripeCheckoutSession = StripeNamespace.Checkout.Session;
export type StripePaymentIntent = StripeNamespace.PaymentIntent;
export type StripeRefund = StripeNamespace.Refund;
export type StripeCharge = StripeNamespace.Charge;
export type StripeAccount = StripeNamespace.Account;
export type StripeAccountLink = StripeNamespace.AccountLink;
export type StripeTransfer = StripeNamespace.Transfer;

/**
 * Stripe's `business_type` enum, taken from the SDK rather than retyped, so the
 * day Stripe adds a fifth kind of business the compiler is the one that says so.
 */
export type StripeBusinessType = StripeNamespace.AccountCreateParams.BusinessType;

/**
 * The same four values at runtime — a DTO needs a list to validate against and a
 * type is erased. `satisfies` keeps the list and the SDK type from drifting
 * apart: a typo, or a value Stripe removed, fails to compile.
 *
 * All four are offered, not just the obvious two. A driving school run as a
 * non-profit association and a municipal fleet workshop are both plausible
 * inspectors, and neither is an individual or a company.
 */
export const STRIPE_BUSINESS_TYPES = [
  'individual',
  'company',
  'non_profit',
  'government_entity',
] as const satisfies readonly StripeBusinessType[];

export function isStripeBusinessType(value: unknown): value is StripeBusinessType {
  return typeof value === 'string' && (STRIPE_BUSINESS_TYPES as readonly string[]).includes(value);
}

export interface CreateOrderPaymentIntentParams {
  amountCents: number;
  orderId: string;
  paymentId: string;
  userId: string;
}

export interface CreatePpvCheckoutParams {
  paymentId: string;
  reportId: string;
  userId: string;
  reportCode: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateGoldCheckoutParams {
  paymentId: string;
  listingId: string;
  userId: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateVinHistoryCheckoutParams {
  paymentId: string;
  purchaseId: string;
  userId: string;
  vin: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}

/**
 * The verdict on a failed Stripe call. `retryable` is the only field callers
 * are allowed to branch a retry on; `code` and `message` are for mapping to an
 * HTTP contract and for logs.
 */
export interface StripeFailure {
  retryable: boolean;
  code: string;
  message: string;
}

/**
 * Stripe error codes that describe a state no retry can change. Checked BEFORE
 * the transport-level classification, so a mis-set 5xx status on an
 * `invalid_request_error` cannot turn a permanent failure into an infinite
 * retry loop.
 */
const FATAL_STRIPE_CODES = new Set([
  'resource_missing',
  'payment_intent_unexpected_state',
  'charge_expired_for_capture',
  'card_declined',
]);

/**
 * Classify a thrown Stripe error once, in one place, so every call site agrees
 * on what may be retried.
 *
 * Retryable: `StripeConnectionError`, `StripeAPIError`, a rate limit, and any
 * HTTP 5xx from Stripe — transient conditions where the same request can
 * succeed unchanged.
 *
 * Everything else, INCLUDING anything unrecognised, is fatal. Defaulting an
 * unknown error to "retryable" would mean retrying money movement forever
 * against a condition nobody has understood; defaulting to fatal surfaces it
 * instead.
 */
export function classifyStripeError(err: unknown): StripeFailure {
  const e = (err ?? {}) as {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
    raw?: { type?: unknown; code?: unknown };
  };
  const type = typeof e.type === 'string' ? e.type : undefined;
  const rawType = typeof e.raw?.type === 'string' ? e.raw.type : undefined;
  const code =
    typeof e.code === 'string'
      ? e.code
      : typeof e.raw?.code === 'string'
        ? e.raw.code
        : undefined;
  const statusCode = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const message =
    typeof e.message === 'string' && e.message.length > 0 ? e.message : 'Stripe request failed';

  if (code && FATAL_STRIPE_CODES.has(code)) {
    return { retryable: false, code, message };
  }
  if (type === 'StripeCardError' || rawType === 'card_error') {
    return { retryable: false, code: code ?? 'card_error', message };
  }

  if (type === 'StripeRateLimitError' || rawType === 'rate_limit_error' || statusCode === 429) {
    return { retryable: true, code: code ?? 'rate_limit', message };
  }
  if (type === 'StripeConnectionError') {
    return { retryable: true, code: code ?? 'connection_error', message };
  }
  if (type === 'StripeAPIError' || (statusCode !== undefined && statusCode >= 500)) {
    return { retryable: true, code: code ?? 'api_error', message };
  }

  return { retryable: false, code: code ?? type ?? 'unknown_error', message };
}

/**
 * Map our refund/release reason keys onto Stripe's closed `cancellation_reason`
 * enum ('duplicate' | 'fraudulent' | 'requested_by_customer' | 'abandoned').
 *
 * Anything the customer or an operator asked for is `requested_by_customer`;
 * everything else — nobody accepted in time, a capture we could not complete —
 * is `abandoned`. Sending an unrecognised value is a 400 from Stripe, which
 * would turn a routine hold release into a fatal error.
 */
export function stripeCancellationReason(
  reason?: string,
): 'requested_by_customer' | 'abandoned' {
  switch (reason) {
    case 'cancel_before_assign':
    case 'cancel_after_assign':
    case 'dispute':
    case 'admin':
      return 'requested_by_customer';
    default:
      return 'abandoned';
  }
}

export interface CreateTransferParams {
  amountCents: number;
  destinationAccountId: string;
  /** The source charge id so the transfer draws from that specific charge. */
  sourceChargeId: string;
  transferGroup: string;
  /**
   * Stable across retries of the SAME payout — derive it from the payout row,
   * never from an attempt counter or a timestamp. A key that changes per attempt
   * makes two racing releases two separate transfers, which is the whole thing
   * it is here to prevent.
   */
  idempotencyKey: string;
}

/**
 * Thin wrapper around the Stripe SDK. When STRIPE_SECRET_KEY is empty the
 * service runs in "mock mode" (`configured = false`) — the rest of the app
 * skips Stripe and resolves payments locally so the flow is fully testable
 * without Stripe credentials (NODE_ENV=test).
 */
@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private client?: Stripe.Stripe;
  private webhookSecret = '';

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const stripe = this.config.get('stripe', { infer: true });
    this.webhookSecret = stripe.webhookSecret;
    // Force mock mode under tests so e2e is deterministic and offline even when
    // a real key is present in the environment.
    if (!stripe.secretKey || process.env.NODE_ENV === 'test') {
      this.logger.warn('Stripe runs in mock mode (no key or NODE_ENV=test)');
      return;
    }
    this.client = new Stripe(stripe.secretKey);
    this.logger.log('Stripe client ready');
  }

  /** True only when a real Stripe secret key was provided. */
  get configured(): boolean {
    return this.client !== undefined;
  }

  private requireClient(): Stripe.Stripe {
    if (!this.client) throw new Error('Stripe is not configured');
    return this.client;
  }

  /**
   * One Checkout Session per payment, however many times we ask for it.
   *
   * Every `sessions.create` call opens a NEW payable page. Two tabs, a
   * double-click or a retried request therefore used to hand the same buyer two
   * live payment pages for one `Payment` row — and Stripe would happily capture
   * both, leaving the second charge with no row in our ledger at all.
   *
   * The idempotency key is the payment id, so Stripe itself collapses repeats:
   * for 24 hours it replays the ORIGINAL session object instead of creating a
   * second one. That window matches the Checkout Session's own 24-hour
   * lifetime, so there is no gap where the key has expired but the session is
   * still payable.
   *
   * Deliberately not `retrieve`-then-reuse: that needs a stored session id, an
   * extra round-trip and a status check, and still races with itself between
   * the read and the create. This is one call and no state of ours.
   */
  private idempotently(paymentId: string): { idempotencyKey: string } {
    return { idempotencyKey: `checkout_${paymentId}` };
  }

  /** Create a one-time payment Checkout Session for a pay-per-view report. */
  async createPpvCheckout(
    params: CreatePpvCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const session = await this.requireClient().checkout.sessions.create(
      {
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: params.amountCents,
              product_data: { name: `CarSalePro report ${params.reportCode}` },
            },
          },
        ],
        metadata: {
          paymentId: params.paymentId,
          reportId: params.reportId,
          userId: params.userId,
          purpose: 'ppv',
        },
      },
      this.idempotently(params.paymentId),
    );
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  /** Create a one-time payment Checkout Session for a Gold listing upgrade. */
  async createGoldCheckout(
    params: CreateGoldCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const session = await this.requireClient().checkout.sessions.create(
      {
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: params.amountCents,
              product_data: { name: 'CarSalePro Gold listing' },
            },
          },
        ],
        metadata: {
          paymentId: params.paymentId,
          listingId: params.listingId,
          userId: params.userId,
          purpose: 'gold',
        },
      },
      this.idempotently(params.paymentId),
    );
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  /**
   * Create a one-time payment Checkout Session for a paid VIN history.
   *
   * `purchaseId` rides in the metadata alongside `paymentId` so the webhook can
   * settle the exact purchase row rather than re-deriving it from (user, VIN) —
   * a retry after the user started a second unlock would otherwise settle the
   * wrong one.
   */
  async createVinHistoryCheckout(
    params: CreateVinHistoryCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const session = await this.requireClient().checkout.sessions.create(
      {
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: params.amountCents,
              product_data: { name: `CarSalePro VIN history ${params.vin}` },
            },
          },
        ],
        metadata: {
          paymentId: params.paymentId,
          purchaseId: params.purchaseId,
          userId: params.userId,
          vin: params.vin,
          purpose: 'vin_history',
        },
      },
      this.idempotently(params.paymentId),
    );
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  /**
   * Create a PaymentIntent for an inspection order. Automatic payment methods
   * are enabled; the order/payment ids ride along in metadata so the webhooks
   * can settle the order.
   *
   * **`capture_method: 'manual'`** is the whole ride-hailing model in one line.
   * Confirming the intent places a HOLD on the customer's card; the funds are
   * only taken by {@link capturePaymentIntent}, which runs when an inspector
   * actually accepts the job. Before this, the card was charged the instant the
   * order was created — before anyone had agreed to do the work — so an order
   * nobody accepted left the platform holding real money it owed back.
   *
   * The consequence to design around: an uncaptured authorization expires at
   * Stripe after 7 days, which is why `orderSearchWindowMinutes` exists and why
   * `expireUnfilledSearches` must release the hold long before that.
   *
   * The event that says "the hold is in place" is
   * `payment_intent.amount_capturable_updated`, NOT `payment_intent.succeeded` —
   * the latter now means "capture confirmed".
   */
  async createOrderPaymentIntent(
    params: CreateOrderPaymentIntentParams,
  ): Promise<StripePaymentIntent> {
    return this.requireClient().paymentIntents.create({
      amount: params.amountCents,
      currency: 'eur',
      capture_method: 'manual',
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: params.orderId,
        paymentId: params.paymentId,
        userId: params.userId,
        purpose: 'order',
      },
    });
  }

  /**
   * Take the money that is being held. Called exactly once per order, at the
   * moment an inspector accepts — never before.
   *
   * The idempotency key is derived from the payment id, so a retried request
   * (a dropped response, two clicks on Accept) replays Stripe's original answer
   * for 24 hours instead of raising `payment_intent_unexpected_state`. That
   * matters more here than anywhere else in the money path, because the caller
   * reacts to a FATAL capture failure by cancelling the order and releasing the
   * hold: a "failure" that was really a duplicate of a successful capture would
   * cancel an order whose money we had already taken.
   *
   * The key is not a complete answer — it expires after 24 hours and our own
   * reconciler may retry later — so callers must still tolerate the raced case.
   * `OrdersService.captureOrderPayment` does, by re-reading the intent whenever
   * Stripe reports an unexpected state.
   *
   * `amountCents` captures LESS than was authorized and releases the remainder.
   * Unused today: the fare is frozen at quote time.
   */
  async capturePaymentIntent(
    paymentIntentId: string,
    paymentId: string,
    amountCents?: number,
  ): Promise<StripePaymentIntent> {
    return this.requireClient().paymentIntents.capture(
      paymentIntentId,
      amountCents === undefined ? {} : { amount_to_capture: amountCents },
      { idempotencyKey: `capture_${paymentId}` },
    );
  }

  /**
   * Release an authorization hold without taking anything — nobody accepted the
   * job, or the customer cancelled before assignment.
   *
   * This is NOT a refund and must never be recorded as one: the money never
   * left the customer's account, so a Refund row would double-count every
   * hold-and-release in the finance ledger (see `OrdersService.settleRefund`).
   *
   * A CAPTURED intent cannot be cancelled — Stripe answers
   * `payment_intent_unexpected_state`, which `classifyStripeError` treats as
   * fatal. That is the right outcome: money that has been taken has to be
   * refunded, not un-held.
   *
   * `reason` is OUR reason key ('cancel_before_assign', 'search_expired', …).
   * Stripe's `cancellation_reason` is a closed four-value enum and rejects
   * anything outside it, so the key is mapped onto that enum for the dashboard
   * and recorded verbatim in the order's own `authorization_released` event,
   * which is where anyone actually looks.
   */
  async cancelPaymentIntent(
    paymentIntentId: string,
    paymentId: string,
    reason?: string,
  ): Promise<StripePaymentIntent> {
    return this.requireClient().paymentIntents.cancel(
      paymentIntentId,
      { cancellation_reason: stripeCancellationReason(reason) },
      { idempotencyKey: `cancel_${paymentId}` },
    );
  }

  /**
   * Refund (full or partial) a captured PaymentIntent.
   *
   * `idempotencyKey` is REQUIRED, and it must be derived from the ledger row —
   * not from the attempt, and not generated here. The caller's "has this already
   * settled?" test is a database READ, so two callers racing (an operator
   * double-clicking Retry in the admin refund queue, or a retry cron overlapping
   * a manual retry) both pass it and both arrive here. Without a key Stripe
   * happily performs both, and for a partial refund the customer receives twice
   * the percentage; the ledger keeps one row, because `(orderId, reason)` is
   * unique, so the second refund exists only at Stripe.
   */
  async createRefund(
    paymentIntentId: string,
    amountCents: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<StripeRefund> {
    return this.requireClient().refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountCents,
        metadata: { reason },
      },
      { idempotencyKey },
    );
  }

  // ============================================================
  // Connect Express (E7)
  // ============================================================

  /**
   * Create an Express connected account for an inspector. `transfers` is the
   * only requested capability — the platform charges the customer and transfers
   * the inspector's share via separate charges-and-transfers.
   *
   * `country` and `businessType` are PARAMETERS, and until 2026-08-19 they were
   * the literals `'DE'` and `'individual'`. That pair excluded every company and
   * every inspector outside Germany from the platform, silently: Express
   * onboarding does not offer the company form to an account that already
   * declares itself a natural person, so the applicant simply could not describe
   * their own business.
   *
   * `businessType` is OMITTED when null rather than defaulted. An absent
   * `business_type` is what makes Express ask the question itself, which is the
   * only answer that is right for every applicant. Sending a guess produces an
   * onboarding form that cannot be completed truthfully.
   *
   * Note what cannot be undone here: Stripe fixes the account's COUNTRY at
   * creation and has no API to change it. `resolveConnectAccountParams` owns
   * that rule; this method is the one place the value is spent.
   */
  async createConnectedAccount(params: {
    email: string;
    country: string;
    businessType?: StripeBusinessType | null;
  }): Promise<StripeAccount> {
    return this.requireClient().accounts.create({
      type: 'express',
      country: params.country,
      email: params.email,
      capabilities: { transfers: { requested: true } },
      ...(params.businessType ? { business_type: params.businessType } : {}),
    });
  }

  /**
   * Change an existing connected account's `business_type`.
   *
   * Stripe accepts this while the account is still unverified and refuses it
   * afterwards, which is the correct shape for the product: an inspector who
   * ticked "individual" and then registered a company can fix it themselves
   * until the point where the declaration has been checked, and after that it is
   * a support matter rather than a silent overwrite of a verified fact.
   */
  async updateConnectedAccountBusinessType(
    accountId: string,
    businessType: StripeBusinessType,
  ): Promise<StripeAccount> {
    return this.requireClient().accounts.update(accountId, { business_type: businessType });
  }

  /** Create an onboarding account link the inspector follows to finish KYC. */
  async createAccountLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string,
  ): Promise<StripeAccountLink> {
    return this.requireClient().accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
  }

  /** Retrieve a connected account (charges_enabled / payouts_enabled / details_submitted). */
  async retrieveAccount(accountId: string): Promise<StripeAccount> {
    return this.requireClient().accounts.retrieve(accountId);
  }

  /** Retrieve a PaymentIntent (used to read `latest_charge` for transfers). */
  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
    return this.requireClient().paymentIntents.retrieve(paymentIntentId);
  }

  /**
   * Transfer the inspector's share to their connected account. Uses
   * `source_transaction` = the originating charge id so the transfer draws from
   * that specific charge (separate charges-and-transfers) — this avoids
   * test-mode available-balance issues.
   */
  async createTransfer(params: CreateTransferParams): Promise<StripeTransfer> {
    return this.requireClient().transfers.create(
      {
        amount: params.amountCents,
        currency: 'eur',
        destination: params.destinationAccountId,
        source_transaction: params.sourceChargeId,
        transfer_group: params.transferGroup,
      },
      // Keyed on the payout row, so two concurrent releases of the same payout
      // pay the inspector once. The guard in `releasePayout` is a read, and it
      // was deliberately relaxed from "a row exists" to "a row is already PAID"
      // so a parked payout could be retried — which is right, and which is
      // exactly what opened the window. Worse than the refund case, because
      // `markPayoutPaid` reports an already-paid row as success and discards the
      // second transfer id, so a double payout leaves no trace in our ledger.
      { idempotencyKey: params.idempotencyKey },
    );
  }

  /** Verify and parse a Stripe webhook payload from its raw body + signature. */
  constructWebhookEvent(rawBody: Buffer | string, signature: string): StripeEvent {
    return this.requireClient().webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
