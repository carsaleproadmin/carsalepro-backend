import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { AdminUserListQueryDto } from './dto/admin-users.dto';

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminUserListQueryDto) {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const where: Prisma.UserWhereInput = {};
    if (!query.includeDeleted) where.deletedAt = null;
    if (query.role) where.role = query.role;
    if (query.banned !== undefined) {
      where.bannedAt = query.banned ? { not: null } : null;
    }
    if (query.q) {
      where.OR = [
        { email: { contains: query.q, mode: 'insensitive' } },
        { name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          kycVerified: true,
          bannedAt: true,
          createdAt: true,
          _count: { select: { ordersAsCustomer: true, listings: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        kycVerified: u.kycVerified,
        bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
        orderCount: u._count.ordersAsCustomer,
        listingCount: u._count.listings,
      })),
      total,
      page,
      pageSize,
    };
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        locale: true,
        countryCode: true,
        role: true,
        kycVerified: true,
        bannedAt: true,
        deletedAt: true,
        createdAt: true,
        deviceLinks: {
          select: { id: true, deviceId: true, linkedVia: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { ordersAsCustomer: true, listings: true } },
      },
    });
    if (!user) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'User not found' } });
    }

    const latestKyc = await this.prisma.kycApplication.findFirst({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      locale: user.locale,
      countryCode: user.countryCode,
      role: user.role,
      kycVerified: user.kycVerified,
      bannedAt: user.bannedAt ? user.bannedAt.toISOString() : null,
      deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      deviceLinks: user.deviceLinks.map((d) => ({
        id: d.id,
        deviceId: d.deviceId,
        linkedVia: d.linkedVia,
        createdAt: d.createdAt.toISOString(),
      })),
      latestKyc: latestKyc
        ? { id: latestKyc.id, status: latestKyc.status, createdAt: latestKyc.createdAt.toISOString() }
        : null,
      counts: { orders: user._count.ordersAsCustomer, listings: user._count.listings },
    };
  }

  /** Load a user by id, or throw 404. */
  async require(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'User not found' } });
    }
    return user;
  }

  async ban(id: string, adminId: string): Promise<User> {
    if (id === adminId) {
      throw new BadRequestException({
        error: { code: 'cannot_target_self', message: 'You cannot ban yourself' },
      });
    }
    const user = await this.require(id);
    if (user.bannedAt) return user; // idempotent no-op
    return this.prisma.user.update({ where: { id }, data: { bannedAt: new Date() } });
  }

  async unban(id: string): Promise<User> {
    await this.require(id);
    return this.prisma.user.update({ where: { id }, data: { bannedAt: null } });
  }

  async changeRole(id: string, role: Role, adminId: string): Promise<User> {
    const user = await this.require(id);
    if (id === adminId && role !== Role.ADMIN) {
      throw new BadRequestException({
        error: { code: 'cannot_demote_self', message: 'You cannot demote yourself' },
      });
    }
    // Removing the last remaining ADMIN is forbidden.
    if (user.role === Role.ADMIN && role !== Role.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: { role: Role.ADMIN, deletedAt: null },
      });
      if (adminCount <= 1) {
        throw new BadRequestException({
          error: { code: 'last_admin', message: 'Cannot remove the last administrator' },
        });
      }
    }
    if (user.role === role) return user; // idempotent
    return this.prisma.user.update({ where: { id }, data: { role } });
  }
}
