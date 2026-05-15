import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { VinController } from './vin.controller';
import { VinService } from './vin.service';

@Module({
  imports: [HttpModule],
  controllers: [VinController],
  providers: [VinService],
  exports: [VinService],
})
export class VinModule {}
