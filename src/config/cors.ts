/**
 * CORS allow-list resolution.
 *
 * This lives in its own module — and is deliberately pure — because `main.ts`
 * is a bootstrap script that Jest cannot import without standing up the whole
 * Nest application. The rule that decided which browser origins may talk to the
 * API therefore had no test at all, and shipped allowing exactly one origin:
 * `WEB_ORIGIN`. `https://www.carsalepro.de` was not it, so signup, password
 * reset, email verification and the public report check were dead on the real
 * production domain while every server-rendered call kept working.
 */

/**
 * Normalize one origin: trim, drop trailing slashes, lower-case the scheme and
 * host. Scheme and host are case-insensitive per RFC 3986; anything after the
 * authority (an origin should have nothing there) is left untouched rather than
 * silently mangled.
 */
function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
  if (!parts) return trimmed.toLowerCase();
  return `${parts[1].toLowerCase()}${parts[2].toLowerCase()}${parts[3]}`;
}

/**
 * Split a comma-separated origin list into normalized origins: trimmed, without
 * trailing slashes, host lower-cased, blanks dropped, duplicates removed.
 * Order is preserved — the caller relies on the first entry being canonical.
 */
export function parseOriginList(raw: string): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const origin = normalizeOrigin(part);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The full browser allow-list: every entry of `WEB_ORIGIN` (which may be a
 * single origin or, for backward compatibility, a comma-separated list whose
 * FIRST entry is the canonical one used to build absolute URLs) plus every
 * entry of the purely additive `CORS_ORIGINS`, deduplicated.
 */
export function resolveCorsOrigins(webOrigin: string, corsOrigins: string): string[] {
  const allowed = parseOriginList(webOrigin);
  for (const extra of parseOriginList(corsOrigins)) {
    if (!allowed.includes(extra)) allowed.push(extra);
  }
  return allowed;
}

/** Vercel preview deployments (`https://<branch-hash>.vercel.app`). */
export const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

export type CorsOriginChecker = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void;

/**
 * The express `cors` origin callback.
 *
 * A request with no `Origin` header is not a browser CORS request at all
 * (server-to-server: the Stripe webhook, health probes, the website's own
 * server components) and is always allowed. Everything else must match an
 * allow-listed origin exactly, or be a Vercel preview deployment. Matching is
 * on the normalized form, so a trailing slash or a capitalised host in the
 * environment variable cannot silently lock the real site out.
 */
export function buildCorsOriginChecker(allowed: string[]): CorsOriginChecker {
  const allowSet = new Set(allowed.map((o) => normalizeOrigin(o)).filter(Boolean) as string[]);
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    if (normalized && (allowSet.has(normalized) || VERCEL_PREVIEW.test(normalized))) {
      return callback(null, true);
    }
    return callback(null, false);
  };
}
