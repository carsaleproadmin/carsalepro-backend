import { randomUUID } from 'node:crypto';
import type {
  CreateGoldCheckoutParams,
  CreateOrderPaymentIntentParams,
  CreatePpvCheckoutParams,
  CreateTransferParams,
  CreateVinHistoryCheckoutParams,
  StripeAccount,
  StripeAccountLink,
  StripeEvent,
  StripePaymentIntent,
  StripeRefund,
  StripeTransfer,
} from '../../src/payments/stripe.service';

/**
 * An in-memory stand-in for {@link StripeService} that reports itself as
 * CONFIGURED.
 *
 * ## Why this exists
 *
 * `StripeService.onModuleInit` forces mock mode whenever `NODE_ENV === 'test'`
 * (`stripe.service.ts:83`), so every `if (this.stripe.configured)` branch in
 * `createOrder`, `releasePayout`, `refundOrder` and the whole Connect path was
 * unreachable from the e2e suite — 302 e2e cases and not one of them ever
 * executed a line of Stripe-facing code. Manual capture, refund parking and the
 * Connect self-heal all live in exactly those branches, so without this harness
 * they would ship untested.
 *
 * Swap it in with the override hook `createTestApp` already exposes:
 *
 * ```ts
 * const stripe = new FakeStripeService();
 * app = await createTestApp([{ token: StripeService, useValue: stripe }]);
 * ```
 *
 * ## What it models
 *
 * A PaymentIntent's real lifecycle, because that is what manual capture turns
 * into a state machine we depend on:
 *
 * ```
 *                      confirm()                capture()
 *  requires_payment_method ──► requires_capture ──► succeeded
 *      │                            │                  │
 *      │ cancel()                   │ cancel()         │ refund()
 *      ▼                            ▼                  ▼
 *   canceled                     canceled          (refunded)
 * ```
 *
 * `confirm()` has no counterpart on the real service — the browser does it via
 * Stripe.js. It is the harness's way of saying "the customer entered a card".
 *
 * ## What it does NOT model
 *
 * Signature verification (`constructWebhookEvent` trusts its input), 3-D Secure,
 * partial captures beyond the amount arithmetic, and Stripe's idempotency
 * window. Tests that care about idempotency assert on OUR behaviour — that we
 * do not call twice — rather than on Stripe collapsing the repeat.
 */
export class FakeStripeService {
  /** Always true. That is the entire point of this class. */
  readonly configured = true;

  private readonly intents = new Map<string, FakePaymentIntent>();
  private readonly refunds = new Map<string, StripeRefund>();
  private readonly transfers = new Map<string, StripeTransfer>();
  private readonly accounts = new Map<string, FakeAccount>();

  /** One-shot failures, keyed by operation, consumed in insertion order. */
  private readonly pendingFailures = new Map<FakeStripeOp, FakeStripeErrorSpec[]>();

  /** Every call made, in order — so a test can assert "captured exactly once". */
  readonly calls: FakeStripeCall[] = [];

  // Nest invokes lifecycle hooks on `useValue` providers too, and the real
  // service implements OnModuleInit. Without this the graph still boots, but
  // being explicit documents that boot must not touch the network.
  onModuleInit(): void {
    /* no network at boot */
  }

  // ============================================================
  // Test controls
  // ============================================================

  /**
   * Make the next call to `op` throw. Queue several to fail more than once.
   *
   * `spec` is shaped like the Stripe SDK's error objects, because
   * `classifyStripeError` reads `type` and `code` off them and the whole point
   * of a failure test is to drive that classifier down a real branch.
   */
  failNext(op: FakeStripeOp, spec: FakeStripeErrorSpec): void {
    const queue = this.pendingFailures.get(op) ?? [];
    queue.push(spec);
    this.pendingFailures.set(op, queue);
  }

  /** Forget every queued failure. */
  clearFailures(): void {
    this.pendingFailures.clear();
  }

  /**
   * Delete a connected account, so the next call referencing it raises
   * `resource_missing` — the "the account was removed in the dashboard, or the
   * key was swapped between live and test" case the Connect self-heal exists
   * for. This cannot be produced any other way without a real Stripe account.
   */
  deleteAccount(accountId: string): void {
    this.accounts.delete(accountId);
  }

