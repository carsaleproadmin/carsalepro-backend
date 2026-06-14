/**
 * OPTIONAL SCALE-OUT PATH — not the default.
 *
 * By default the web service runs the scheduler IN-PROCESS (see
 * SchedulerModule wired into AppModule). This thin worker boots a standalone
 * Nest application context so the SAME scheduled services can run in a
 * dedicated Render worker process when the web tier needs to scale
 * horizontally (multiple web replicas must NOT each run the cron jobs).
 *
 * Go-live plan when you split the worker out:
 *   1. Deploy this entry (`npm run start:worker`) as a separate Render worker.
 *   2. Set SCHEDULER_ENABLED=false on the WEB service so only the worker runs
 *      the cron jobs (SchedulerService is gated on that flag).
 *   3. (Later) Move NotificationService dispatch to BullMQ for retry/backoff —
 *      see the TODO(scale-out) in NotificationsService.
 *
 * The application *context* (not an HTTP server) is enough: @nestjs/schedule
 * registers its timers on module init, so the @Cron jobs fire on the worker.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from '../app.module';

async function bootstrap(): Promise<void> {
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  appContext.enableShutdownHooks();
  Logger.log(
    `CarSalePro worker started (scheduler ${process.env.SCHEDULER_ENABLED === 'false' ? 'DISABLED' : 'ENABLED'})`,
    'Worker',
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal during worker bootstrap:', err);
  process.exit(1);
});
