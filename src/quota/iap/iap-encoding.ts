/**
 * Small, dependency-free helpers shared by the Apple and Google validators.
 * Nothing here logs, and nothing here verifies a signature.
 */

export function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A compact JWS: three base64url parts separated by dots. */
export function isCompactJws(value: string): boolean {
  return COMPACT_JWS.test(value);
}

/**
 * The JSON payload of a compact JWS, or `null` when it does not parse.
 *
 * The signature is NOT checked. Callers use the payload only to find what to
 * ask the store about, or to refuse early; they never grant anything on it.
 */
export function decodeJwsPayload<T extends object>(jws: string): T | null {
  const parts = jws.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

/** The HTTP status of an axios-style error, or 0 for a network failure. */
export function httpStatusOf(err: unknown): number {
  if (typeof err !== 'object' || err === null || !('response' in err)) return 0;
  const status = (err as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : 0;
}

/** The response body of an axios-style error, or undefined. */
export function httpBodyOf<T>(err: unknown): T | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  return (err as { response?: { data?: T } }).response?.data;
}

/** A store answer we cannot act on now: rate limit, server fault, or no answer. */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** Control, format and bidi characters: nothing a log line or a message should carry. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A value that came from a client (or a store answer it shaped), made safe for
 * an error message or a log line: control characters removed and the length
 * cut to `max`. A bundle id or a product id is short, so nothing real is lost.
 */
export function printable(value: unknown, max = 64): string {
  if (value === undefined || value === null) return 'none';
  const text = String(value).replace(UNPRINTABLE, '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
