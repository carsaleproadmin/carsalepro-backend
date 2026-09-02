import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { WebhookController } from './webhook.controller';
import type { PaymentsService } from './payments.service';
import type { StripeEvent, StripeService } from './stripe.service';

/*
 * WHICH SECRET VERIFIES WHICH ROUTE - DEN-235.
 *
 * This is the one decision the split was made for, and the end-to-end suite
 * cannot hold it: that suite forces mock mode, so it reaches the early return
 * and asserts `{ skipped: true }` - which proves the route resolves and
 * nothing at all about the secret.
 *
 * If both routes called `constructWebhookEvent`, every other test would still
 * pass and the fault would ship looking exactly like the fault it replaced:
 * `account.updated` refused on every delivery, no inspector eligible, and
 * nothing anywhere saying why. So the wiring is asserted directly.
 */
function buildStripe(overrides: Partial<StripeService> = {}): StripeService {
  return {
    configured: true,
    connectWebhookConfigured: true,
    constructWebhookEvent: jest.fn(
      (): StripeEvent => ({ id: 'evt_platform', type: 'payment_intent.succeeded' }) as StripeEvent,
    ),
    constructConnectWebhookEvent: jest.fn(
      (): StripeEvent => ({ id: 'evt_connect', type: 'account.updated' }) as StripeEvent,
    ),
    ...overrides,
  } as unknown as StripeService;
}

function buildPayments(): PaymentsService {
  return { handleWebhook: jest.fn().mockResolvedValue(undefined) } as unknown as PaymentsService;
}

/** A request carrying a raw body, which is what the signature is computed over. */
function buildRequest(): RawBodyRequest<Request> {
  return { rawBody: Buffer.from('{"id":"evt_1"}') } as unknown as RawBodyRequest<Request>;
}

describe('WebhookController - the two routes and their two secrets', () => {
  it('verifies a platform event with the platform secret, and only that one', async () => {
    const stripe = buildStripe();
    const payments = buildPayments();
    const controller = new WebhookController(stripe, payments);

    const res = await controller.stripeWebhook(buildRequest(), 't=1,v1=abc');

    expect(res).toEqual({ received: true });
    expect(stripe.constructWebhookEvent).toHaveBeenCalledTimes(1);
    expect(stripe.constructConnectWebhookEvent).not.toHaveBeenCalled();
  });

  it('verifies a Connect event with the Connect secret, and only that one', async () => {
    const stripe = buildStripe();
    const payments = buildPayments();
    const controller = new WebhookController(stripe, payments);

    const res = await controller.stripeConnectWebhook(buildRequest(), 't=1,v1=abc');

    expect(res).toEqual({ received: true });
    expect(stripe.constructConnectWebhookEvent).toHaveBeenCalledTimes(1);
    expect(stripe.constructWebhookEvent).not.toHaveBeenCalled();
  });

  it('hands the verified event on to the pipeline, whichever route it came in by', async () => {
    const stripe = buildStripe();
    const payments = buildPayments();
    const controller = new WebhookController(stripe, payments);

    await controller.stripeConnectWebhook(buildRequest(), 't=1,v1=abc');

    // The route differs in the secret and in nothing else - the event goes to
    // the same handler, which is what lets one body serve both.
    expect(payments.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account.updated' }),
    );
  });

  /*
   * Refused, not skipped. `{ skipped: true }` answers 200 and Stripe reads 200
   * as delivered, so an unset secret would look healthy in the dashboard while
   * every event was dropped - the same defect wearing a different shape.
   */
  it('refuses a Connect event when its secret is unset, rather than skipping it', async () => {
    const stripe = buildStripe({ connectWebhookConfigured: false });
    const payments = buildPayments();
    const controller = new WebhookController(stripe, payments);

    await expect(controller.stripeConnectWebhook(buildRequest(), 't=1,v1=abc')).rejects.toThrow(
      BadRequestException,
    );
    expect(stripe.constructConnectWebhookEvent).not.toHaveBeenCalled();
    expect(payments.handleWebhook).not.toHaveBeenCalled();
  });

  it('leaves the platform route working when only the Connect secret is unset', async () => {
    const stripe = buildStripe({ connectWebhookConfigured: false });
    const controller = new WebhookController(stripe, buildPayments());

    await expect(controller.stripeWebhook(buildRequest(), 't=1,v1=abc')).resolves.toEqual({
      received: true,
    });
  });

  it('skips both routes when Stripe is not configured at all', async () => {
    const stripe = buildStripe({ configured: false });
    const controller = new WebhookController(stripe, buildPayments());

    await expect(controller.stripeWebhook(buildRequest(), 't=1,v1=abc')).resolves.toEqual({
      skipped: true,
    });
    await expect(controller.stripeConnectWebhook(buildRequest(), 't=1,v1=abc')).resolves.toEqual({
      skipped: true,
    });
  });

  it('refuses a request with no signature on either route', async () => {
    const controller = new WebhookController(buildStripe(), buildPayments());

    await expect(controller.stripeWebhook(buildRequest(), undefined)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.stripeConnectWebhook(buildRequest(), undefined)).rejects.toThrow(
      BadRequestException,
    );
  });
});
