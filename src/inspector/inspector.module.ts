import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PaymentsModule } from '../payments/payments.module';
import { InspectorController } from './inspector.controller';
import { InspectorService } from './inspector.service';

@Module({
  imports: [PaymentsModule, SettingsModule],
  controllers: [InspectorController],
  providers: [InspectorService],
  exports: [InspectorService],
})
export class InspectorModule {}
