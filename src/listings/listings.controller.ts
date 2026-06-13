import { Body, Controller, Get, Param, Post, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Listing } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import { CreateListingDto } from './dto/create-listing.dto';
import {
  MyListingsListDto,
  PublishResultDto,
} from './dto/listing-response.dto';
import { PublishListingDto } from './dto/publish-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@ApiTags('listings')
@ApiBearerAuth()
@Controller('api/v1/listings')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a DRAFT listing for a report you own' })
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateListingDto,
  ): Promise<Listing> {
    return this.listings.create(userId, dto.reportCode);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update editable fields of an owned listing' })
  @ApiParam({ name: 'id' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ): Promise<Listing> {
    return this.listings.update(userId, id, dto);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish a listing (standard activates; gold checks out)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: PublishResultDto })
  publish(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: PublishListingDto,
  ): Promise<PublishResultDto> {
    return this.listings.publish(userId, id, dto.package);
  }

  @Post(':id/unpublish')
  @ApiOperation({ summary: 'Hide a listing from the showroom' })
  @ApiParam({ name: 'id' })
  unpublish(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<Listing> {
    return this.listings.unpublish(userId, id);
  }

  @Post(':id/mark-sold')
  @ApiOperation({ summary: 'Mark a listing as sold' })
  @ApiParam({ name: 'id' })
  markSold(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<Listing> {
    return this.listings.markSold(userId, id);
  }

  @Post(':id/renew')
  @ApiOperation({ summary: 'Renew an expired/active listing' })
  @ApiParam({ name: 'id' })
  renew(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<Listing> {
    return this.listings.renew(userId, id);
  }
}

@ApiTags('listings')
@ApiBearerAuth()
@Controller('api/v1/me')
export class MeListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Get('listings')
  @ApiOperation({ summary: "List the current user's listings" })
  @ApiOkResponse({ type: MyListingsListDto })
  listMine(@CurrentUser('id') userId: string): Promise<MyListingsListDto> {
    return this.listings.listMine(userId);
  }
}
