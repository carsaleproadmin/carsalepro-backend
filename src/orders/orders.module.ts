import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController, OffersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
