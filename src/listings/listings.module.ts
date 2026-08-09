import { Module } from '@nestjs/common';
import { PhotoModule } from '../common/photo/photo.module';
import { PaymentsModule } from '../payments/payments.module';
import { R2Module } from '../r2/r2.module';
import { ListingsController, MeListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [PaymentsModule, R2Module, PhotoModule],
  controllers: [ListingsController, MeListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
