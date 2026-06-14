import { Module } from '@nestjs/common';
import { LegalContractService } from './legal-contract.service';
import { LegalController } from './legal.controller';

@Module({
  // PrismaService (PrismaModule) and R2Service (R2Module) are both @Global().
  controllers: [LegalController],
  providers: [LegalContractService],
  exports: [LegalContractService],
})
export class LegalModule {}
