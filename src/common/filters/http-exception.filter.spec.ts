import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from './http-exception.filter';

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function render(exception: unknown): Captured {
  const captured: Captured = { status: 0, body: {} };
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  };
  const request = { method: 'POST', url: '/api/v1/whatever', originalUrl: '/api/v1/whatever' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  it('renders a ThrottlerException as 429 rate_limited, not InternalServerError', () => {
    // ThrottlerException is built from a bare string, so `getResponse()` returns
    // a string and the old filter's `errorName` never left its seed.
    const { status, body } = render(new ThrottlerException());

    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.statusCode).toBe(429);
    expect(body.error).toEqual({
      code: 'rate_limited',
      message: 'Too many requests. Please retry shortly.',
    });
  });

  it('gives other string-payload exceptions their canonical error name', () => {
    expect(render(new HttpException('nope', HttpStatus.FORBIDDEN)).body.error).toBe('Forbidden');
    expect(render(new HttpException('nope', HttpStatus.CONFLICT)).body.error).toBe('Conflict');
    expect(render(new HttpException('nope', HttpStatus.PAYLOAD_TOO_LARGE)).body.error).toBe(
      'PayloadTooLarge',
    );
  });

  it('preserves EXTRA fields thrown alongside the error envelope', () => {
    // The frontend acts on these: a quality gate is useless if the client is
    // told only "rejected" and not by how much, or which photos are missing.
    const { status, body } = render(
      new BadRequestException({
        error: { code: 'quality_too_low', message: 'Report quality is below the threshold' },
        qualityScore: 41,
        minQualityScore: 60,
        missing: ['diag_front_left', 'rear'],
      }),
    );

    expect(status).toBe(400);
    expect(body.qualityScore).toBe(41);
    expect(body.minQualityScore).toBe(60);
    expect(body.missing).toEqual(['diag_front_left', 'rear']);
    expect((body.error as { code: string }).code).toBe('quality_too_low');
  });

  it('preserves the frozen 402 counters the mobile app reads', () => {
    const { body } = render(
      new HttpException(
        {
          error: 'PaymentRequired',
          message: 'FREE-tier limit of 3 reports reached. Upgrade to PRO to continue.',
          freeReportsUsed: 3,
          freeReportsLimit: 3,
        },
        HttpStatus.PAYMENT_REQUIRED,
      ),
    );

    expect(body.statusCode).toBe(402);
    expect(body.error).toBe('PaymentRequired');
    expect(body.message).toBe('FREE-tier limit of 3 reports reached. Upgrade to PRO to continue.');
    expect(body.freeReportsUsed).toBe(3);
    expect(body.freeReportsLimit).toBe(3);
    expect(body.path).toBe('/api/v1/whatever');
  });

  it('keeps a deliberate 5xx domain envelope readable (Stripe Connect codes reach the client)', () => {
    const { status, body } = render(
      new ServiceUnavailableException({
        error: { code: 'connect_not_enabled', message: 'Payouts are not enabled yet.' },
      }),
    );

    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe('connect_not_enabled');
  });

  it('still masks an unexpected 5xx', () => {
    const { status, body } = render(new Error('DB password is hunter2'));

    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
