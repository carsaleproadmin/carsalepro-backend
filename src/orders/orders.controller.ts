import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import { LegalContractService } from '../legal/legal-contract.service';
import {
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

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price an inspection; waitlist when no coverage' })
  async quote(@CurrentUser('id') userId: string, @Body() dto: QuoteOrderDto) {
    return this.orders.quote(userId, dto);
  }

  @Post()
  @ApiOperation({ summary: 'Create an order (re-prices server-side) + start payment' })
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

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an order (100% / 80% refund per status)' })
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
}
