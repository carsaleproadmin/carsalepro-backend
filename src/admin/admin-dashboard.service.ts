import { Injectable } from '@nestjs/common';
import { KycStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async counts() {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);

    const [
      pendingKyc,
      openDisputes,
      unassignedOrders,
      activeListings,
      totalUsers,
      bannedUsers,
      pendingPayouts,
      revenueToday,
    ] = await this.prisma.$transaction([
      this.prisma.kycApplication.count({
        where: { status: { in: [KycStatus.SUBMITTED, KycStatus.IN_REVIEW] } },
      }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.order.count({ where: { status: OrderStatus.UNASSIGNED } }),
      this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, bannedAt: { not: null } } }),
      this.prisma.payout.count({ where: { status: 'pending' } }),
      this.prisma.payment.aggregate({
        where: { status: 'succeeded', createdAt: { gte: midnightUtc } },
        _sum: { amountCents: true },
      }),
    ]);

    return {
      pendingKyc,
      openDisputes,
      unassignedOrders,
      activeListings,
      totalUsers,
      bannedUsers,
      pendingPayouts,
      revenueTodayCents: revenueToday._sum.amountCents ?? 0,
    };
  }
}
