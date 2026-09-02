import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators';
import { PaymentsService } from './payments.service';
import { StripeEvent, StripeService } from './stripe.service';

@ApiExcludeController()
@Public()
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * PLATFORM events - the payments of our own account.
   *
   * `we_1UAQ1Y…` in the live dashboard: checkout sessions, payment intents,
   * refunds, disputes and transfers.
   */
  @Post('stripe')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received?: boolean; skipped?: boolean }> {
    return this.handle(req, signature, 'platform');
  }

  /**
   * CONNECT events - what happens on an inspector's own account.
   *
   * A SEPARATE ROUTE, because Stripe issues one signing secret per endpoint
   * and a route can verify against one secret. Both endpoints used to post
   * here, so `account.updated` was refused with 400 on every delivery: the
   * route held the platform secret, and the Connect endpoint signs with its
   * own. That event is the only thing that sets `stripeOnboarded`, and
   * `eligibleForOffers` reads it - so in production no inspector could ever be
   * dispatched an order, and nothing anywhere said why.
   *
   * Merging the two endpoints in the dashboard is not the alternative: a
   * connected account's events are only delivered to an endpoint registered
   * against the Connect application.
   */
  @Post('stripe/connect')
  @HttpCode(200)
  async stripeConnectWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received?: boolean; skipped?: boolean }> {
    return this.handle(req, signature, 'connect');
  }

  /**
   * One body for both, so the two routes cannot drift apart.
   *
   * They differ in exactly one thing - which secret verifies the signature -
   * and everything after that is the same event pipeline.
   */
  private async handle(
    req: RawBodyRequest<Request>,
    signature: string | undefined,
    source: 'platform' | 'connect',
  ): Promise<{ received?: boolean; skipped?: boolean }> {
    // No Stripe key configured → nothing to verify. Safe no-op so the endpoint
    // never 500s in environments without Stripe (e.g. tests, local dev).
    if (!this.stripe.configured) {
      return { skipped: true };
    }

    /*
     * A missing CONNECT secret is refused rather than skipped.
     *
     * `{ skipped: true }` answers 200, and Stripe reads 200 as delivered - so
     * an unset secret would look healthy in the dashboard while every event
     * was dropped. That is the failure this route exists to end, and it must
     * not be reintroduced in a different shape. The log line names the
     * variable, because the deploy that needs it is the one that has not set
     * it yet.
     */
    if (source === 'connect' && !this.stripe.connectWebhookConfigured) {
      this.logger.error(
        'STRIPE_CONNECT_WEBHOOK_SECRET is unset - Connect events cannot be verified and are refused',
      );
      throw new BadRequestException({
        error: { code: 'connect_webhook_unconfigured', message: 'Connect webhook not configured' },
      });
    }

    if (!signature || !req.rawBody) {
      throw new BadRequestException({
        error: { code: 'invalid_signature', message: 'Missing Stripe signature or body' },
      });
    }

    let event: StripeEvent;
    try {
      event =
        source === 'connect'
          ? this.stripe.constructConnectWebhookEvent(req.rawBody, signature)
          : this.stripe.constructWebhookEvent(req.rawBody, signature);
    } catch (err) {
      // The SOURCE is named, because the two endpoints share a hostname and a
      // failure on one reads exactly like a failure on the other in the log.
      this.logger.warn(
        `Stripe ${source} signature verification failed: ${(err as Error).message}`,
      );
      throw new BadRequestException({
        error: { code: 'invalid_signature', message: 'Signature verification failed' },
      });
    }

    await this.payments.handleWebhook(event);
    return { received: true };
  }
}
