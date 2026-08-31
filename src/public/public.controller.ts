import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { ListingQueryDto } from './dto/listing-query.dto';
import { ReportCheckQueryDto, ReportCodeParamDto } from './dto/report-lookup.dto';
import { PublicService } from './public.service';

@ApiTags('public')
@Public()
@Controller('api/v1/public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('listings')
  @ApiOperation({ summary: 'Search verified showroom listings (public)' })
  listings(@Query() query: ListingQueryDto) {
    return this.publicService.searchListings(query);
  }

  @Get('listings/:id')
  @ApiOperation({ summary: 'Get a single verified listing (public)' })
  listing(@Param('id') id: string) {
    return this.publicService.getListing(id);
  }

  // The two lookups below answer "does this VIN / report code exist?" without
  // authentication, so they carry a tighter throttle than the global default
  // and validate their input rather than passing raw query strings through.
  @Get('report-check')
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check whether a report exists by VIN or Report ID' })
  reportCheck(@Query() query: ReportCheckQueryDto) {
    return this.publicService.checkReport(query);
  }

  @Get('reports/:code/full')
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Full report of a car that is on sale (public, PII-masked)',
    description:
      'DEN-224. The findings are free. Answers 404 unless the report backs an ACTIVE, unexpired listing.',
  })
  reportFull(@Param() params: ReportCodeParamDto) {
    return this.publicService.reportFull(params.code);
  }

  @Get('reports/:code/preview')
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Free, PII-masked preview of a report' })
  reportPreview(@Param() params: ReportCodeParamDto) {
    return this.publicService.reportPreview(params.code);
  }
}
