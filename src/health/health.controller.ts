import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfig } from '../config/configuration';
import {
  captureMessageIfEnabled,
  flushSentry,
} from '../common/sentry/sentry.bootstrap';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { StartupCheckService } from './startup-check.service';

/**
 * `GET /health/startup`. The summary half is safe for an anonymous caller; the
 * detail half only ships outside production or to a caller holding the internal
 * key.
 */
export interface StartupSummaryResponse {
  status: 'ok' | 'degraded' | 'fail' | 'pending';
  checkedAt: string | null;
  nodeEnv?: string;
  counts?: { fatal: number; error: number; warn: number; info: number };
  /** True when the caller was not entitled to the per-finding detail. */
  detailsWithheld?: boolean;
  strict?: boolean;
  durationMs?: number;
  findings?: Array<{ id: string; severity: string; message: string; downgradedFrom?: string }>;
  env?: Array<{ name: string; description: string; issues: string[] }>;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly startup: StartupCheckService,
  ) {}

  private requireDebugEnabled(): void {
    if ((process.env.SENTRY_TEST_ENABLED ?? '').toLowerCase() !== 'true') {
      throw new NotFoundException();
    }
  }

  /**
   * `healthCheckPath` in render.yaml. DO NOT add third-party probes here: a
   * Mapbox or Stripe outage must not pull the service out of rotation, and a
   * configuration defect is a boot-time concern, not a liveness one. Everything
   * the 2026-08 audit asked for lives on `/health/startup` instead.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness + dependencies probe' })
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      async (): Promise<HealthIndicatorResult> => {
        if (!this.r2.isConfigured()) {
          return { r2: { status: 'up', mode: 'not_configured' } };
        }
        try {
          await this.r2.headBucket();
          return { r2: { status: 'up', bucket: this.r2.bucketName } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown';
          return { r2: { status: 'down', error: msg } };
        }
      },
    ]);
  }

  /**
   * The result of the boot-time self-check, as computed once at startup.
   *
   * ALWAYS 200, deliberately. This is a diagnostic, not a probe: a non-200 here
   * would be a second thing that could take the service out of rotation, and
   * the findings it reports are exactly the ones that do not warrant that.
   *
   * The findings name variables and describe defects; in production that detail
   * only goes to a caller presenting `x-internal-key`. It still never contains a
   * value - `describeEnvFinding` cannot emit one.
   */
  @Get('startup')
  @ApiOperation({ summary: 'Boot-time self-check result (always 200; details need x-internal-key)' })
  startupCheck(
    @Headers('x-internal-key') internalKey?: string,
  ): StartupSummaryResponse {
    const report = this.startup.getReport();
    if (!report) {
      // Only reachable if a request lands between listen() and the bootstrap
      // hook completing, which Nest does not do - but a diagnostic route that
      // can throw is a bad diagnostic route.
      return { status: 'pending', checkedAt: null };
    }

    const summary: StartupSummaryResponse = {
      status: report.status,
      checkedAt: report.checkedAt,
      nodeEnv: report.nodeEnv,
      counts: report.counts,
    };

    if (!this.maySeeDetails(internalKey)) {
      return { ...summary, detailsWithheld: true };
    }

    return {
      ...summary,
      strict: report.strict,
      durationMs: report.durationMs,
      findings: report.findings,
      env: report.env,
    };
  }

  /**
   * Outside production the detail is always visible - that is where it is used.
   * In production it takes `INTERNAL_API_KEY`; when that variable is unset the
   * detail is simply unavailable. There is no fallback to `JWT_SECRET` here
   * (unlike `auth/oauth-upsert`, which has one for backward compatibility):
   * spreading the signing secret across one more comparison to make a debug
   * view convenient is a bad trade.
   */
  private maySeeDetails(provided?: string): boolean {
    const expected = this.config.get('startupCheck', { infer: true }).internalKey;
    // Whenever a key is CONFIGURED it is required, whatever the environment.
    // The original rule keyed only on production, which left a staging or
    // preview deployment publishing bucket names, provider names and the LENGTH
    // of `JWT_SECRET` to anyone who asked — `/health` is outside the `/api/v1`
    // JWT scope, so there is nothing else in front of it. No value can leak
    // (`describeEnvFinding` structurally cannot emit one), but the length of a
    // signing secret is not nothing, and an environment that bothered to set a
    // key has said what it wants.
    if (!expected) {
      return this.config.get('nodeEnv', { infer: true }) !== 'production';
    }
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Sends an `info` message to Sentry. Returns the Sentry event id so callers
   * can confirm ingestion. Gated by SENTRY_TEST_ENABLED=true.
   */
  @Get('sentry-test')
  @ApiExcludeEndpoint()
  async sentryTest(): Promise<{ ok: boolean; eventId?: string; dsnConfigured: boolean }> {
    this.requireDebugEnabled();
    const dsn = this.config.get('sentry', { infer: true }).dsn;
    const eventId = captureMessageIfEnabled(
      `Sentry connectivity test from carsalepro-backend at ${new Date().toISOString()}`,
      'info',
    );
    await flushSentry();
    return { ok: true, eventId, dsnConfigured: Boolean(dsn) };
  }

  /**
   * Throws a synthetic 500 so the global exception filter forwards it to
   * Sentry. Gated by SENTRY_TEST_ENABLED=true.
   */
  @Get('sentry-throw')
  @ApiExcludeEndpoint()
  sentryThrow(): never {
    this.requireDebugEnabled();
    throw new Error(`carsalepro-backend sentry-throw at ${new Date().toISOString()}`);
  }
}
