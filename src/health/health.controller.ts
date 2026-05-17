import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private requireDebugEnabled(): void {
    if ((process.env.SENTRY_TEST_ENABLED ?? '').toLowerCase() !== 'true') {
      throw new NotFoundException();
    }
  }

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
