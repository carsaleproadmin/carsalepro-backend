import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { FullReportDto, ReportDownloadDto } from './dto/report-access.dto';
import { ReportAccessService } from './report-access.service';

/**
 * Website report-store routes under /api/v1/reports. Separate from the legacy
 * mobile @Controller('reports') so the mobile contract is untouched.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('api/v1/reports')
export class ReportAccessController {
  constructor(private readonly access: ReportAccessService) {}

  @Get(':id/full')
  @ApiOperation({
    summary: 'Full report (owner or pay-per-view purchaser)',
    description: 'Returns the complete report with signed photo + PDF URLs. 403 payment_required otherwise.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: FullReportDto })
  async getFull(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<FullReportDto> {
    return this.access.getFull(userId, id);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Signed PDF download URL (owner or pay-per-view purchaser)',
    description: 'Returns { signedUrl, expiresAt }. 403 payment_required otherwise, 503 if storage unconfigured.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: ReportDownloadDto })
  async getDownload(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<ReportDownloadDto> {
    return this.access.getDownload(userId, id);
  }
}
