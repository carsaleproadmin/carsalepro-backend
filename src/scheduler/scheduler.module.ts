import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { LegalModule } from '../legal/legal.module';
import { ListingsModule } from '../listings/listings.module';
import { OrdersModule } from '../orders/orders.module';
import { SchedulerService } from './scheduler.service';

/**
 * Hosts the in-process @Cron jobs. Imports the domain modules whose deferred
 * job methods it reuses. ScheduleModule.forRoot() is registered once in
 * AppModule. The jobs themselves are gated off in test / when
 * SCHEDULER_ENABLED=false (see SchedulerService).
 */
@Module({
  imports: [OrdersModule, ListingsModule, KycModule, LegalModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
