import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

const logger = new Logger('Sentry');

export function initSentry(dsn: string | undefined, environment: string, release?: string): boolean {
  if (!dsn) {
    logger.log('SENTRY_DSN not set — error reporting disabled');
    return false;
  }
  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
  });
  logger.log(`Sentry initialized (env=${environment})`);
  return true;
}

export function captureExceptionIfEnabled(err: unknown): void {
  try {
    Sentry.captureException(err);
  } catch {
    // no-op if Sentry isn't initialized
  }
}
