import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UsersModule } from './users/users.module';
import { CatalogModule } from './catalog/catalog.module';
import { LinkCodesModule } from './link-codes/link-codes.module';
import { MeReportsModule } from './me-reports/me-reports.module';
import { PublicModule } from './public/public.module';
import { RedisModule } from './redis/redis.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { DeviceIdMiddleware } from './common/middleware/device-id.middleware';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { GeoModule } from './geo/geo.module';
import { HealthModule } from './health/health.module';
import { InspectorModule } from './inspector/inspector.module';
import { KycModule } from './kyc/kyc.module';
import { LegalModule } from './legal/legal.module';
import { ListingsModule } from './listings/listings.module';
import { MeModule } from './me/me.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { QuotaModule } from './quota/quota.module';
import { R2Module } from './r2/r2.module';
import { ReportsModule } from './reports/reports.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SettingsModule } from './settings/settings.module';
import { VinModule } from './vin/vin.module';
import { VinHistoryModule } from './vin-history/vin-history.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        // 'default' is referenced by name in @Throttle() decorators across
        // auth.controller.ts and reports.controller.ts — do not rename it.
        { name: 'default', ttl: 60_000, limit: 120 },
        // Tighter bucket for unauthenticated lookups that take a VIN or report
        // code and answer "does this exist?". 122 bits of entropy already makes
        // enumeration impractical; this stops it being the only defence.
        { name: 'lookup', ttl: 60_000, limit: 20 },
      ],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    GeoModule,
    AuthModule,
    UsersModule,
    R2Module,
    HealthModule,
    VinModule,
    VinHistoryModule,
    QuotaModule,
    ReportsModule,
    MeModule,
    MeReportsModule,
    NotificationsModule,
    PaymentsModule,
    InspectorModule,
    KycModule,
    OrdersModule,
    ListingsModule,
    LinkCodesModule,
    PublicModule,
    AdminModule,
    LegalModule,
    CatalogModule,
    SettingsModule,
    SchedulerModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // Guard order: throttle → authenticate (/api/v1 only) → authorize roles.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DeviceIdMiddleware).forRoutes('*');
  }
}
