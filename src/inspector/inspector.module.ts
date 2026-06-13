import { Module } from '@nestjs/common';
import { InspectorController } from './inspector.controller';
import { InspectorService } from './inspector.service';

@Module({
  controllers: [InspectorController],
  providers: [InspectorService],
  exports: [InspectorService],
})
export class InspectorModule {}
