import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeoService } from './geo.service';
import { RoutingService } from './routing.service';

/** Global so orders, inspector, and waitlist code can read/write geography. */
@Global()
@Module({
  imports: [HttpModule],
  providers: [GeoService, RoutingService],
  exports: [GeoService, RoutingService],
})
export class GeoModule {}
