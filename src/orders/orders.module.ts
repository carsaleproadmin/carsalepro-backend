import { Module } from '@nestjs/common';
import { LegalModule } from '../legal/legal.module';
import { PaymentsModule } from '../payments/payments.module';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  // LegalModule is imported one-way (it must NOT import OrdersModule) so the
  // ASSIGNED hook can generate the per-order contract without a dependency cycle.
  imports: [PaymentsModule, LegalModule],
  controllers: [OrdersController, OffersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
