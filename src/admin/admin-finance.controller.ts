import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { OrdersService } from '../orders/orders.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminFinanceService } from './admin-finance.service';
import {
  Dac7QueryDto,
  FinanceSummaryQueryDto,
  MarkPayoutPaidDto,
  PayoutQueueQueryDto,
} from './dto/admin-finance.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly finance: AdminFinanceService,
    private readonly orders: OrdersService,
    private readonly audit: AdminAuditService,
  ) {}

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

  // ------------------------------------------------------------------
  // Payout queue. A failed transfer used to be invisible: it parked a row,
  // logged a warning, and was never retried or surfaced anywhere. These three
  // endpoints are the operator's view of money that is owed and not moving.
  // ------------------------------------------------------------------

  @Get('payouts')
  @ApiOperation({ summary: 'Payout queue with retry state (admin)' })
  payouts(@Query() query: PayoutQueueQueryDto) {
    return this.orders.listPayouts(query.status, query.page ?? 1, query.pageSize ?? 50);
  }

  @Post('payouts/:orderId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a stuck payout now, ignoring the backoff (admin)' })
  async retryPayout(@Param('orderId') orderId: string, @CurrentUser('id') adminId: string) {
    const payout = await this.orders.adminRetryPayout(orderId);
    await this.audit.log(adminId, 'payout.retry', 'payout', orderId, null, payout);
    return payout;
  }

  @Post('payouts/:orderId/mark-paid')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record a payout settled outside Stripe, e.g. by bank transfer (admin)',
  })
  async markPayoutPaid(
    @Param('orderId') orderId: string,
    @Body() dto: MarkPayoutPaidDto,
    @CurrentUser('id') adminId: string,
  ) {
    const payout = await this.orders.adminMarkPayoutPaid(orderId, dto.reference);
    await this.audit.log(adminId, 'payout.mark_paid', 'payout', orderId, null, payout);
    return payout;
  }
}
