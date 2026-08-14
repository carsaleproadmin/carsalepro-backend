import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeoService } from './geo.service';
import { RoutingService } from './routing.service';
import { GeocodingService } from './geocoding.service';

/** Global so orders, inspector, and waitlist code can read/write geography. */
@Global()
@Module({
  imports: [HttpModule],
  providers: [GeoService, RoutingService, GeocodingService],
  exports: [GeoService, RoutingService, GeocodingService],
})
export class GeoModule {}
