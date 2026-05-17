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

export function captureExceptionIfEnabled(
  err: unknown,
  context?: Record<string, unknown>,
): string | undefined {
  try {
    return Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    return undefined;
  }
}

export function captureMessageIfEnabled(message: string, level: Sentry.SeverityLevel = 'info'): string | undefined {
  try {
    return Sentry.captureMessage(message, level);
  } catch {
    return undefined;
  }
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}
