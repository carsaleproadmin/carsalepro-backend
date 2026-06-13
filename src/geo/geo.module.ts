import { Global, Module } from '@nestjs/common';
import { GeoService } from './geo.service';

/** Global so orders, inspector, and waitlist code can read/write geography. */
@Global()
@Module({
  providers: [GeoService],
  exports: [GeoService],
})
export class GeoModule {}
