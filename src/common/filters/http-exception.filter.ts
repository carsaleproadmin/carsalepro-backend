import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { captureExceptionIfEnabled } from '../sentry/sentry.bootstrap';

interface ErrorResponseBody {
  statusCode: number;
  error: string | Record<string, unknown>;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

/** Generic client-facing body for 5xx / unexpected errors — never leaks internals. */
interface GenericErrorBody {
  error: { code: 'internal_error'; message: 'Internal server error' };
  requestId?: string;
}

/**
 * Canonical `error` names for exceptions whose payload is a bare string.
 *
 * Nest builds most `HttpException` subclasses with an object payload, but a few
 * — notably `ThrottlerException`, which is `super(message, 429)` — pass a plain
 * string. That branch never assigned `errorName`, so it kept the
 * `'InternalServerError'` seed and every rate-limited request was labelled a
 * server fault on the wire.
 */
const STATUS_ERROR_NAMES: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  413: 'PayloadTooLarge',
  415: 'UnsupportedMediaType',
  429: 'TooManyRequests',
  503: 'ServiceUnavailable',
};

/** Keys the envelope owns; anything else in a thrown payload is passed through. */
const ENVELOPE_KEYS = new Set(['statusCode', 'error', 'message', 'path', 'timestamp']);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let errorName: string | Record<string, unknown> = 'InternalServerError';
    // Fields a domain exception put ALONGSIDE `error`/`message` (the frozen 402's
    // `freeReportsUsed`/`freeReportsLimit`, and the quality/`missing` details
    // later waves attach). Dropping them silently would leave the frontend with
    // a code it cannot act on.
    let extras: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        if (status === HttpStatus.TOO_MANY_REQUESTS) {
          // The rate limiter is a deliberate, documented refusal — give it a
          // machine-readable code like every other domain error.
          errorName = { code: 'rate_limited', message: 'Too many requests. Please retry shortly.' };
          message = 'Too many requests. Please retry shortly.';
        } else {
          errorName = STATUS_ERROR_NAMES[status] ?? exception.name;
        }
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        message = (obj.message as string | string[]) ?? exception.message;
        // Domain exceptions throw `{ error: { code, message } }` — keep that
        // nested object so the frontend + e2e can read `body.error.code`.
        errorName = (obj.error as string | Record<string, unknown>) ?? exception.name;
        extras = Object.fromEntries(
          Object.entries(obj).filter(([key]) => !ENVELOPE_KEYS.has(key)),
        );
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
    }

    // Log / capture the REAL error server-side regardless of what we return.
    let sentryEventId: string | undefined;
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${
          typeof errorName === 'string' ? errorName : JSON.stringify(errorName)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
      sentryEventId = captureExceptionIfEnabled(exception, {
        method: request.method,
        url: request.originalUrl ?? request.url,
        deviceId: request.deviceId,
        status,
      });
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${status} ${
          typeof errorName === 'string' ? errorName : JSON.stringify(errorName)
        }`,
      );
    }

    // 5xx (and non-HttpException errors, which map to 500) must NEVER leak the
    // internal message/stack to the client — return a generic, normalized body.
    //
    // The one exception is a DELIBERATE HttpException carrying the domain shape
    // `{ error: { code, message } }`: that body was written by us, for the
    // client, and contains no internals. Without this, a documented contract
    // like 503 `provider_unavailable` (VIN history with no provider), 502
    // `provider_failed`, or the Stripe Connect onboarding codes
    // (`connect_not_enabled`, `stripe_unavailable`, …) reaches the frontend as
    // `internal_error`, and the UI cannot tell a deliberate refusal — you were
    // not charged — from a crash. Anything else at 5xx (a raw Error, a framework
    // exception, an HttpException whose payload is a bare string) is still
    // masked.
    const deliberate =
      exception instanceof HttpException &&
      typeof errorName === 'object' &&
      errorName !== null &&
      typeof (errorName as { code?: unknown }).code === 'string';

    if (status >= 500 && !deliberate) {
      const genericBody: GenericErrorBody = {
        error: { code: 'internal_error', message: 'Internal server error' },
        ...(sentryEventId ? { requestId: sentryEventId } : {}),
      };
      response.status(status).json(genericBody);
      return;
    }

    // 4xx — preserve the existing shape (incl. the nested domain `error` object)
    // that the frontend + e2e assertions rely on, plus any extra fields the
    // thrown envelope carried.
    const body: ErrorResponseBody & Record<string, unknown> = {
      ...extras,
      statusCode: status,
      error: errorName,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
