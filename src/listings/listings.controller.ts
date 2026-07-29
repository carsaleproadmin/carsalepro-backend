import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Listing } from '@prisma/client';
import { CurrentUser, Public } from '../auth/auth.decorators';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import { CreateManualListingDto } from './dto/create-manual-listing.dto';
import {
  ListingPhotoDto,
  ListingPhotoListDto,
  ReorderListingPhotosDto,
  UploadListingPhotoDto,
} from './dto/listing-photo.dto';
import {
  ListingPackagesDto,
  MyListingsListDto,
  PublishResultDto,
} from './dto/listing-response.dto';
import { PublishListingDto } from './dto/publish-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

/** Same ceiling as report photos — an original camera JPEG fits well inside it. */
const MAX_PHOTO_UPLOAD_BYTES = 15 * 1024 * 1024;

@ApiTags('listings')
@ApiBearerAuth()
@Controller('api/v1/listings')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  // Declared before `@Get(':id')`-style routes would be, and public so the
  // package picker can render prices before the seller signs in.
  @Public()
  @Get('packages')
  @ApiOperation({ summary: 'Listing package prices (integer cents)' })
  @ApiOkResponse({ type: ListingPackagesDto })
  packages(): Promise<ListingPackagesDto> {
    return this.listings.packages();
  }

  // A Report ID is a bearer capability, so this endpoint is the one place a
  // valid code can be turned into a listing. It answers the same 404 for
  // unknown and already-claimed codes, and the tighter bucket keeps that
  // uniform answer from being brute-forced.
  @Post()
  @Throttle({ lookup: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Claim a Report ID and open a DRAFT listing (single-use)' })
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateListingDto,
  ): Promise<Listing> {
    return this.listings.create(userId, dto.reportCode);
  }

  // Static segment, so it must be declared before any `:id` route.
  @Post('manual')
  @ApiOperation({
    summary: 'BE-S2: open a DRAFT listing WITHOUT an inspection report',
    description:
      'Creates a listing with `source: "manual"` and `reportId: null`. The listing is ' +
      'never presented as verified and never carries a quality score. Publishing it ' +
      'additionally requires make, model, year and at least one photo.',
  })
  @ApiResponse({ status: 201, description: 'The created DRAFT listing.' })
  createManual(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateManualListingDto,
  ): Promise<Listing> {
    return this.listings.createManual(userId, dto);
  }

  // Declared after the static segments above, before the other `:id` routes.
  @Get(':id')
  @ApiOperation({
    summary: 'Read one owned listing in full, including vehicleData',
    description:
      'The multi-stage manual editor needs to hydrate a draft. GET /me/listings omits ' +
      'vehicleData and the contact fields, and the public route serves only ACTIVE ' +
      'listings, so neither can rehydrate a DRAFT. Without this the editor had to issue ' +
      'an empty PATCH as a read — a write in the audit trail for something that changes ' +
      'nothing.',
  })
  @ApiParam({ name: 'id', description: 'Listing id' })
  get(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<Listing> {
    return this.listings.getOwned(userId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update editable fields of an owned listing',
    description:
      '`vehicleData` is accepted ONLY when the listing has `source: "manual"` ' +
      '(otherwise 400 `vehicle_immutable`). It is deep-merged: objects merge, ' +
      'arrays replace wholesale, an explicit null deletes the key.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'vehicle_immutable / listing_deleted' })
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
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'incomplete_listing — `error.missing` names every field still required',
  })
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

  // ============================================================
  // Seller photo gallery (BE-S2)
  // ============================================================

  // Declared before `POST :id/photos` so the literal segment wins over the
  // parameterised one; Nest matches in declaration order.
  @Patch(':id/photos/order')
  @ApiOperation({
    summary: 'Reorder the whole gallery in one transaction',
    description: '`ids` must name every current photo of the listing exactly once.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: ListingPhotoListDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'photo_order_mismatch' })
  reorderPhotos(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ReorderListingPhotosDto,
  ): Promise<ListingPhotoListDto> {
    return this.listings.reorderPhotos(userId, id, dto.ids);
  }

  @Post(':id/photos')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_PHOTO_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a listing photo (server-side compression)',
    description:
      'Multipart upload of an ORIGINAL camera JPEG (≤15 MB). Compressed to 1920 px / ' +
      'mozjpeg q80 with EXIF stripped, then stored under listings/<sellerId>/<listingId>/. ' +
      'Max 20 photos per listing (400 photo_limit_reached). Re-sending identical bytes ' +
      'returns the existing photo instead of duplicating it.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        order: { type: 'integer', example: 0 },
        caption: { type: 'string', example: 'Front three-quarter view' },
        hash: { type: 'string', description: 'sha256 hex of the original bytes (optional)' },
      },
    },
  })
  @ApiResponse({ status: 201, type: ListingPhotoDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'photo_limit_reached / invalid_image' })
  @ApiResponse({ status: 413, description: 'File larger than 15 MB' })
  addPhoto(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UploadListingPhotoDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ListingPhotoDto> {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException({
        error: { code: 'file_required', message: 'Send the image in the `file` multipart field' },
      });
    }
    return this.listings.addPhoto(userId, id, dto, file);
  }

  @Get(':id/photos')
  @ApiOperation({ summary: "List an owned listing's photos" })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: ListingPhotoListDto })
  listPhotos(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<ListingPhotoListDto> {
    return this.listings.listPhotos(userId, id);
  }

  @Delete(':id/photos/:photoId')
  @ApiOperation({ summary: 'Delete one listing photo (object + row)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'photoId' })
  deletePhoto(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ): Promise<{ id: string; deleted: true }> {
    return this.listings.deletePhoto(userId, id, photoId);
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
