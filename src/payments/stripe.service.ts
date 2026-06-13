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
    if (!stripe.secretKey) {
      this.logger.warn('STRIPE_SECRET_KEY not set — Stripe runs in mock mode');
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

  /** Verify and parse a Stripe webhook payload from its raw body + signature. */
  constructWebhookEvent(rawBody: Buffer | string, signature: string): StripeEvent {
    return this.requireClient().webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
