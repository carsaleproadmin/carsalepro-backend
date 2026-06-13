import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { ListingQueryDto } from './dto/listing-query.dto';
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

  @Get('report-check')
  @ApiOperation({ summary: 'Check whether a report exists by VIN or Report ID' })
  reportCheck(@Query('vin') vin?: string, @Query('code') code?: string) {
    return this.publicService.checkReport({ vin, code });
  }

  @Get('reports/:code/preview')
  @ApiOperation({ summary: 'Free, PII-masked preview of a report' })
  reportPreview(@Param('code') code: string) {
    return this.publicService.reportPreview(code);
  }
}
