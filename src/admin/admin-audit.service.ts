import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditListQuery {
  entity?: string;
  entityId?: string;
  adminId?: string;
  action?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditListResult {
  items: Array<{
    id: string;
    adminId: string;
    action: string;
    entity: string;
    entityId: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Append-only admin audit trail. Every admin mutation should call {@link log}
 * with a cheap `before` snapshot and the resulting `after` state. Logging is
 * best-effort and never throws into the mutation path — a failed audit write is
 * swallowed and warned so it cannot roll back the action it records.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(
    adminId: string,
    action: string,
    entity: string,
    entityId: string,
    before?: unknown,
    after?: unknown,
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          entity,
          entityId,
          before: this.toJson(before),
          after: this.toJson(after),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Audit log write failed for ${action} ${entity}/${entityId}: ${String(err)}`,
      );
    }
  }

  async list(query: AuditListQuery): Promise<AuditListResult> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.adminId ? { adminId: query.adminId } : {}),
      ...(query.action ? { action: query.action } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        adminId: r.adminId,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Serialize an arbitrary snapshot into a Prisma JSON value (or skip if undefined). */
  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}

export function clampPage(page?: number): number {
  if (!page || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

export function clampPageSize(pageSize?: number): number {
  if (!pageSize || !Number.isFinite(pageSize) || pageSize < 1) return 20;
  return Math.min(Math.floor(pageSize), 100);
}
