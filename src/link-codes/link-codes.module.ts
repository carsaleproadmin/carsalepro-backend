import { Module } from '@nestjs/common';
import { LinkCodesController } from './link-codes.controller';
import { LinkCodesService } from './link-codes.service';

@Module({
  controllers: [LinkCodesController],
  providers: [LinkCodesService],
  exports: [LinkCodesService],
})
export class LinkCodesModule {}
