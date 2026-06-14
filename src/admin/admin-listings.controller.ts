import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { ListingsService } from '../listings/listings.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminListingsService } from './admin-listings.service';
import { AdminListingListQueryDto } from './dto/admin-listings.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/listings')
export class AdminListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly adminListings: AdminListingsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List/search listings (admin)' })
  list(@Query() query: AdminListingListQueryDto) {
    return this.adminListings.list(query);
  }

  @Post(':id/hide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hide a listing (admin)' })
  @ApiParam({ name: 'id' })
  async hide(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    const listing = await this.listings.adminHide(id);
    await this.audit.log(adminId, 'listing.hide', 'listing', id, null, { status: listing.status });
    return { id: listing.id, status: listing.status };
  }

  @Post(':id/unhide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unhide a listing (admin)' })
  @ApiParam({ name: 'id' })
  async unhide(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    const listing = await this.listings.adminUnhide(id);
    await this.audit.log(adminId, 'listing.unhide', 'listing', id, null, {
      status: listing.status,
    });
    return { id: listing.id, status: listing.status };
  }

  @Post(':id/renew')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renew a listing (admin)' })
  @ApiParam({ name: 'id' })
  async renew(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    const listing = await this.listings.adminRenew(id);
    await this.audit.log(adminId, 'listing.renew', 'listing', id, null, {
      status: listing.status,
      expiresAt: listing.expiresAt?.toISOString() ?? null,
    });
    return {
      id: listing.id,
      status: listing.status,
      expiresAt: listing.expiresAt?.toISOString() ?? null,
    };
  }
}
