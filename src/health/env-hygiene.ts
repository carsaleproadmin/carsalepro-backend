/**
 * Environment-variable hygiene: the detectors behind the boot-time self-check.
 *
 * WHY THIS FILE EXISTS. The 2026-08 audit found nine blocking production
 * defects; four of them were a *value* that was almost right. The worst was a
 * UTF-8 BOM (U+FEFF) that a text editor had prepended to the Mapbox token in
 * the Vercel dashboard. Nothing rejected it: Joi saw a non-empty string, the
 * build passed, `/health` was green - and every geocode came back 401, so the
 * order form told users with perfectly valid addresses that their address did
 * not exist. A BOM is invisible in every UI that shows the variable.
 *
 * Everything here is PURE and secret-free by construction. A finding carries a
 * name, a length and a list of issue codes - never a character of the value.
 * A self-check that leaks JWT_SECRET into a deploy log is worse than the defect
 * it reports, and deploy logs are readable by more people, for longer, than any
 * secret store.
 */

/** Byte-order mark / zero-width no-break space. The audit's actual defect. */
export const BOM = '\uFEFF';

export type EnvIssueCode = 'bom' | 'crlf' | 'whitespace' | 'nbsp' | 'quoted' | 'control';

const ISSUE_LABELS: Record<EnvIssueCode, string> = {
  bom: 'has BOM',
  crlf: 'has CR/LF',
  whitespace: 'has wrapping whitespace',
  nbsp: 'has non-breaking space',
  quoted: 'wrapped in quotes',
  control: 'has control characters',
};

/** Non-breaking spaces that survive a copy/paste out of a web page or a PDF. */
const NBSP_RE = /[\u00A0\u2007\u202F]/;

/** C0 controls other than CR and LF, which get their own code, plus DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;

/** BOM + line terminators, stripped before wrapping whitespace is judged. */
const BOM_OR_EOL_RE = /[\uFEFF\r\n]/g;

export interface EnvHygieneFinding {
  name: string;
  /** False when unset or empty. A whitespace-only value counts as present. */
  present: boolean;
  /** Length of the raw value in UTF-16 code units. Never the value. */
  length: number;
  issues: EnvIssueCode[];
}

/**
 * Inspect one variable. Detection is deliberately independent per issue, so a
 * value carrying two defects reports both - a token that is BOTH quoted and
 * BOM-prefixed is an entirely plausible copy/paste, and the second defect would
 * otherwise only surface on the next deploy.
 */
export function inspectEnvValue(name: string, raw: string | undefined): EnvHygieneFinding {
  if (raw === undefined || raw === '') {
    return { name, present: false, length: 0, issues: [] };
  }

  const issues: EnvIssueCode[] = [];

  if (raw.includes(BOM)) issues.push('bom');
  if (/[\r\n]/.test(raw)) issues.push('crlf');

  // Wrapping whitespace is judged on the value with BOM and line terminators
  // already removed, so a leading BOM reports as `bom` alone rather than as
  // `bom` + `whitespace`. (`String.prototype.trim` treats U+FEFF as whitespace.)
  const core = raw.replace(BOM_OR_EOL_RE, '');
  if (core !== core.trim()) issues.push('whitespace');

  if (NBSP_RE.test(raw)) issues.push('nbsp');

  const trimmed = core.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed[0] === trimmed[trimmed.length - 1]
  ) {
    // `KEY="value"` pasted into a dashboard that does not strip quotes. The
    // quotes reach the API verbatim and the credential is rejected as malformed.
    issues.push('quoted');
  }

  if (CONTROL_RE.test(raw)) issues.push('control');

  return { name, present: true, length: raw.length, issues };
}

/**
 * The only rendering of a variable that may ever reach a log or an HTTP
 * response: `MISSING`, `set (len 64)`, or `set (len 65) - has BOM`.
 */
export function describeEnvFinding(finding: EnvHygieneFinding): string {
  if (!finding.present) return 'MISSING';
  const base = `set (len ${finding.length})`;
  if (finding.issues.length === 0) return base;
  return `${base} - ${finding.issues.map((issue) => ISSUE_LABELS[issue]).join(', ')}`;
}

export interface EnvVarSpec {
  name: string;
  /**
   * True when an unset value in production is an ERROR (a product is silently
   * off) rather than information. Being unset is never fatal on its own - Joi
   * already hard-fails the boot for the handful that cannot be missing at all.
   */
  requiredInProduction?: boolean;
  /** What breaks, silently, when this one is wrong. Printed in the block. */
  impact: string;
}

