import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { ADMIN_ROLES, isAdminRole } from '../auth/roles';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { AdminUserListQueryDto } from './dto/admin-users.dto';
import { banDenial, roleChangeDenial, type RoleDenial } from './role-policy';

/** The caller of an admin action: who they are, and which admin role they hold. */
export interface AdminActor {
  id: string;
  role: Role;
}

function refuse(denial: RoleDenial): never {
  if (denial === 'cannot_demote_self') {
    throw new BadRequestException({
      error: { code: 'cannot_demote_self', message: 'You cannot demote yourself' },
    });
  }
  throw new ForbiddenException({
    error: {
      code: 'super_admin_required',
      message: 'Only a super admin can change the role of an admin or ban an admin',
    },
  });
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

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
          deletedAt: true,
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
        deletedAt: u.deletedAt ? u.deletedAt.toISOString() : null,
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

  /** Only a super admin can ban an admin or a super admin (DEN-299). */
  async ban(id: string, actor: AdminActor): Promise<User> {
    if (id === actor.id) {
      throw new BadRequestException({
        error: { code: 'cannot_target_self', message: 'You cannot ban yourself' },
      });
    }
    const user = await this.require(id);
    const denial = banDenial(actor.role, user.role);
    if (denial) refuse(denial);
    if (user.bannedAt) return user; // idempotent no-op
    return this.prisma.user.update({ where: { id }, data: { bannedAt: new Date() } });
  }

  async unban(id: string, actor: AdminActor): Promise<User> {
    const user = await this.require(id);
    const denial = banDenial(actor.role, user.role);
    if (denial) refuse(denial);
    return this.prisma.user.update({ where: { id }, data: { bannedAt: null } });
  }

  /**
   * An admin can make a user an admin. Every other change to an admin role
   * needs a super admin (DEN-299, rules in `role-policy.ts`).
   */
  async changeRole(id: string, role: Role, actor: AdminActor): Promise<User> {
    const user = await this.require(id);
    const denial = roleChangeDenial(actor.role, user.role, role, id === actor.id);
    if (denial) refuse(denial);
    if (user.role === role) return user; // idempotent

    /*
     * Through this route neither count can fall to zero today: the caller holds
     * an admin role and cannot demote themselves. The checks stay as the last
     * guard of the rule, so a later change to the policy cannot break it.
     */
    if (user.role === Role.SUPER_ADMIN) {
      const superAdmins = await this.prisma.user.count({
        where: { role: Role.SUPER_ADMIN, deletedAt: null },
      });
      if (superAdmins <= 1) {
        throw new BadRequestException({
          error: { code: 'last_super_admin', message: 'Cannot remove the last super admin' },
        });
      }
    }
    if (isAdminRole(user.role) && !isAdminRole(role)) {
      const adminCount = await this.prisma.user.count({
        where: { role: { in: [...ADMIN_ROLES] }, deletedAt: null },
      });
      if (adminCount <= 1) {
        throw new BadRequestException({
          error: { code: 'last_admin', message: 'Cannot remove the last administrator' },
        });
      }
    }
    return this.prisma.user.update({ where: { id }, data: { role } });
  }

  /**
   * GDPR erasure when the request comes by e-mail (DEN-300). Only a super
   * admin, never on yourself (use the account settings), never on the last
   * super admin. The erasure is `UsersService.eraseMe`, the same one the user
   * runs, so orders and payments stay without personal data.
   *
   * The controller keeps `@Roles(Role.ADMIN)`, and this method refuses an
   * admin. So an admin gets `super_admin_required`, which the admin panel
   * knows, and not the general `forbidden` of the guard.
   */
  async erase(id: string, actor: AdminActor): Promise<User> {
    if (id === actor.id) {
      throw new BadRequestException({
        error: {
          code: 'cannot_target_self',
          message: 'You cannot erase your own account here. Use the account settings.',
        },
      });
    }
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException({
        error: { code: 'super_admin_required', message: 'Only a super admin can erase an account' },
      });
    }
    const user = await this.require(id);
    if (user.deletedAt) {
      throw new ConflictException({
        error: { code: 'already_erased', message: 'The account is already erased' },
      });
    }
    // Not reachable today (the caller is a different super admin), kept as
    // the last guard of the rule, as in `changeRole`.
    if (user.role === Role.SUPER_ADMIN) {
      const superAdmins = await this.prisma.user.count({
        where: { role: Role.SUPER_ADMIN, deletedAt: null },
      });
      if (superAdmins <= 1) {
        throw new BadRequestException({
          error: { code: 'last_super_admin', message: 'Cannot remove the last super admin' },
        });
      }
    }
    await this.users.eraseMe(id);
    return this.require(id);
  }
}