  /** Drive a PaymentIntent to `requires_capture`, i.e. the customer paid. */
  confirm(paymentIntentId: string): StripePaymentIntent {
    const pi = this.requireIntent(paymentIntentId);
    if (pi.capture_method === 'manual') {
      pi.status = 'requires_capture';
      pi.amount_capturable = pi.amount;
    } else {
      pi.status = 'succeeded';
      pi.amount_received = pi.amount;
      pi.latest_charge = pi.latest_charge ?? `ch_fake_${randomUUID()}`;
    }
    this.record('confirm', paymentIntentId);
    return this.toPublic(pi);
  }

  /** How many times `op` was called, optionally for one object id. */
  countCalls(op: FakeStripeOp | 'confirm', id?: string): number {
    return this.calls.filter((c) => c.op === op && (id === undefined || c.id === id)).length;
  }

  /** The current state of an intent, for assertions. `undefined` if unknown. */
  intent(paymentIntentId: string): FakePaymentIntent | undefined {
    return this.intents.get(paymentIntentId);
  }

  /** Every refund raised against one PaymentIntent. */
  refundsFor(paymentIntentId: string): StripeRefund[] {
    return [...this.refunds.values()].filter((r) => r.payment_intent === paymentIntentId);
  }

  /** Reset everything. Call between cases so counters do not leak. */
  reset(): void {
    this.intents.clear();
    this.refunds.clear();
    this.transfers.clear();
    this.accounts.clear();
    this.pendingFailures.clear();
    this.calls.length = 0;
  }

  // ============================================================
  // The StripeService surface
  // ============================================================

  async createOrderPaymentIntent(
    params: CreateOrderPaymentIntentParams & { captureMethod?: 'manual' | 'automatic' },
  ): Promise<StripePaymentIntent> {
    this.take('createOrderPaymentIntent');
    const id = `pi_fake_${randomUUID()}`;
    const pi: FakePaymentIntent = {
      id,
      amount: params.amountCents,
      // Wave 3 sets this to 'manual'. Default to it so a caller that forgets is
      // caught by a behavioural test rather than silently charging up front.
      capture_method: params.captureMethod ?? 'manual',
      currency: 'eur',
      status: 'requires_payment_method',
      amount_capturable: 0,
      amount_received: 0,
      latest_charge: null,
      client_secret: `${id}_secret_fake`,
      metadata: {
        orderId: params.orderId,
        paymentId: params.paymentId,
        userId: params.userId,
        purpose: 'order',
      },
    };
    this.intents.set(id, pi);
    this.record('createOrderPaymentIntent', id);
    return this.toPublic(pi);
  }

