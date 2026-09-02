import { Controller, Get, GoneException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { ReportPurchaseListDto } from './dto/ppv-response.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('api/v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * CLOSED - DEN-224. The report is free.
   *
   * The findings used to be sold one view at a time. The client reversed that,
   * `GET /public/reports/:code/full` gives the whole report to anyone, and the
   * website deleted its unlock button in the same change. A route that can
   * still open a Stripe Checkout for a thing that is no longer sold is a way
   * to take money for nothing.
   *
   * 410 rather than a deletion, and the route keeps its shape on purpose:
   *   - an old mobile or web build that still calls this gets an answer that
   *     says the offer is gone, not a 404 that reads as "wrong address";
   *   - `PaymentsService.createPpvCheckout` STAYS. The webhook still has to
   *     settle `purpose: 'ppv'` sessions that were opened before this deploy,
   *     and `GET /me/report-purchases` still has to list what people bought.
   *
   * Delete the service method only when no unsettled ppv session is left.
   */
  @Post('ppv')
  @ApiOperation({
    summary: 'Gone - the report is free (DEN-224)',
    description:
      'Always answers 410. The pay-per-view offer is withdrawn. Read the report at ' +
      'GET /api/v1/public/reports/:code/full.',
  })
  createPpvCheckout(): never {
    throw new GoneException({
      error: {
        code: 'offer_withdrawn',
        message: 'The report is free. Use GET /api/v1/public/reports/:code/full.',
      },
    });
  }
}

@ApiTags('payments')
@ApiBearerAuth()
@Controller('api/v1/me')
export class MeReportPurchasesController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('report-purchases')
  @ApiOperation({ summary: 'List the reports the current user has purchased' })
  @ApiOkResponse({ type: ReportPurchaseListDto })
  async listPurchases(@CurrentUser('id') userId: string): Promise<ReportPurchaseListDto> {
    return this.payments.listPurchases(userId);
  }
}
