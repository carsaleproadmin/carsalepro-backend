import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
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
