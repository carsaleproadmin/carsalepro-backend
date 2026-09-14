import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { ADMIN_DECISION_EVENT, readAdminDecision } from '../orders/admin-decision';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { citySearchKeys } from '../common/search-text';
import { intRange } from './dto/admin-car-filter.dto';
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

    // Each filter that needs its own OR goes into this AND. Two `OR` keys in
    // one object do not combine: the second replaces the first.
    const and: Prisma.OrderWhereInput[] = [];
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.inspectorId) where.inspectorId = query.inspectorId;
    if (query.q) {
      and.push({
        OR: [
          { number: { contains: query.q, mode: 'insensitive' } },
          { vin: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    // DEN-316: the showroom filters. An order has no normalized search columns,
    // so make, model and city are a case-insensitive `contains` on the raw text.
    const make = query.make?.trim();
    const model = query.model?.trim();
    if (make) where.make = { contains: make, mode: 'insensitive' };
    if (model) where.model = { contains: model, mode: 'insensitive' };
    if (query.country) where.countryCode = query.country;
    const city = query.city?.trim();
    if (city) {
      // The order has no city column; the city is part of the address. Try the
      // typed text and each spelling or alias of the city.
      const keys = [...new Set([city, ...citySearchKeys(city)])];
      and.push({
        OR: keys.map((key) => ({ address: { contains: key, mode: 'insensitive' as const } })),
      });
    }
    const price = intRange(query.priceFrom, query.priceTo);
    if (price) where.totalCents = price;
    // Year and mileage are facts of the inspected car, so they come from the
    // attached report. An order without a report does not match these filters.
    const year = intRange(query.yearFrom, query.yearTo);
    if (year || query.mileageTo != null) {
      where.report = {
        is: {
          ...(year ? { year } : {}),
          ...(query.mileageTo != null ? { mileageKm: { lte: query.mileageTo } } : {}),
        },
      };
    }
    if (and.length) where.AND = and;

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
        scheduledAt: o.scheduledAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Every inspector, for the inspector filter on the admin order list (DEN-316).
   * An inspector is a user with an InspectorProfile, not a role. Erased users
   * are left out. The cap keeps the answer small; the platform has far fewer.
   */
  async listInspectors() {
    const rows = await this.prisma.inspectorProfile.findMany({
      where: { user: { deletedAt: null } },
      select: {
        userId: true,
        companyName: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return {
      items: rows.map((r) => ({
        id: r.userId,
        name: r.user.name,
        companyName: r.companyName,
        email: r.user.email,
      })),
    };
  }

  /** Full admin detail: core order detail + payment/refunds/payout/dispute. */
  async detail(orderId: string, adminId: string) {
    const core = await this.orders.getDetail(orderId, adminId, Role.ADMIN);
    const [payment, refunds, payout, dispute, decisionEvents] = await this.prisma.$transaction([
      this.prisma.payment.findUnique({ where: { orderId } }),
      this.prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.payout.findUnique({ where: { orderId } }),
      this.prisma.dispute.findUnique({ where: { orderId } }),
      this.prisma.orderEvent.findMany({
        where: { orderId, type: ADMIN_DECISION_EVENT },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      ...core,
      // Why each admin decision was made (DEN-294). The shared timeline in
      // `core.events` leaves these out, so only this admin view has them.
      decisions: decisionEvents.flatMap((e) => {
        const decision = readAdminDecision(e.payload);
        return decision
          ? [{ ...decision, actor: e.actor, createdAt: e.createdAt.toISOString() }]
          : [];
      }),
      // Deliberately overrides the public `payment` block `getDetail` returns.
      // The website needs one word for where the money is; an operator needs the
      // raw ledger status, the provider handle, and WHEN each step happened —
      // "authorized at 09:02, never captured" is the answer to most finance
      // questions about an order, and the public block cannot carry it.
      payment: payment
        ? {
            id: payment.id,
            purpose: payment.purpose,
            amountCents: payment.amountCents,
            currency: payment.currency,
            status: payment.status,
            stripePaymentIntentId: payment.stripePaymentIntentId,
            authorizedAt: payment.authorizedAt?.toISOString() ?? null,
            capturedAt: payment.capturedAt?.toISOString() ?? null,
            canceledAt: payment.canceledAt?.toISOString() ?? null,
            createdAt: payment.createdAt.toISOString(),
          }
        : null,
      refunds: refunds.map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        reason: r.reason,
        stripeRefundId: r.stripeRefundId,
        // A refund can now be parked mid-flight, so its own state has to be
        // visible here: a row on the order used to imply the money went back.
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
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
