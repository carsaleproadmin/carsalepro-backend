import { Module } from '@nestjs/common';
import { LegalModule } from '../legal/legal.module';
import { PaymentsModule } from '../payments/payments.module';
import { CounterOffersController } from './counter-offers.controller';
import { CounterOffersService } from './counter-offers.service';
import { OffersController } from './offers.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  // LegalModule is imported one-way (it must NOT import OrdersModule) so the
  // ASSIGNED hook can generate the per-order contract without a dependency cycle.
  imports: [PaymentsModule, LegalModule],
  controllers: [OrdersController, OffersController, CounterOffersController],
  // CounterOffersService depends on OrdersService and never the other way
  // round: the money paths a counter-offer ends in (capture, release, assign)
  // live in OrdersService, and the webhook reaches them through it.
  providers: [OrdersService, CounterOffersService],
  exports: [OrdersService, CounterOffersService],
})
export class OrdersModule {}
