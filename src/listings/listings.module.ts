import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ListingsController, MeListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [PaymentsModule],
  controllers: [ListingsController, MeListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
