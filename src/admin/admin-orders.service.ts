import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { AdminOrderListQueryDto } from './dto/admin-orders.dto';

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async list(query: AdminOrderListQueryDto) {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.inspectorId) where.inspectorId = query.inspectorId;
    if (query.q) {
      where.OR = [
        { number: { contains: query.q, mode: 'insensitive' } },
        { vin: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: rows.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        customerId: o.customerId,
        inspectorId: o.inspectorId,
        vin: o.vin,
        make: o.make,
        model: o.model,
        totalCents: o.totalCents,
        currency: o.currency,
        scheduledAt: o.scheduledAt.toISOString(),
        createdAt: o.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Full admin detail: core order detail + payment/refunds/payout/dispute. */
  async detail(orderId: string, adminId: string) {
    const core = await this.orders.getDetail(orderId, adminId, Role.ADMIN);
    const [payment, refunds, payout, dispute] = await this.prisma.$transaction([
      this.prisma.payment.findUnique({ where: { orderId } }),
      this.prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.payout.findUnique({ where: { orderId } }),
      this.prisma.dispute.findUnique({ where: { orderId } }),
    ]);

    return {
      ...core,
      payment: payment
        ? {
            id: payment.id,
            purpose: payment.purpose,
            amountCents: payment.amountCents,
            currency: payment.currency,
            status: payment.status,
            stripePaymentIntentId: payment.stripePaymentIntentId,
            createdAt: payment.createdAt.toISOString(),
          }
        : null,
      refunds: refunds.map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        reason: r.reason,
        stripeRefundId: r.stripeRefundId,
        createdAt: r.createdAt.toISOString(),
      })),
      payout: payout
        ? {
            id: payout.id,
            amountCents: payout.amountCents,
            status: payout.status,
            stripeTransferId: payout.stripeTransferId,
            createdAt: payout.createdAt.toISOString(),
          }
        : null,
      dispute: dispute
        ? {
            id: dispute.id,
            status: dispute.status,
            reason: dispute.reason,
            openedBy: dispute.openedBy,
            resolution: dispute.resolution,
            resolvedBy: dispute.resolvedBy,
            resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : null,
            createdAt: dispute.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** List DISPUTED orders together with their Dispute rows. */
  async listDisputes(page?: number, pageSize?: number) {
    const p = clampPage(page);
    const ps = clampPageSize(pageSize);

    const where: Prisma.OrderWhereInput = { status: OrderStatus.DISPUTED };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * ps,
        take: ps,
        include: { dispute: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: rows.map((o) => ({
        orderId: o.id,
        number: o.number,
        status: o.status,
        customerId: o.customerId,
        inspectorId: o.inspectorId,
        totalCents: o.totalCents,
        dispute: o.dispute
          ? {
              id: o.dispute.id,
              status: o.dispute.status,
              reason: o.dispute.reason,
              openedBy: o.dispute.openedBy,
              resolution: o.dispute.resolution,
              resolvedBy: o.dispute.resolvedBy,
              resolvedAt: o.dispute.resolvedAt ? o.dispute.resolvedAt.toISOString() : null,
              createdAt: o.dispute.createdAt.toISOString(),
            }
          : null,
        createdAt: o.createdAt.toISOString(),
      })),
      total,
      page: p,
      pageSize: ps,
    };
  }
}
