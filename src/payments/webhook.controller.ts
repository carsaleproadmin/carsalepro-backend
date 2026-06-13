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

  @Post('stripe')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received?: boolean; skipped?: boolean }> {
    // No Stripe key configured → nothing to verify. Safe no-op so the endpoint
    // never 500s in environments without Stripe (e.g. tests, local dev).
    if (!this.stripe.configured) {
      return { skipped: true };
    }

    if (!signature || !req.rawBody) {
      throw new BadRequestException({
        error: { code: 'invalid_signature', message: 'Missing Stripe signature or body' },
      });
    }

    let event: StripeEvent;
    try {
      event = this.stripe.constructWebhookEvent(req.rawBody, signature);
    } catch (err) {
      this.logger.warn(`Stripe signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException({
        error: { code: 'invalid_signature', message: 'Signature verification failed' },
      });
    }

    await this.payments.handleWebhook(event);
    return { received: true };
  }
}
