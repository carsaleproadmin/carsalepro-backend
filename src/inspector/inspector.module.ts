import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { InspectorController } from './inspector.controller';
import { InspectorService } from './inspector.service';

@Module({
  imports: [PaymentsModule],
  controllers: [InspectorController],
  providers: [InspectorService],
  exports: [InspectorService],
})
export class InspectorModule {}
