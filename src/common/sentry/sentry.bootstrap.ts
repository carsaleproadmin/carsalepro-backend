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
    beforeSend: scrubSentryEvent,
  });
  logger.log(`Sentry initialized (env=${environment})`);
  return true;
}

/**
 * Routes whose request body is a credential. `@sentry/node` 8 records every
 * incoming request body (`SentryHttpInstrumentation`), so without this a 503
 * from `POST /quota/upgrade` sends the StoreKit JWS or the Play purchase token
 * to Sentry, together with the `X-Device-Id` that would redeem it.
 */
const SECRET_BODY_ROUTES = [/\/quota\/upgrade(?![\w-])/];

/** Request headers that identify or authenticate the caller. */
const SECRET_HEADERS = new Set(['x-device-id', 'authorization', 'cookie']);

/**
 * Store API URLs carry a purchase token or a transaction id in the PATH, and
 * the SDK records outgoing calls as breadcrumbs with the path intact.
 */
const STORE_URL_SECRETS: Array<[RegExp, string]> = [
  [/(\/purchases\/(?:products|subscriptions)\/[^/\s]+\/tokens\/)[^/?#:\s]+/g, '$1[redacted]'],
  [/(\/inApps\/v1\/transactions\/)[^/?#\s]+/g, '$1[redacted]'],
];

function redactStoreUrls(value: string): string {
  return STORE_URL_SECRETS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value);
}

function isSecretRoute(...candidates: Array<string | undefined>): boolean {
  return candidates.some(
    (value) => typeof value === 'string' && SECRET_BODY_ROUTES.some((route) => route.test(value)),
  );
}

/**
 * `beforeSend`: drop what Sentry must never hold. Exported for its spec.
 *
 * On a secret route the body, the cookies, the caller's identifying headers and
 * the `deviceId` extra that `AllExceptionsFilter` attaches are removed. On
 * every event, store URLs in breadcrumbs lose their token / transaction id.
 */
export function scrubSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const request = event.request;
  if (isSecretRoute(request?.url, event.transaction)) {
    if (request) {
      delete request.data;
      delete request.cookies;
      delete request.query_string;
      if (request.headers) {
        request.headers = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())),
        );
      }
    }
    if (event.extra) {
      const extra = { ...event.extra };
      delete extra.deviceId;
      event.extra = extra;
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      const data = crumb.data;
      const url = typeof data?.url === 'string' ? data.url : undefined;
      return {
        ...crumb,
        ...(crumb.message ? { message: redactStoreUrls(crumb.message) } : {}),
        ...(data && url ? { data: { ...data, url: redactStoreUrls(url) } } : {}),
      };
    });
  }
  return event;
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
