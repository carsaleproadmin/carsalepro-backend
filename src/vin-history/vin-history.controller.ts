import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Public } from '../auth/auth.decorators';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  PublicVinReportDto,
  VinCheckDetailDto,
  VinCheckDownloadDto,
  VinCheckDownloadQueryDto,
  VinCheckListDto,
  VinCheckShareDto,
  VinHistoryPreviewDto,
  VinHistoryUnlockDto,
  VinParamDto,
} from './dto/vin-history.dto';
import { VinHistoryService } from './vin-history.service';

@ApiTags('vin-history')
@Controller('api/v1/vin-history')
export class VinHistoryController {
  constructor(private readonly vinHistory: VinHistoryService) {}

  /**
   * Unauthenticated, so it carries the tighter `lookup` bucket rather than the
   * global default: it takes a VIN and answers "what do we hold?", which is
   * exactly the shape of an enumeration probe.
   */
  @Public()
  @Get(':vin/preview')
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Free VIN history preview — counts and booleans only',
    description:
      'Never returns dates, plates, place names or descriptions: those are what the paid ' +
      'report is. `synthetic: true` means the numbers are generated, not sourced — show it.',
  })
  @ApiParam({ name: 'vin', example: 'WAUZZZ8V8MA012345' })
  @ApiOkResponse({ type: VinHistoryPreviewDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Malformed VIN' })
  preview(@Param() params: VinParamDto): Promise<VinHistoryPreviewDto> {
    return this.vinHistory.preview(params.vin);
  }

  @ApiBearerAuth()
  @Post(':vin/unlock')
  @ApiOperation({
    summary: 'Buy the full VIN history (idempotent per user + VIN)',
    description:
      'Returns { alreadyOwned: true } when the caller already owns it. In mock mode the ' +
      'purchase settles immediately. Returns 503 provider_unavailable — and charges ' +
      'nothing — when no data provider is configured.',
  })
  @ApiParam({ name: 'vin', example: 'WAUZZZ8V8MA012345' })
  @ApiOkResponse({ type: VinHistoryUnlockDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description:
      'not_covered / no_records / invalid_vin — nothing to sell, and nothing charged.',
  })
  @ApiResponse({ status: 502, type: ErrorResponseDto, description: 'provider_failed (auto-refunded)' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'provider_unavailable' })
  unlock(
    @CurrentUser('id') userId: string,
    @Param() params: VinParamDto,
  ): Promise<VinHistoryUnlockDto> {
    return this.vinHistory.unlock(userId, params.vin);
  }
}

/**
 * The public face of a shared report.
 *
 * Separate controller because it is the only anonymous route in the module, and
 * keeping it apart makes that visible rather than hidden behind one `@Public()`
 * among many. It carries the `lookup` throttle for the same reason the preview
 * does: it takes an opaque string and answers whether it addresses something.
 */
@ApiTags('vin-history')
@Controller('api/v1/public')
export class PublicVinReportController {
  constructor(private readonly vinHistory: VinHistoryService) {}

  @Public()
  @Get('vin-report/:token')
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Read a report someone shared, with no account',
    description:
      'Serves the buyer\'s frozen snapshot, so the link always shows the report that was ' +
      'paid for. A revoked, unknown or unfinished token is the same 404 — telling them ' +
      'apart would confirm that an old link once pointed at something.',
  })
  @ApiParam({ name: 'token' })
  @ApiOkResponse({ type: PublicVinReportDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  shared(@Param('token') token: string): Promise<PublicVinReportDto> {
    return this.vinHistory.getShared(token);
  }
}

@ApiTags('vin-history')
@ApiBearerAuth()
@Controller('api/v1/me')
export class MeVinChecksController {
  constructor(private readonly vinHistory: VinHistoryService) {}

  @Get('vin-checks')
  @ApiOperation({ summary: "List the caller's VIN history purchases" })
  @ApiOkResponse({ type: VinCheckListDto })
  list(@CurrentUser('id') userId: string): Promise<VinCheckListDto> {
    return this.vinHistory.listMine(userId);
  }

  @Get('vin-checks/:id')
  @ApiOperation({
    summary: 'One VIN check with its full payload',
    description: "Another user's purchase is a 404, never a 403 — a 403 confirms the id exists.",
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: VinCheckDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  get(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<VinCheckDetailDto> {
    return this.vinHistory.getMine(userId, id);
  }

  @Get('vin-checks/:id/download')
  @ApiOperation({
    summary: 'Short-lived PRIVATE signed URL for the purchased report',
    description:
      'Defaults to the rendered PDF; `?format=json` returns the archived payload. The PDF is ' +
      'rendered on first request when a purchase does not have one yet, in the locale on the ' +
      "caller's profile. The URL carries a Content-Disposition filename.",
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'format', required: false, enum: ['pdf', 'json'] })
  @ApiOkResponse({ type: VinCheckDownloadDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'download_unavailable' })
  download(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: VinCheckDownloadQueryDto,
  ): Promise<VinCheckDownloadDto> {
    return this.vinHistory.downloadMine(userId, id, query.format ?? 'pdf');
  }

  @Post('vin-checks/:id/share')
  @ApiOperation({
    summary: 'Publish this report at an unguessable public address',
    description:
      'Idempotent — calling it twice returns the same link, so reopening the page to copy ' +
      'the address again cannot break a link already sent. Only a completed check can be ' +
      'shared.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: VinCheckShareDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'not_found / not_shareable' })
  share(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<VinCheckShareDto> {
    return this.vinHistory.share(userId, id);
  }

  @Delete('vin-checks/:id/share')
  @ApiOperation({
    summary: 'Withdraw the public link',
    description:
      'The report itself is untouched and the owner keeps it. Idempotent: withdrawing a ' +
      'link that does not exist is a success.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: VinCheckShareDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  unshare(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<VinCheckShareDto> {
    return this.vinHistory.unshare(userId, id);
  }
}
