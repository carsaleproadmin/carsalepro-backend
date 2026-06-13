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

export interface CreateTransferParams {
  amountCents: number;
  destinationAccountId: string;
  /** The source charge id so the transfer draws from that specific charge. */
  sourceChargeId: string;
  transferGroup: string;
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

  /** Create a one-time payment Checkout Session for a pay-per-view report. */
  async createPpvCheckout(params: CreatePpvCheckoutParams): Promise<{ checkoutUrl: string }> {
    const session = await this.requireClient().checkout.sessions.create({
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
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { checkoutUrl: session.url };
  }

  /** Create a one-time payment Checkout Session for a Gold listing upgrade. */
  async createGoldCheckout(params: CreateGoldCheckoutParams): Promise<{ checkoutUrl: string }> {
    const session = await this.requireClient().checkout.sessions.create({
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
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { checkoutUrl: session.url };
  }

  /**
   * Create a PaymentIntent for an inspection order. Automatic payment methods
   * are enabled; the order/payment ids ride along in metadata so the
   * `payment_intent.succeeded` webhook can settle the order.
   */
  async createOrderPaymentIntent(
    params: CreateOrderPaymentIntentParams,
  ): Promise<StripePaymentIntent> {
    return this.requireClient().paymentIntents.create({
      amount: params.amountCents,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: params.orderId,
        paymentId: params.paymentId,
        userId: params.userId,
        purpose: 'order',
      },
    });
  }

  /** Refund (full or partial) a captured PaymentIntent. */
  async createRefund(
    paymentIntentId: string,
    amountCents: number,
    reason: string,
  ): Promise<StripeRefund> {
    return this.requireClient().refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents,
      metadata: { reason },
    });
  }

  // ============================================================
  // Connect Express (E7)
  // ============================================================

  /**
   * Create an Express connected account for an inspector. `transfers` is the
   * only requested capability — the platform charges the customer and transfers
   * the inspector's share via separate charges-and-transfers.
   */
  async createConnectedAccount(email: string): Promise<StripeAccount> {
    return this.requireClient().accounts.create({
      type: 'express',
      country: 'DE',
      email,
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
    });
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
    return this.requireClient().transfers.create({
      amount: params.amountCents,
      currency: 'eur',
      destination: params.destinationAccountId,
      source_transaction: params.sourceChargeId,
      transfer_group: params.transferGroup,
    });
  }

  /** Verify and parse a Stripe webhook payload from its raw body + signature. */
  constructWebhookEvent(rawBody: Buffer | string, signature: string): StripeEvent {
    return this.requireClient().webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
