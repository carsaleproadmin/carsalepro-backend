import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { CreatePpvDto } from './dto/create-ppv.dto';
import { PpvCheckoutResponseDto, ReportPurchaseListDto } from './dto/ppv-response.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('api/v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('ppv')
  @ApiOperation({
    summary: 'Start a pay-per-view purchase for a report',
    description:
      'Returns a Stripe Checkout URL. If the user already owns the report, returns ' +
      '{ alreadyOwned: true }. In mock mode (no Stripe key) the purchase completes ' +
      'immediately and { mock: true } is returned.',
  })
  @ApiOkResponse({ type: PpvCheckoutResponseDto })
  async createPpvCheckout(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePpvDto,
  ): Promise<PpvCheckoutResponseDto> {
    return this.payments.createPpvCheckout(userId, dto.reportCode);
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
