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

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        message = (obj.message as string | string[]) ?? exception.message;
        // Domain exceptions throw `{ error: { code, message } }` — keep that
        // nested object so the frontend + e2e can read `body.error.code`.
        errorName = (obj.error as string | Record<string, unknown>) ?? exception.name;
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
    // like 503 `provider_unavailable` (VIN history with no provider) or 502
    // `provider_failed` reaches the frontend as `internal_error`, and the UI
    // cannot tell a deliberate refusal — you were not charged — from a crash.
    // Anything else at 5xx (a raw Error, a framework exception, an
    // HttpException whose payload is a bare string) is still masked.
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
    // that the frontend + e2e assertions rely on.
    const body: ErrorResponseBody = {
      statusCode: status,
      error: errorName,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
