import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig } from '../config/configuration';
import { FONT_MANIFEST } from '../fonts/fonts.manifest';
import { R2Service } from '../r2/r2.service';
import {
  CRITICAL_ENV_VARS,
  EnvHygieneFinding,
  describeEnvFinding,
  inspectEnvValue,
} from './env-hygiene';

/**
 * Boot-time self-check: one pass, one greppable block in the deploy log.
 *
 * WHY. The 2026-08 audit found nine blocking production defects. FOUR of them
 * were environment settings, and not one failed a build, a test or a health
 * check:
 *
 *   - a UTF-8 BOM inside the Vercel Mapbox token made every geocode 401, so the
 *     order form told users their valid address did not exist;
 *   - the production CORS allow-list held exactly one origin, so signup,
 *     password reset and email verification were all blocked from the real
 *     domain;
 *   - `R2_KYC_*` was unset, so identity documents landed in the same bucket as
 *     the paid report PDFs.
 *
 * Every one of them was silent. This service makes them loud, once, at boot.
 *
 * WHY `OnApplicationBootstrap` AND NOT `OnModuleInit`. `R2Service` builds its
 * three S3 clients in its own `onModuleInit`; Nest runs every module's
 * `onModuleInit` before any `onApplicationBootstrap`, so this is the earliest
 * hook from which `headBucket()` is guaranteed to have a client to talk to.
 *
 * WHERE THE FATAL LINE IS DRAWN. Fatal is reserved for SILENTLY WRONG
 * BEHAVIOUR - a BOM in a secret, identity documents in the wrong bucket, a CORS
 * list that blocks registration. A third party being briefly unreachable is NOT
 * fatal: Render would loop the deploy while everything else works fine, which
 * turns a Stripe blip into a full outage. Those are logged as errors and the
 * boot continues.
 *
 * NOTHING HERE EVER PRINTS A VALUE. Only `set (len 64)`, `MISSING` or
 * `has BOM`. A self-check that leaks `JWT_SECRET` into the deploy log is worse
 * than the defect it reports.
 */

export type Severity = 'ok' | 'info' | 'warn' | 'error' | 'fatal';

export interface StartupFinding {
  /** Stable dotted id, e.g. `r2.kyc`. Safe to alert on. */
  id: string;
  severity: Severity;
  /** Secret-free, one line. */
  message: string;
  /** Set when strict mode or a non-production environment downgraded this. */
  downgradedFrom?: Severity;
}

export interface StartupCheckReport {
  checkedAt: string;
  nodeEnv: string;
  strict: boolean;
  /** `ok` | `degraded` (>=1 error) | `fail` (>=1 fatal). */
  status: 'ok' | 'degraded' | 'fail';
  counts: { fatal: number; error: number; warn: number; info: number };
  findings: StartupFinding[];
  /** `NAME: set (len 64)` lines - the same strings that go to the log. */
  env: Array<{ name: string; description: string; issues: string[] }>;
  durationMs: number;
}

/** Thrown from the bootstrap hook when a strict production boot must not proceed. */
export class StartupCheckFailedError extends Error {
  constructor(readonly report: StartupCheckReport) {
    super(
      `Startup self-check failed with ${report.counts.fatal} fatal finding(s): ` +
        report.findings
          .filter((f) => f.severity === 'fatal')
          .map((f) => f.id)
          .join(', '),
    );
    this.name = 'StartupCheckFailedError';
  }
}

export interface SeverityContext {
  production: boolean;
  strict: boolean;
}

/**
 * The whole fatal/non-fatal policy, in one pure function.
 *
 * - Non-fatal severities are never escalated. A degraded third party stays an
 *   error no matter how strict the environment is.
 * - Outside production nothing is fatal. Every developer machine and every CI
 *   run has a shared KYC bucket and no Stripe key; killing those boots would
 *   only teach people to switch the check off.
 * - `STARTUP_CHECK_STRICT=false` in production downgrades fatal to error. That
 *   is the emergency exit for the day a check itself is wrong and the service
 *   has to come up anyway - and its use is logged loudly.
 */
