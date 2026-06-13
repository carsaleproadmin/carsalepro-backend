import { Module } from '@nestjs/common';
import { MeReportsController } from './me-reports.controller';
import { MeReportsService } from './me-reports.service';

@Module({
  controllers: [MeReportsController],
  providers: [MeReportsService],
})
export class MeReportsModule {}
