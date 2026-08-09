import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { CurrentUser, OptionalAuth, Public } from '../auth/auth.decorators';
import { LegalContractService } from '../legal/legal-contract.service';
import {
  AttachOrderReportDto,
  CreateOrderDto,
  DisputeOrderDto,
  ListOrdersQueryDto,
  OrderRole,
  QuoteOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('api/v1/orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly legalContract: LegalContractService,
  ) {}

  /**
   * F-10: pricing is the first question a visitor asks, and it sat behind the
   * JWT guard — you had to create an account to find out what an inspection
   * costs. Public, and on the tighter `lookup` bucket because it is now
   * unauthenticated and it reaches Mapbox.
   *
   * `@Public()` on its own is a FULL bypass — the JWT guard returns before it
   * ever populates `req.user`, so `@CurrentUser('id')` would be `undefined`
   * even for a signed-in caller, and they would silently lose both the
   * waitlist entry and the self-dealing exclusion. `@OptionalAuth()` keeps the
   * route open to visitors while still resolving a caller who sent a token.
   */
  @Public()
  @OptionalAuth()
  @Throttle({ lookup: { limit: 20, ttl: 60_000 } })
  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price an inspection (public); waitlist when no coverage' })
  async quote(@CurrentUser('id') userId: string | undefined, @Body() dto: QuoteOrderDto) {
    return this.orders.quote(userId, dto);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create an order (re-prices server-side) + start payment. The PaymentIntent ' +
      'uses MANUAL capture: confirming it holds the funds, and they are only taken ' +
      'when an inspector accepts.',
  })
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateOrderDto) {
    return this.orders.createOrder(userId, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'List my orders (role=customer|inspector, optional status)' })
  async listMine(@CurrentUser('id') userId: string, @Query() query: ListOrdersQueryDto) {
    return this.orders.listMine(userId, query.role ?? OrderRole.customer, query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Order detail (customer / assigned inspector / admin)' })
  async getOne(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Param('id') id: string,
  ) {
    return this.orders.getDetail(id, userId, role);
  }

  @Get(':id/contract')
  @ApiOperation({
    summary: 'Get the per-order inspection brokerage contract (customer / inspector / admin)',
  })
  async getContract(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Param('id') id: string,
  ) {
    return this.legalContract.getContractForOrder(id, userId, role);
  }

  @Get(':id/contract/pdf')
  @ApiOperation({
    summary: 'Short-lived signed URL for the archived contract PDF (customer / inspector / admin)',
  })
  async getContractPdf(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Param('id') id: string,
  ) {
    // Privately signed — a contract names both parties and their addresses, so
    // it must never be reachable through the bucket's public URL.
    return this.legalContract.getContractPdfUrl(id, userId, role);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancel an order. Before acceptance the authorization hold is RELEASED ' +
      '(refundCents 0, refundMode authorization_released); after it the captured ' +
      'amount is refunded 100% / 80% per status.',
  })
  async cancel(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.orders.cancel(id, userId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a submitted report (SUBMITTED → APPROVED)' })
  async approve(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.orders.approve(id, userId);
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open a dispute (IN_PROGRESS|SUBMITTED → DISPUTED)' })
  async dispute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: DisputeOrderDto,
  ) {
    return this.orders.dispute(id, userId, dto.reason);
  }

  @Post(':id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assigned inspector pushes EN_ROUTE / IN_PROGRESS' })
  async updateStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.updateStatusByInspector(id, userId, dto.status);
  }

  @Post(':id/report')
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach an existing mobile report to an assigned order' })
  async attachReport(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AttachOrderReportDto,
  ) {
    return this.orders.attachReportByCode(id, userId, dto.code);
  }
}
