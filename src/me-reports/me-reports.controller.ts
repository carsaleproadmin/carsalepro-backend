import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { MeReportListDto } from './dto/me-report.dto';
import { MeReportsService } from './me-reports.service';

@ApiTags('me-reports')
@ApiBearerAuth()
@Controller('api/v1/me')
export class MeReportsController {
  constructor(private readonly meReports: MeReportsService) {}

  @Get('reports')
  @ApiOperation({
    summary: 'List the report archive across all devices linked to the account',
  })
  @ApiOkResponse({ type: MeReportListDto })
  listReports(@CurrentUser('id') userId: string): Promise<MeReportListDto> {
    return this.meReports.listForUser(userId);
  }
}
