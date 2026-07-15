import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PhotoProcessingService } from './photo-processing.service';
import { ReportAccessController } from './report-access.controller';
import { ReportAccessService } from './report-access.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PaymentsModule],
  controllers: [ReportsController, ReportAccessController],
  providers: [ReportsService, ReportAccessService, PhotoProcessingService],
  exports: [ReportsService],
})
export class ReportsModule {}
