import type { ErrorEvent } from '@sentry/node';
import { scrubSentryEvent } from './sentry.bootstrap';

const JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJ0cmFuc2FjdGlvbklkIjoiMjAwMCJ9.c2ln';
const DEVICE = '3f0c2a7e-5d1b-4c3a-9e8f-1a2b3c4d5e6f';
const PLAY_TOKEN = 'opaque-play-purchase-token.AO-J1Oz';

function upgradeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    transaction: 'POST /quota/upgrade',
    request: {
      url: 'https://carsalepro-backend.onrender.com/quota/upgrade',
      method: 'POST',
      data: JSON.stringify({ platform: 'ios', receipt: JWS }),
      cookies: { sid: 'x' },
      headers: {
        'X-Device-Id': DEVICE,
        'content-type': 'application/json',
        Authorization: 'Bearer t',
      },
    },
    extra: { method: 'POST', url: '/quota/upgrade', deviceId: DEVICE, status: 503 },
    ...overrides,
  };
}

describe('scrubSentryEvent', () => {
  it('removes the receipt, the device id and the cookies from a /quota/upgrade event', () => {
    const out = scrubSentryEvent(upgradeEvent());
    const text = JSON.stringify(out);

    expect(text).not.toContain(JWS);
    expect(text).not.toContain(DEVICE);
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toEqual({ 'content-type': 'application/json' });
    expect(out.extra).toEqual({ method: 'POST', url: '/quota/upgrade', status: 503 });
  });

  it('recognises the route from the transaction name alone', () => {
    const event = upgradeEvent();
    event.request = { ...event.request, url: undefined };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(JWS);
  });

  it('leaves the body of other routes alone', () => {
    const out = scrubSentryEvent(
      upgradeEvent({
        transaction: 'POST /reports',
        request: { url: 'https://api.example/reports', data: '{"code":"CSP-1"}' },
        extra: { deviceId: DEVICE },
      }),
    );
    expect(out.request?.data).toBe('{"code":"CSP-1"}');
    expect(out.extra).toEqual({ deviceId: DEVICE });
  });

  it('redacts store tokens and transaction ids in breadcrumbs on every event', () => {
    const out = scrubSentryEvent({
      type: undefined,
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url:
              'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/net.carsalepro.app' +
              `/purchases/products/carsalepro_pro_lifetime/tokens/${PLAY_TOKEN}:acknowledge`,
          },
        },
        {
          category: 'http',
          data: {
            url: 'https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000123456789',
          },
        },
        { category: 'console', message: 'plain message' },
      ],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(PLAY_TOKEN);
    expect(text).not.toContain('2000000123456789');
    expect(text).toContain('/tokens/[redacted]:acknowledge');
    expect(text).toContain('/inApps/v1/transactions/[redacted]');
    expect(out.breadcrumbs?.[2]).toEqual({ category: 'console', message: 'plain message' });
  });
});
