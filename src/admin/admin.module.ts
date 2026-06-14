import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { ListingsModule } from '../listings/listings.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminLegalController } from './admin-legal.controller';
import { AdminLegalService } from './admin-legal.service';
import { AdminListingsController } from './admin-listings.controller';
import { AdminListingsService } from './admin-listings.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Epic E9 — admin panel backend. SettingsModule + PrismaModule are @Global, so
 * SettingsService / PrismaService are injectable without importing them here.
 * The imported feature modules export the services the admin controllers reuse.
 */
@Module({
  imports: [UsersModule, OrdersModule, PaymentsModule, ListingsModule, KycModule],
  controllers: [
    AdminUsersController,
    AdminOrdersController,
    AdminListingsController,
    AdminSettingsController,
    AdminLegalController,
    AdminFinanceController,
    AdminDashboardController,
    AdminAuditController,
  ],
  providers: [
    AdminAuditService,
    AdminUsersService,
    AdminOrdersService,
    AdminListingsService,
    AdminLegalService,
    AdminFinanceService,
    AdminDashboardService,
  ],
})
export class AdminModule {}
