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
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
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
    let errorName = 'InternalServerError';

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        message = (obj.message as string | string[]) ?? exception.message;
        errorName = (obj.error as string) ?? exception.name;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
    }

    let sentryEventId: string | undefined;
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${errorName}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      sentryEventId = captureExceptionIfEnabled(exception, {
        method: request.method,
        url: request.originalUrl ?? request.url,
        deviceId: request.deviceId,
        status,
      });
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status} ${errorName}`);
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      error: errorName,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(sentryEventId ? { requestId: sentryEventId } : {}),
    };

    response.status(status).json(body);
  }
}
