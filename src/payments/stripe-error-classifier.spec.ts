import { classifyStripeError } from './stripe.service';

/** Shape-compatible stand-in for a Stripe SDK error (no network, no SDK boot). */
function stripeError(props: Record<string, unknown>): unknown {
  return Object.assign(new Error((props.message as string) ?? 'stripe failure'), props);
}

describe('classifyStripeError', () => {
  describe('retryable', () => {
    it('treats a connection error as retryable', () => {
      const f = classifyStripeError(stripeError({ type: 'StripeConnectionError' }));
      expect(f.retryable).toBe(true);
      expect(f.code).toBe('connection_error');
    });

    it('treats a Stripe-side API error as retryable', () => {
      expect(classifyStripeError(stripeError({ type: 'StripeAPIError' })).retryable).toBe(true);
    });

    it('treats a rate-limit error as retryable (raw type or SDK type)', () => {
      expect(
        classifyStripeError(stripeError({ type: 'StripeInvalidRequestError', raw: { type: 'rate_limit_error' } }))
          .retryable,
      ).toBe(true);
      expect(classifyStripeError(stripeError({ type: 'StripeRateLimitError' })).retryable).toBe(true);
    });

    it('treats any HTTP 5xx as retryable', () => {
      expect(classifyStripeError(stripeError({ statusCode: 500 })).retryable).toBe(true);
      expect(classifyStripeError(stripeError({ statusCode: 503 })).retryable).toBe(true);
    });
  });

  describe('fatal', () => {
    it.each([
      'resource_missing',
      'payment_intent_unexpected_state',
      'charge_expired_for_capture',
      'card_declined',
    ])('treats %s as fatal', (code) => {
      const f = classifyStripeError(stripeError({ type: 'StripeInvalidRequestError', code }));
      expect(f.retryable).toBe(false);
      expect(f.code).toBe(code);
    });

    it('treats a card error as fatal', () => {
      expect(classifyStripeError(stripeError({ type: 'StripeCardError' })).retryable).toBe(false);
      expect(
        classifyStripeError(stripeError({ type: 'StripeInvalidRequestError', raw: { type: 'card_error' } }))
          .retryable,
      ).toBe(false);
    });

    it('keeps a fatal code fatal even when it arrives with a 5xx status', () => {
      // Otherwise a mis-set status would make us retry a request that can never
      // succeed — the exact loop the classifier exists to prevent.
      const f = classifyStripeError(
        stripeError({ type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 500 }),
      );
      expect(f.retryable).toBe(false);
    });

    it('treats a 4xx invalid-request error as fatal', () => {
      const f = classifyStripeError(
        stripeError({ type: 'StripeInvalidRequestError', code: 'account_invalid', statusCode: 400 }),
      );
      expect(f.retryable).toBe(false);
      expect(f.code).toBe('account_invalid');
    });

    it('treats an UNRECOGNISED error as fatal — never silently retry money movement', () => {
      expect(classifyStripeError(new Error('boom')).retryable).toBe(false);
      expect(classifyStripeError(undefined).retryable).toBe(false);
      expect(classifyStripeError(null).retryable).toBe(false);
      expect(classifyStripeError('a string').retryable).toBe(false);
      expect(classifyStripeError({ type: 'SomeFutureStripeError' }).retryable).toBe(false);
    });
  });

  it('always returns a non-empty code and message', () => {
    for (const input of [undefined, null, {}, new Error(''), stripeError({ type: 'StripeAPIError' })]) {
      const f = classifyStripeError(input);
      expect(f.code.length).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });
});
