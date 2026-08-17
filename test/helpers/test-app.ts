import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Swap a provider out of the application graph for the duration of a suite.
 *
 * `token` is whatever `app.get()` would take — a class or an injection token.
 * Used by the VIN-history provider simulation to stand a fake data provider in
 * place of the built-in mock without touching `src/`.
 */
export interface ProviderOverride {
  token: unknown;
  useValue: unknown;
}

export async function createTestApp(
  overrides: ProviderOverride[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const { token, useValue } of overrides) {
    builder = builder.overrideProvider(token).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  // Mirror src/main.ts: rawBody for the Stripe webhook + raised JSON limit for
  // structured reportData payloads.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '6mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

export async function cleanDb(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  // Delete in FK-dependency order: rows referencing Report first, then Report.
  await prisma.reportPurchase.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.report.deleteMany();
  await prisma.deviceQuota.deleteMany();
  await prisma.vinCache.deleteMany();
}

export function uniqueDeviceId(prefix = 'test'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
