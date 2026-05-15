import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
  ) {}

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
}
