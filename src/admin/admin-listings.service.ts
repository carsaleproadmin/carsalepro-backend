import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { AdminListingListQueryDto } from './dto/admin-listings.dto';

@Injectable()
export class AdminListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminListingListQueryDto) {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const where: Prisma.ListingWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.sellerId) where.sellerId = query.sellerId;
    if (query.q) {
      where.OR = [
        { city: { contains: query.q, mode: 'insensitive' } },
        { report: { make: { contains: query.q, mode: 'insensitive' } } },
        { report: { model: { contains: query.q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { report: { select: { make: true, model: true, year: true } } },
      }),
      this.prisma.listing.count({ where }),
    ]);

    return {
      items: rows.map((l) => ({
        id: l.id,
        sellerId: l.sellerId,
        status: l.status,
        package: l.package,
        priceCents: l.priceCents,
        city: l.city,
        make: l.report.make,
        model: l.report.model,
        year: l.report.year,
        publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
        expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
        createdAt: l.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }
}