export function resolveSeverity(intended: Severity, ctx: SeverityContext): Severity {
  if (intended !== 'fatal') return intended;
  if (!ctx.production) return 'warn';
  if (!ctx.strict) return 'error';
  return 'fatal';
}

interface RawFinding {
  id: string;
  /** Severity this finding carries in a strict production boot. */
  intended: Severity;
  message: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

@Injectable()
export class StartupCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger('StartupCheck');
  private report: StartupCheckReport | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly r2: R2Service,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const report = await this.run();
    this.report = report;
    this.print(report);
    if (report.counts.fatal > 0) {
      // Nest surfaces this out of `app.init()`; `main.ts` logs it and exits 1.
      // A service that will not start is a page in the deploy log. The defects
      // this replaces were not.
      throw new StartupCheckFailedError(report);
    }
  }

  /** The last completed run, or null before the bootstrap hook has finished. */
  getReport(): StartupCheckReport | null {
    return this.report;
  }

  async run(): Promise<StartupCheckReport> {
    const startedAt = Date.now();
    const nodeEnv = this.config.get('nodeEnv', { infer: true });
    const startup = this.config.get('startupCheck', { infer: true });
    const production = nodeEnv === 'production';
    const ctx: SeverityContext = { production, strict: startup.strict };

    const raw: RawFinding[] = [];
    const env = this.checkEnvHygiene(raw, production);

    this.checkCors(raw, production);
    await this.checkReportsBucket(raw);
    await this.checkKycBucket(raw, startup.allowSharedKycBucket);
    await this.checkPublicBucket(raw);
    await this.checkStripe(raw, production);
    await this.checkMapbox(raw, production);
    this.checkIap(raw);
    await this.checkFonts(raw);

    const findings: StartupFinding[] = raw.map((finding) => {
      const severity = resolveSeverity(finding.intended, ctx);
      return {
        id: finding.id,
        severity,
        message: finding.message,
        ...(severity === finding.intended ? {} : { downgradedFrom: finding.intended }),
      };
    });

    const counts = {
      fatal: findings.filter((f) => f.severity === 'fatal').length,
      error: findings.filter((f) => f.severity === 'error').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };

    return {
      checkedAt: new Date().toISOString(),
      nodeEnv,
      strict: startup.strict,
      status: counts.fatal > 0 ? 'fail' : counts.error > 0 ? 'degraded' : 'ok',
      counts,
      findings,
      env,
      durationMs: Date.now() - startedAt,
    };
  }

  // ==========================================================================
  // Checks
  // ==========================================================================

  /**
   * Every critical variable, inspected for the defects that survive a Joi
   * schema: a BOM, a stray CR from a Windows paste, wrapping whitespace, a
   * non-breaking space, or the quotes a dashboard did not strip. The value that
   * results is a *valid non-empty string* and is rejected by the API it is sent
   * to - the exact shape of the Mapbox defect.
   */
  private checkEnvHygiene(
    raw: RawFinding[],
    production: boolean,
  ): StartupCheckReport['env'] {
    const rows: StartupCheckReport['env'] = [];

    for (const spec of CRITICAL_ENV_VARS) {
      const finding: EnvHygieneFinding = inspectEnvValue(spec.name, process.env[spec.name]);
      rows.push({
        name: spec.name,
        description: describeEnvFinding(finding),
        issues: finding.issues,
      });

      if (finding.issues.length > 0) {
        raw.push({
          id: 'env.hygiene',
          intended: 'fatal',
          message:
            `${spec.name} ${describeEnvFinding(finding)}. It will be sent verbatim and ` +
            `rejected: ${spec.impact}. Re-paste the value with no BOM, quotes or trailing newline.`,
        });
        continue;
      }

      if (!finding.present && spec.requiredInProduction) {
        // Missing is loud enough as an error: it is visible in every dashboard,
        // unlike a BOM. Fatal is reserved for values that LOOK right.
        raw.push({
          id: 'env.missing',
          intended: production ? 'error' : 'info',
          message: `${spec.name} is MISSING - ${spec.impact}.`,
        });
      }
    }

    return rows;
  }

  /**
   * At least one `https://` origin must be allowed, or every browser call from
   * the real domain fails preflight while the API answers perfectly to curl.
   * That is F-01: the production list held exactly one origin and it was not
   * the production domain, so signup, password reset and email verification
   * were all dead and nothing logged an error.
   *
   * Origins are public information - printing them is the whole point.
   */
  private checkCors(raw: RawFinding[], production: boolean): void {
    const web = this.config.get('web', { infer: true });
    const origins = web.corsOrigins ?? [];
    const secure = origins.filter((origin) => origin.startsWith('https://'));

    if (production && secure.length === 0) {
      raw.push({
        id: 'cors',
        intended: 'fatal',
        message:
          `CORS allow-list has no https:// origin (${origins.length} entr${origins.length === 1 ? 'y' : 'ies'}: ` +
          `${origins.join(', ') || 'empty'}). Every browser call from the live site would be blocked. ` +
          'Set WEB_ORIGIN and add the rest to CORS_ORIGINS.',
      });
      return;
    }

    raw.push({
      id: 'cors',
      intended: 'info',
      message: `CORS allow-list (${origins.length}): ${origins.join(', ') || 'empty'}`,
    });
  }

  private async checkReportsBucket(raw: RawFinding[]): Promise<void> {
    if (!this.r2.isConfigured()) {
      raw.push({
        id: 'r2.reports',
        intended: 'fatal',
        message: 'R2 is not configured - report PDFs, photos and contracts cannot be stored.',
      });
      return;
    }
    if (this.skipNetwork()) {
      raw.push({ id: 'r2.reports', intended: 'info', message: this.skipMessage('HeadBucket') });
      return;
    }
    try {
      await withTimeout(this.r2.headBucket(), 5000, 'R2 HeadBucket');
      raw.push({
        id: 'r2.reports',
        intended: 'info',
        message: `reports bucket ${this.r2.bucketName} answers HeadBucket`,
      });
    } catch (err) {
      raw.push({
        id: 'r2.reports',
        intended: 'fatal',
        message: `reports bucket ${this.r2.bucketName} does not answer HeadBucket: ${errorText(err)}`,
      });
    }
  }

  /**
   * The KYC bucket must exist, answer, and NOT be the reports bucket.
   *
   * ORDERING IS NOW STRICT, AND THIS DELIBERATELY REVERSES AN EARLIER DECISION.
   * `env.validation.ts` still carries a comment arguing that `R2_KYC_*` must not
   * fail the boot, because taking the service down would be worse than an
   * un-isolated bucket. That was written before anyone knew that in production
   * the variables were unset and identity documents really had landed in the
   * shared reports bucket - the very scenario the guard removed in commit
   * `547d451` used to prevent. Passport scans sitting beside objects that a
   * single misconfigured `R2_PUBLIC_URL` would publish is not a smaller failure
   * than a refused deploy; it is a larger one that nobody sees.
   *
   * So: set `R2_KYC_BUCKET`, `R2_KYC_ACCESS_KEY_ID` and
   * `R2_KYC_SECRET_ACCESS_KEY` on Render BEFORE deploying this, or the boot
   * fails. The two escape hatches are `ALLOW_SHARED_KYC_BUCKET=true` (an
   * explicit, logged acknowledgement that documents share the reports bucket)
   * and `STARTUP_CHECK_STRICT=false`.
   */
  private async checkKycBucket(raw: RawFinding[], allowShared: boolean): Promise<void> {
    const dedicated = this.r2.isKycDedicated();

    if (!dedicated) {
      raw.push({
        id: 'r2.kyc',
        intended: allowShared ? 'warn' : 'fatal',
        message: allowShared
          ? `KYC documents share the reports bucket ${this.r2.bucketName} - waived by ` +
            'ALLOW_SHARED_KYC_BUCKET=true. Identity documents sit beside paid report PDFs (SECURITY.md H2).'
          : 'R2_KYC_* is not configured, so identity documents would be written to the shared ' +
            `reports bucket ${this.r2.bucketName}. Set R2_KYC_BUCKET / R2_KYC_ACCESS_KEY_ID / ` +
            'R2_KYC_SECRET_ACCESS_KEY, or acknowledge it with ALLOW_SHARED_KYC_BUCKET=true.',
      });
      return;
    }

    if (this.r2.kycBucketName === this.r2.bucketName) {
      raw.push({
        id: 'r2.kyc',
        intended: allowShared ? 'warn' : 'fatal',
        message:
          `R2_KYC_BUCKET is the reports bucket (${this.r2.bucketName}). The dedicated token is ` +
          'pointed at the wrong bucket, so the isolation is nominal only.',
      });
      return;
    }

    if (this.skipNetwork()) {
      raw.push({
        id: 'r2.kyc',
        intended: 'info',
        message: `KYC bucket ${this.r2.kycBucketName} is dedicated; ${this.skipMessage('HeadBucket')}`,
      });
      return;
    }

    try {
      await withTimeout(this.r2.kycHeadBucket(), 5000, 'R2 KYC HeadBucket');
      raw.push({
        id: 'r2.kyc',
        intended: 'info',
        message: `KYC bucket ${this.r2.kycBucketName} is dedicated and answers HeadBucket`,
      });
    } catch (err) {
      raw.push({
        id: 'r2.kyc',
        intended: 'fatal',
        message:
          `KYC bucket ${this.r2.kycBucketName} does not answer HeadBucket: ${errorText(err)}. ` +
          'Uploads would fail or fall back to the wrong bucket.',
      });
    }
  }

  /**
   * Not fatal by design: an unreachable public bucket degrades showroom photos
   * to signed URLs, which is the pre-2026-08 behaviour and hurts nobody's
   * privacy or money.
   */
  private async checkPublicBucket(raw: RawFinding[]): Promise<void> {
    if (!this.r2.isPublicBucketConfigured()) {
      raw.push({
        id: 'r2.public',
        intended: 'info',
        message: 'public bucket not configured - listing photos are served through signed URLs',
      });
      return;
    }
    if (this.skipNetwork()) {
      raw.push({ id: 'r2.public', intended: 'info', message: this.skipMessage('HeadBucket') });
      return;
    }
    try {
      await withTimeout(this.r2.publicHeadBucket(), 5000, 'R2 public HeadBucket');
      raw.push({
        id: 'r2.public',
        intended: 'info',
        message: `public bucket ${this.r2.publicBucketName} answers HeadBucket`,
      });
    } catch (err) {
      raw.push({
        id: 'r2.public',
        intended: 'error',
        message: `public bucket ${this.r2.publicBucketName} does not answer HeadBucket: ${errorText(err)}`,
      });
    }
  }

  /**
   * A live credential check, not a ping: `accounts.retrieve()` is rejected by a
   * revoked, truncated or test-mode-in-production key, which is exactly the
   * class of defect a health check cannot see. Never fatal - Stripe being
   * briefly unreachable must not loop the deploy.
   */
  private async checkStripe(raw: RawFinding[], production: boolean): Promise<void> {
    const { secretKey, webhookSecret, connectWebhookSecret } = this.config.get('stripe', {
      infer: true,
    });

    /*
     * The two webhook secrets are checked BEFORE the key, because their
     * failure is silent in a way the key's is not.
     *
     * A missing platform secret refuses payment events; a missing Connect
     * secret refuses `account.updated`, which is the only event that sets
     * `stripeOnboarded` - so no inspector becomes eligible for an order, the
     * dispatch finds nobody, and every surface reports the truth it was given.
     * Nothing raises its voice. The dashboard shows the refusals, and only if
     * somebody opens it.
     *
     * They must also be DIFFERENT. Stripe issues one secret per endpoint, so
     * the same value in both means one endpoint was read twice - which is the
     * defect this check was written for, back in the shape where both
     * endpoints pointed at one route.
     */
    if (secretKey && production) {
      if (!webhookSecret) {
        raw.push({
          id: 'stripe',
          intended: 'error',
          message: 'STRIPE_WEBHOOK_SECRET is unset - payment events are refused unverified.',
        });
      }
      if (!connectWebhookSecret) {
        raw.push({
          id: 'stripe',
          intended: 'error',
          message:
            'STRIPE_CONNECT_WEBHOOK_SECRET is unset - account.updated is refused, so no ' +
            'inspector becomes eligible for an order.',
        });
      } else if (connectWebhookSecret === webhookSecret) {
        raw.push({
          id: 'stripe',
          intended: 'error',
          message:
            'STRIPE_CONNECT_WEBHOOK_SECRET equals STRIPE_WEBHOOK_SECRET - Stripe gives each ' +
            'endpoint its own, so one of the two endpoints is refusing every event.',
        });
      }
    }

    if (!secretKey) {
      raw.push({
        id: 'stripe',
        intended: production ? 'error' : 'info',
        message: production
          ? 'STRIPE_SECRET_KEY is unset - Stripe runs in MOCK mode and no money moves.'
          : 'Stripe runs in mock mode (no key).',
      });
      return;
    }
    if (this.skipNetwork()) {
      raw.push({ id: 'stripe', intended: 'info', message: this.skipMessage('accounts.retrieve') });
      return;
    }

    const livemode = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
    if (production && !livemode) {
      raw.push({
        id: 'stripe',
        intended: 'error',
        message: 'STRIPE_SECRET_KEY is a TEST-mode key in production - real payments will not be taken.',
      });
    }

    try {
      const client = new Stripe(secretKey, { timeout: 3000, maxNetworkRetries: 0 });
      // `null` is stripe-node for "the account this key belongs to" - the
      // typings require the argument even though the wire call is GET /v1/account.
      const account = await withTimeout(
        client.accounts.retrieve(null),
        3000,
        'Stripe accounts.retrieve',
      );
      raw.push({
        id: 'stripe',
        intended: 'info',
        message: `Stripe reachable (account ${account.id}, ${livemode ? 'live' : 'test'} mode)`,
      });
    } catch (err) {
      raw.push({
        id: 'stripe',
        intended: 'error',
        message: `Stripe accounts.retrieve failed: ${errorText(err)}`,
      });
    }
  }

  /**
   * `GET /tokens/v2` validates the token itself and answers 401 for the exact
   * defect that shipped: a BOM in front of an otherwise perfect token. The env
   * hygiene check catches that one before the network is touched; this catches
   * the ones it cannot see - revoked, URL-restricted, or scoped without
   * `geocoding:read`.
   *
   * The token is a query parameter, so the URL itself is a secret. It is never
   * logged, and neither is the response body.
   */
  private async checkMapbox(raw: RawFinding[], production: boolean): Promise<void> {
    const { token } = this.config.get('mapbox', { infer: true });

    if (!token) {
      raw.push({
        id: 'mapbox',
        intended: production ? 'error' : 'info',
        message: production
          ? 'MAPBOX_TOKEN is unset - address lookup on the order form cannot work.'
          : 'Mapbox not configured (geocoding disabled).',
      });
      return;
    }
    if (this.skipNetwork()) {
      raw.push({ id: 'mapbox', intended: 'info', message: this.skipMessage('tokens/v2') });
      return;
    }

    try {
      const url = `https://api.mapbox.com/tokens/v2?access_token=${encodeURIComponent(token)}`;
      const res = await withTimeout(fetch(url), 2000, 'Mapbox tokens/v2');
      if (res.ok) {
        raw.push({ id: 'mapbox', intended: 'info', message: 'Mapbox token validated (tokens/v2 200)' });
      } else {
        raw.push({
          id: 'mapbox',
          intended: 'error',
          message:
            `Mapbox tokens/v2 answered ${res.status} - the token is rejected. Every geocode will ` +
            'fail and the order form will tell users their valid address does not exist. ' +
            '(401 with a syntactically fine token usually means an invisible BOM or wrapping quotes.)',
        });
      }
    } catch (err) {
      raw.push({
        id: 'mapbox',
        intended: 'error',
        message: `Mapbox tokens/v2 unreachable: ${errorText(err)}`,
      });
    }
  }

  /** Informational: which provenance provider is live, and whether it may sell. */
  /**
   * `IAP_BUNDLE_ID` defaulted to `com.carsalepro.app` — a package that has never
   * existed — against the shipped `us.designkey.carsalepro`, and because
   * `GOOGLE_PLAY_PACKAGE_NAME` falls through to it, BOTH Apple and Google
   * server-side validation pointed at nothing. It was invisible because
   * `IAP_VALIDATION_MODE` defaults to `client-trust`, which never contacts a
   * store: the mismatch only bites the day somebody sets `server`, which is
   * exactly when nobody is looking for a config fault.
   *
   * This used to be FATAL in `server` mode, and that was the wrong lever. The
   * retired package cannot ever be a correct answer, so `configuration.ts` now
   * ignores it and resolves the shipped id instead; a value nothing reads is
   * worth a WARNING, not a refusal that takes the whole API down over a
   * mobile-only setting and can only be cleared from a dashboard. The warning
   * names both variables so the environment still gets cleaned up, and it is
   * raised in `client-trust` mode too — the variable is equally stale there, and
   * only the consequence differs.
   *
   * It also reports the product ids Play is told are subscriptions, because PRO
   * became a one-time managed product on 2026-08-19 and listing its id there
   * routes the validation to `/purchases/subscriptions/`, where Play answers
   * 404.
   */
  private checkIap(raw: RawFinding[]): void {
    // Read defensively. A self-check that THROWS takes the boot down for a
    // reason it was written to report, which is the one failure mode it must
    // not have — and the spec's config double carries only the blocks each case
    // exercises.
    const iap = this.config.get('iap', { infer: true }) as
      | {
          mode?: string;
          bundleId?: string;
          retiredBundleIdInEnv?: boolean;
          google?: { packageName?: string; subscriptionProductIds?: string[] };
        }
      | undefined;
    if (!iap) return;
    const subs = iap.google?.subscriptionProductIds ?? [];

    if (iap.retiredBundleIdInEnv) {
      raw.push({
        id: 'iap.bundle',
        intended: 'warn',
        message:
          'IAP_BUNDLE_ID / GOOGLE_PLAY_PACKAGE_NAME still holds the retired ' +
          'com.carsalepro.app, a package that has never existed. It is IGNORED ' +
          `and ${iap.bundleId} is used instead - clear the variable so the ` +
          'environment stops describing a store nobody publishes to.',
      });
    }

    const lifetimeAsSub = subs.includes('carsalepro_pro_lifetime');
    raw.push({
      id: 'iap',
      intended: lifetimeAsSub ? 'warn' : 'info',
      message:
        `IAP mode=${iap.mode} bundleId=${iap.bundleId} ` +
        `googlePackage=${iap.google?.packageName} ` +
        `subscriptionIds=[${subs.join(', ')}]` +
        (lifetimeAsSub
          ? ' - carsalepro_pro_lifetime is a one-time managed product and must ' +
            'NOT be listed as a subscription; Play answers 404 for it there.'
          : ''),
    });
  }

  /**
   * Informational: a missing CJK font pack does not break a report, it makes
   * one locale's report render with invisible text - which is why it is worth a
   * line in the boot log even though it must never stop a deploy.
   */
  private async checkFonts(raw: RawFinding[]): Promise<void> {
    if (!this.r2.isConfigured() || this.skipNetwork()) {
      raw.push({
        id: 'fonts',
        intended: 'info',
        message: `${FONT_MANIFEST.length} CJK font files declared; ${this.skipMessage('HeadObject')}`,
      });
      return;
    }
    try {
      const present = await withTimeout(
        Promise.all(FONT_MANIFEST.map((font) => this.r2.objectExists(font.key))),
        5000,
        'font manifest HeadObject',
      );
      const missing = FONT_MANIFEST.filter((_font, i) => !present[i]).map((font) => font.name);
      raw.push({
        id: 'fonts',
        intended: 'info',
        message:
          `CJK PDF fonts ${present.filter(Boolean).length}/${FONT_MANIFEST.length} present` +
          (missing.length > 0
            ? ` - missing ${missing.join(', ')} (those locales render with invisible text; ` +
              'run scripts/upload-fonts.ts)'
            : ''),
      });
    } catch (err) {
      raw.push({
        id: 'fonts',
        intended: 'info',
        message: `CJK PDF font check skipped: ${errorText(err)}`,
      });
    }
  }

  // ==========================================================================
  // Output
  // ==========================================================================

  /**
   * Network probes are skipped under `NODE_ENV=test`. The e2e suite builds the
   * whole application graph 22 times against real R2 credentials; probing on
   * each would add minutes and make green depend on Cloudflare's uptime.
   */
  private skipNetwork(): boolean {
    return this.config.get('nodeEnv', { infer: true }) === 'test';
  }

  private skipMessage(what: string): string {
    return `${what} skipped (NODE_ENV=test)`;
  }

  private print(report: StartupCheckReport): void {
    const compact =
      `STARTUP_CHECK status=${report.status} fatal=${report.counts.fatal} ` +
      `error=${report.counts.error} warn=${report.counts.warn} strict=${report.strict} ` +
      `env=${report.nodeEnv} ms=${report.durationMs}`;

    if (report.nodeEnv === 'test') {
      this.logger.debug(compact);
      return;
    }

    const lines: string[] = [
      '',
      `===== STARTUP SELF-CHECK (${report.nodeEnv}${report.strict ? '' : ', NON-STRICT'}) =====`,
    ];
    for (const row of report.env) {
      lines.push(`  env  ${row.name.padEnd(30)} ${row.description}`);
    }
    lines.push('  ---');
    for (const finding of report.findings) {
      const tag = finding.severity.toUpperCase().padEnd(5);
      const downgrade = finding.downgradedFrom ? ` (downgraded from ${finding.downgradedFrom})` : '';
      lines.push(`  ${tag} ${finding.id.padEnd(12)} ${finding.message}${downgrade}`);
    }
    lines.push(`===== ${compact} =====`);
    const block = lines.join('\n');

    if (report.counts.fatal > 0) {
      this.logger.error(block);
    } else if (report.counts.error > 0) {
      this.logger.warn(block);
    } else {
      this.logger.log(block);
    }

    // The override is louder than the block it modifies: whoever set it moved
    // on, and the next person reading this log has to know the guard is off.
    if (!report.strict) {
      const downgraded = report.findings.filter((f) => f.downgradedFrom === 'fatal').length;
      this.logger.warn(
        `STARTUP_CHECK_STRICT=false - the boot-time guard is DISABLED. ${downgraded} fatal ` +
          'finding(s) were downgraded to errors and the service started with known-broken ' +
          'configuration. Fix the findings above and remove the override.',
      );
    }
  }
}
