import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '../auth/auth.decorators';
import { AdminFinanceService } from './admin-finance.service';
import { Dac7QueryDto, FinanceSummaryQueryDto } from './dto/admin-finance.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/finance')
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Financial summary over a window (admin)' })
  summary(@Query() query: FinanceSummaryQueryDto) {
    return this.finance.summary(query.from, query.to);
  }

  @Get('dac7.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'DAC7 payout report (CSV) for a calendar year (admin)' })
  async dac7(
    @Query() query: Dac7QueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const year = query.year ?? new Date().getUTCFullYear();
    res.setHeader('Content-Disposition', `attachment; filename="dac7-${year}.csv"`);
    return this.finance.dac7Csv(year);
  }
}
