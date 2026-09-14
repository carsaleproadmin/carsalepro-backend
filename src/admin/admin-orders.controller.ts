import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { OrdersService } from '../orders/orders.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminOrdersService } from './admin-orders.service';
import {
  AdminAssignOrderDto,
  AdminCancelOrderDto,
  AdminOrderListQueryDto,
  AdminResolveDisputeDto,
} from './dto/admin-orders.dto';
import { PaginationQueryDto } from './dto/pagination.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly adminOrders: AdminOrdersService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List/search orders (admin)' })
  list(@Query() query: AdminOrderListQueryDto) {
    return this.adminOrders.list(query);
  }

  @Get('disputes')
  @ApiOperation({ summary: 'List DISPUTED orders with their dispute rows (admin)' })
  listDisputes(@Query() query: PaginationQueryDto) {
    return this.adminOrders.listDisputes(query.page, query.pageSize);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Full order detail (admin)' })
  @ApiParam({ name: 'id' })
  detail(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.adminOrders.detail(id, adminId);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manually assign an inspector to an order (admin)' })
  @ApiParam({ name: 'id' })
  async assign(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: AdminAssignOrderDto,
  ) {
    const order = await this.orders.adminAssign(id, dto.inspectorId, adminId);
    await this.audit.log(
      adminId,
      'order.assign',
      'order',
      id,
      null,
      { inspectorId: dto.inspectorId, status: order.status },
    );
    return { orderId: order.id, status: order.status, inspectorId: order.inspectorId };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an order with a refund percent (admin)' })
  @ApiParam({ name: 'id' })
  async cancel(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: AdminCancelOrderDto,
  ) {
    const result = await this.orders.adminCancel(id, dto.refundPercent, adminId);
    await this.audit.log(
      adminId,
      'order.cancel',
      'order',
      id,
      null,
      { refundPercent: dto.refundPercent, refundCents: result.refundCents, status: result.status },
    );
    return result;
  }

  @Post(':id/resolve-dispute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a disputed order (admin)' })
  @ApiParam({ name: 'id' })
  async resolveDispute(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: AdminResolveDisputeDto,
  ) {
    const result = await this.orders.resolveDispute(id, dto.resolution, adminId, dto.refundPercent);
    await this.audit.log(
      adminId,
      'order.resolve_dispute',
      'order',
      id,
      null,
      {
        resolution: dto.resolution,
        status: result.status,
        refundCents: result.refundCents,
        payoutCents: result.payoutCents,
      },
    );
    return result;
  }
}
