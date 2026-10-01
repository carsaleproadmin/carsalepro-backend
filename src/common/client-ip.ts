import { timingSafeEqual } from 'node:crypto';

/**
 * DEN-417. Which client a request comes from, for the rate limit.
 *
 * `req.ip` is NOT the client. `main.ts` does not set `trust proxy`, so behind
 * Render and Cloudflare `req.ip` is the address of a proxy node. On production
 * one client hit at least three different buckets, and other clients shared
 * them. The order of trust is:
 *
 * 1. `x-client-ip`, only with a correct `x-internal-key`. The website sends it
 *    from its server, because its own calls come from the Vercel address.
 * 2. `cf-connecting-ip`. Cloudflare writes it and replaces a value that the
 *    client sends.
 * 3. `req.ip`, as before. Local development has no proxy.
 */
export interface ClientIpRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function resolveClientIp(req: ClientIpRequest, internalKey: string): string {
  const claimed = header(req, 'x-client-ip');
  const key = header(req, 'x-internal-key');
  if (claimed && key && internalKey && constantTimeEquals(key, internalKey)) {
    return claimed;
  }
  return header(req, 'cf-connecting-ip') ?? req.ip ?? 'unknown';
}

/** The same key that `/auth/oauth-upsert` accepts. */
export function internalKeyFromEnv(): string {
  return (
    process.env.INTERNAL_API_KEY ||
    process.env.JWT_SECRET ||
    'dev-shared-secret-change-me'
  );
}

function header(req: ClientIpRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value.slice(0, 64) : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