  async capturePaymentIntent(
    paymentIntentId: string,
    _paymentId: string,
    amountCents?: number,
  ): Promise<StripePaymentIntent> {
    this.take('capture');
    const pi = this.requireIntent(paymentIntentId);
    if (pi.status === 'succeeded') {
      // Stripe is idempotent here only via the idempotency key; without one it
      // raises. Our code must therefore tolerate this, so the fake raises too.
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        message: `PaymentIntent ${paymentIntentId} has already been captured.`,
      });
    }
    if (pi.status !== 'requires_capture') {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        message: `PaymentIntent ${paymentIntentId} cannot be captured from ${pi.status}.`,
      });
    }
    pi.status = 'succeeded';
    pi.amount_received = amountCents ?? pi.amount;
    pi.amount_capturable = 0;
    pi.latest_charge = pi.latest_charge ?? `ch_fake_${randomUUID()}`;
    this.record('capture', paymentIntentId);
    return this.toPublic(pi);
  }

  async cancelPaymentIntent(
    paymentIntentId: string,
    _paymentId: string,
    _reason?: string,
  ): Promise<StripePaymentIntent> {
    this.take('cancel');
    const pi = this.requireIntent(paymentIntentId);
    if (pi.status === 'succeeded') {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        message: 'A captured PaymentIntent cannot be canceled; refund it instead.',
      });
    }
    pi.status = 'canceled';
    pi.amount_capturable = 0;
    this.record('cancel', paymentIntentId);
    return this.toPublic(pi);
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
    this.take('retrievePaymentIntent');
    const pi = this.requireIntent(paymentIntentId);
    this.record('retrievePaymentIntent', paymentIntentId);
    return this.toPublic(pi);
  }

  async createRefund(
    paymentIntentId: string,
    amountCents: number,
    reason: string,
  ): Promise<StripeRefund> {
    this.take('refund');
    const pi = this.requireIntent(paymentIntentId);
    if (pi.status !== 'succeeded') {
      // The exact message production returned when cancel() was called on an
      // order whose card was never charged — the second half of F-14.
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'charge_not_found',
        message: 'This PaymentIntent does not have a successful charge to refund.',
      });
    }
    const refund = {
      id: `re_fake_${randomUUID()}`,
      object: 'refund',
      amount: amountCents,
      currency: 'eur',
      payment_intent: paymentIntentId,
      status: 'succeeded',
      metadata: { reason },
    } as unknown as StripeRefund;
    this.refunds.set(refund.id, refund);
    this.record('refund', paymentIntentId);
    return refund;
  }

  async createTransfer(params: CreateTransferParams): Promise<StripeTransfer> {
    this.take('transfer');
    if (!this.accounts.has(params.destinationAccountId)) {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such destination: ${params.destinationAccountId}`,
      });
    }
    const transfer = {
      id: `tr_fake_${randomUUID()}`,
      object: 'transfer',
      amount: params.amountCents,
      currency: 'eur',
      destination: params.destinationAccountId,
      source_transaction: params.sourceChargeId,
      transfer_group: params.transferGroup,
    } as unknown as StripeTransfer;
    this.transfers.set(transfer.id, transfer);
    this.record('transfer', params.destinationAccountId);
    return transfer;
  }

  async createConnectedAccount(email: string): Promise<StripeAccount> {
    this.take('createConnectedAccount');
    const id = `acct_fake_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.accounts.set(id, {
      id,
      email,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    });
    this.record('createConnectedAccount', id);
    return this.accounts.get(id) as unknown as StripeAccount;
  }

  async createAccountLink(
    accountId: string,
    _refreshUrl: string,
    returnUrl: string,
  ): Promise<StripeAccountLink> {
    this.take('createAccountLink');
    if (!this.accounts.has(accountId)) {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such account: ${accountId}`,
      });
    }
    this.record('createAccountLink', accountId);
    return {
      object: 'account_link',
      url: `https://connect.stripe.test/setup/${accountId}?return=${encodeURIComponent(returnUrl)}`,
      created: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 300,
    } as unknown as StripeAccountLink;
  }

  async retrieveAccount(accountId: string): Promise<StripeAccount> {
    this.take('retrieveAccount');
    const account = this.accounts.get(accountId);
    if (!account) {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such account: ${accountId}`,
      });
    }
    this.record('retrieveAccount', accountId);
    return account as unknown as StripeAccount;
  }

  /** Mark a connected account as fully onboarded, the way `account.updated` would. */
  completeOnboarding(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`FakeStripeService: unknown account ${accountId}`);
    account.charges_enabled = true;
    account.payouts_enabled = true;
    account.details_submitted = true;
  }

  async createPpvCheckout(
    params: CreatePpvCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    return this.checkout(params.paymentId);
  }

  async createGoldCheckout(
    params: CreateGoldCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    return this.checkout(params.paymentId);
  }

  async createVinHistoryCheckout(
    params: CreateVinHistoryCheckoutParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    return this.checkout(params.paymentId);
  }

  /**
   * Trusts its input. Signature verification is Stripe's own code and testing
   * it would test the SDK; what our suites need is a parsed event to hand to
   * `PaymentsService.handleWebhook`.
   */
  constructWebhookEvent(rawBody: Buffer | string, _signature: string): StripeEvent {
    return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  }

  // ============================================================
  // Event builders — for driving handleWebhook directly
  // ============================================================

  /** A webhook envelope around `object`. Reuse one `id` to test the dedupe lock. */
  event(type: string, object: unknown, id = `evt_fake_${randomUUID()}`): StripeEvent {
    return {
      id,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type,
      data: { object },
    } as unknown as StripeEvent;
  }

  /** The event that says "the hold is in place" under manual capture. */
  amountCapturableUpdated(paymentIntentId: string, id?: string): StripeEvent {
    return this.event(
      'payment_intent.amount_capturable_updated',
      this.toPublic(this.requireIntent(paymentIntentId)),
      id,
    );
  }

  /** The event that says "the money was taken". Fires at capture, not at confirm. */
  paymentIntentSucceeded(paymentIntentId: string, id?: string): StripeEvent {
    return this.event(
      'payment_intent.succeeded',
      this.toPublic(this.requireIntent(paymentIntentId)),
      id,
    );
  }

  paymentIntentCanceled(paymentIntentId: string, id?: string): StripeEvent {
    return this.event(
      'payment_intent.canceled',
      this.toPublic(this.requireIntent(paymentIntentId)),
      id,
    );
  }

  paymentIntentFailed(paymentIntentId: string, id?: string): StripeEvent {
    return this.event(
      'payment_intent.payment_failed',
      this.toPublic(this.requireIntent(paymentIntentId)),
      id,
    );
  }

  // ============================================================
  // Internals
  // ============================================================

  private checkout(paymentId: string): { checkoutUrl: string; sessionId: string } {
    this.take('checkout');
    // Keyed by paymentId, mirroring the real service's `checkout_<paymentId>`
    // idempotency key: asking twice for one payment yields ONE session.
    const sessionId = `cs_fake_${paymentId}`;
    this.record('checkout', sessionId);
    return { checkoutUrl: `https://checkout.stripe.test/${sessionId}`, sessionId };
  }

  private requireIntent(paymentIntentId: string): FakePaymentIntent {
    const pi = this.intents.get(paymentIntentId);
    if (!pi) {
      throw fakeStripeError({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such payment_intent: ${paymentIntentId}`,
      });
    }
    return pi;
  }

  /** Consume a queued failure for `op`, if one is waiting, and throw it. */
  private take(op: FakeStripeOp): void {
    const queue = this.pendingFailures.get(op);
    if (!queue || queue.length === 0) return;
    const spec = queue.shift() as FakeStripeErrorSpec;
    if (queue.length === 0) this.pendingFailures.delete(op);
    throw fakeStripeError(spec);
  }

  private record(op: FakeStripeOp | 'confirm', id: string): void {
    this.calls.push({ op, id });
  }

  private toPublic(pi: FakePaymentIntent): StripePaymentIntent {
    return { ...pi, object: 'payment_intent' } as unknown as StripePaymentIntent;
  }
}

export type FakeStripeOp =
  | 'createOrderPaymentIntent'
  | 'capture'
  | 'cancel'
  | 'refund'
  | 'transfer'
  | 'retrievePaymentIntent'
  | 'createConnectedAccount'
  | 'createAccountLink'
  | 'retrieveAccount'
  | 'checkout';

export interface FakeStripeCall {
  op: FakeStripeOp | 'confirm';
  id: string;
}

export interface FakeStripeErrorSpec {
  /** e.g. `StripeConnectionError`, `StripeAPIError`, `StripeInvalidRequestError`, `StripeCardError`. */
  type: string;
  code?: string;
  message?: string;
  statusCode?: number;
}

export interface FakePaymentIntent {
  id: string;
  amount: number;
  capture_method: 'manual' | 'automatic';
  currency: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'succeeded'
    | 'canceled';
  amount_capturable: number;
  amount_received: number;
  latest_charge: string | null;
  client_secret: string;
  metadata: Record<string, string>;
}

interface FakeAccount {
  id: string;
  email: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

/**
 * An error shaped like the Stripe SDK's, so `classifyStripeError` sees the
 * fields it actually reads. Stripe's own errors carry `type`, `code`,
 * `statusCode` and `raw`; a plain `new Error()` would be classified as unknown
 * and every failure test would take the same branch.
 */
export function fakeStripeError(spec: FakeStripeErrorSpec): Error {
  const err = new Error(spec.message ?? spec.code ?? spec.type) as Error & {
    type: string;
    code?: string;
    statusCode?: number;
    raw: { code?: string; message?: string; type: string };
  };
  err.name = spec.type;
  err.type = spec.type;
  err.code = spec.code;
  err.statusCode = spec.statusCode ?? (spec.type === 'StripeAPIError' ? 500 : 400);
  err.raw = { code: spec.code, message: spec.message, type: spec.type };
  return err;
}
