import { Module } from '@nestjs/common';
import { PhotoModule } from '../common/photo/photo.module';
import { AdminKycController } from './admin-kyc.controller';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  // PhotoModule is IMPORTED, never re-declared: the sharp concurrency semaphore
  // lives on the service instance, so a second provider would mean a second
  // semaphore and twice the intended peak memory.
  imports: [PhotoModule],
  controllers: [KycController, AdminKycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
