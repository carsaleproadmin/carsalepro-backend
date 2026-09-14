import { Injectable, NotFoundException } from '@nestjs/common';
import { ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampPage, clampPageSize } from './admin-audit.service';
import { citySearchKeys, normalizeCompact } from '../common/search-text';
import { intRange } from './dto/admin-car-filter.dto';
import { AdminListingListQueryDto } from './dto/admin-listings.dto';

@Injectable()
export class AdminListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminListingListQueryDto) {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    // Each filter that needs its own OR goes into this AND. Two `OR` keys in
    // one object do not combine: the second replaces the first.
    const and: Prisma.ListingWhereInput[] = [];
    if (query.q) {
      // Search the listing's own denormalised columns: a manual listing has no
      // report to join through, and these columns are indexed.
      and.push({
        OR: [
          { city: { contains: query.q, mode: 'insensitive' } },
          { make: { contains: query.q, mode: 'insensitive' } },
          { model: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    // DEN-316: the showroom filters, with the same matching rules as
    // `PublicService.searchListings`, so a car the showroom finds, the admin
    // finds too.
    const cityKeys = citySearchKeys(query.city);
    if (cityKeys.length) {
      and.push({ OR: cityKeys.map((key) => ({ citySearch: { contains: key } })) });
    }
    const makeKey = normalizeCompact(query.make);
    const modelKey = normalizeCompact(query.model);

    const where: Prisma.ListingWhereInput = {
      ...(and.length ? { AND: and } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      ...(query.country ? { countryCode: query.country } : {}),
      ...(makeKey ? { makeSearch: { contains: makeKey } } : {}),
      ...(modelKey ? { modelSearch: { contains: modelKey } } : {}),
      ...(intRange(query.priceFrom, query.priceTo)
        ? { priceCents: intRange(query.priceFrom, query.priceTo) }
        : {}),
      ...(intRange(query.yearFrom, query.yearTo)
        ? { year: intRange(query.yearFrom, query.yearTo) }
        : {}),
      ...(query.mileageTo != null ? { mileageKm: { lte: query.mileageTo } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
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
        source: l.source,
        make: l.make,
        model: l.model,
        year: l.year,
        publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
        // Set only by an admin hide, so the admin panel offers Unhide on it
        // and not on a listing the seller took off the showroom.
        adminHiddenAt: l.adminHiddenAt ? l.adminHiddenAt.toISOString() : null,
        createdAt: l.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** The listing's status now, for the "before" half of an audit row. 404 when absent. */
  async status(id: string): Promise<ListingStatus> {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!listing) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Listing not found' } });
    }
    return listing.status;
  }
}
