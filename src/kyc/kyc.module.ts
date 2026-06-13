import { Module } from '@nestjs/common';
import { AdminKycController } from './admin-kyc.controller';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  controllers: [KycController, AdminKycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
