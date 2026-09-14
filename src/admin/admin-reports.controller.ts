import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { FullReportDto, ReportDownloadDto } from '../reports/dto/report-access.dto';
import { ReportAccessService } from '../reports/report-access.service';

/**
 * Report reads for the admin panel (DEN-312).
 *
 * The customer route `GET /api/v1/reports/:id/full` lets only the owner, a
 * linked device or a purchaser read a report. An admin is none of these, so
 * the admin order page could not open the report of the order. These routes
 * return the same payload without the owner check. The customer route does
 * not change.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/reports')
export class AdminReportsController {
  constructor(private readonly access: ReportAccessService) {}

  @Get(':id/full')
  @ApiOperation({ summary: 'Full report with signed photo and PDF URLs (admin)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: FullReportDto })
  getFull(@Param('id') id: string): Promise<FullReportDto> {
    return this.access.getFullForAdmin(id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Signed PDF download URL (admin)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: ReportDownloadDto })
  getDownload(@Param('id') id: string): Promise<ReportDownloadDto> {
    return this.access.getDownloadForAdmin(id);
  }
}