/**
 * The critical list. Membership means "a wrong value here fails silently in
 * production", not "important". Variables whose absence is loud on first use,
 * and therefore self-reporting, are deliberately left out.
 */
export const CRITICAL_ENV_VARS: EnvVarSpec[] = [
  { name: 'DATABASE_URL', requiredInProduction: true, impact: 'every request' },
  {
    name: 'JWT_SECRET',
    requiredInProduction: true,
    impact: 'all website auth (secret is shared with NextAuth)',
  },
  { name: 'INTERNAL_API_KEY', impact: 'oauth-upsert falls back to comparing against JWT_SECRET' },

  {
    name: 'WEB_ORIGIN',
    requiredInProduction: true,
    impact: 'canonical origin of every emailed link + first CORS entry',
  },
  { name: 'CORS_ORIGINS', impact: 'additive browser allow-list' },

  { name: 'R2_ACCOUNT_ID', requiredInProduction: true, impact: 'all object storage' },
  { name: 'R2_ACCESS_KEY_ID', requiredInProduction: true, impact: 'all object storage' },
  { name: 'R2_SECRET_ACCESS_KEY', requiredInProduction: true, impact: 'all object storage' },
  { name: 'R2_BUCKET', requiredInProduction: true, impact: 'report PDFs + report photos' },
  {
    name: 'R2_KYC_BUCKET',
    requiredInProduction: true,
    impact: 'identity documents land in the shared reports bucket',
  },
  {
    name: 'R2_KYC_ACCESS_KEY_ID',
    requiredInProduction: true,
    impact: 'identity documents land in the shared reports bucket',
  },
  {
    name: 'R2_KYC_SECRET_ACCESS_KEY',
    requiredInProduction: true,
    impact: 'identity documents land in the shared reports bucket',
  },
  { name: 'R2_PUBLIC_BUCKET', impact: 'showroom photos fall back to signed URLs' },
  { name: 'R2_PUBLIC_BASE_URL', impact: 'showroom photos fall back to signed URLs' },
  { name: 'R2_PUBLIC_ACCESS_KEY_ID', impact: 'showroom photos fall back to signed URLs' },
  { name: 'R2_PUBLIC_SECRET_ACCESS_KEY', impact: 'showroom photos fall back to signed URLs' },

  {
    name: 'STRIPE_SECRET_KEY',
    requiredInProduction: true,
    impact: 'Stripe silently runs in MOCK mode - no money moves',
  },
  { name: 'STRIPE_PUBLISHABLE_KEY', impact: 'client-side Stripe elements' },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    requiredInProduction: true,
    impact: 'paid orders never advance past PENDING',
  },
  {
    /*
     * The CONNECT endpoint signs with a secret of its own, and a byte-order
     * mark in front of it is invisible everywhere except here.
     *
     * The startup check beside this list reports the secret when it is EMPTY.
     * It cannot report a value that is perfect apart from three bytes the
     * terminal does not draw - and such a value fails every signature, which
     * is the same outcome as no secret at all: no inspector becomes eligible
     * for an order. That is the defect DEN-235 corrects, and leaving this
     * variable out of the list is how it would come back.
     */
    name: 'STRIPE_CONNECT_WEBHOOK_SECRET',
    requiredInProduction: true,
    impact: 'account.updated is refused, so no inspector becomes eligible for an order',
  },
  { name: 'STRIPE_CONNECT_REFRESH_URL', impact: 'inspector Connect onboarding' },
  { name: 'STRIPE_CONNECT_RETURN_URL', impact: 'inspector Connect onboarding' },

  {
    name: 'MAPBOX_TOKEN',
    requiredInProduction: true,
    impact: 'geocoding 401s and the order form rejects valid addresses',
  },

  {
    name: 'RESEND_API_KEY',
    requiredInProduction: true,
    impact: 'email falls back to the dev outbox - verification mail is never sent',
  },
  { name: 'EMAIL_FROM', impact: 'sender of every transactional email' },

  { name: 'REDIS_URL', impact: 'link-codes fall back to in-memory (breaks multi-instance)' },
  { name: 'SENTRY_DSN', impact: 'errors are never reported' },
];

export function inspectCriticalEnv(
  env: NodeJS.ProcessEnv = process.env,
  specs: EnvVarSpec[] = CRITICAL_ENV_VARS,
): EnvHygieneFinding[] {
  return specs.map((spec) => inspectEnvValue(spec.name, env[spec.name]));
}
