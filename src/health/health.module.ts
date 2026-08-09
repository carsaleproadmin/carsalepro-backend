import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { StartupCheckService } from './startup-check.service';

/**
 * `StartupCheckService` is registered here rather than in `app.module.ts` on
 * purpose: it needs no wiring beyond the globally-exported `ConfigService` and
 * `R2Service`, and keeping it inside the module that already owns the health
 * surface leaves the application root untouched.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [StartupCheckService],
  exports: [StartupCheckService],
})
export class HealthModule {}
