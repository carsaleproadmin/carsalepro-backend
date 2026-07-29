import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { R2Module } from '../r2/r2.module';
// Imported as a CLASS, not via ReportsModule: the report pipeline does not
// export the provider, and re-implementing the compression settings here is
// exactly the drift this reuse exists to prevent. The only cost is a second
// in-process semaphore (2 concurrent libvips transforms per instance, not 2
// across the process).
import { PhotoProcessingService } from '../reports/photo-processing.service';
import { ListingsController, MeListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [PaymentsModule, R2Module],
  controllers: [ListingsController, MeListingsController],
  providers: [ListingsService, PhotoProcessingService],
  exports: [ListingsService],
})
export class ListingsModule {}
