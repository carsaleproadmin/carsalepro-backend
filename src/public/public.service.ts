import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { ListingQueryDto } from './dto/listing-query.dto';

const PAGE_SIZE = 12;

type PhotoRef = { s3Key?: string; kind?: string; angle?: string };

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  /** Showroom search — ACTIVE verified listings only, Gold first. */
  async searchListings(q: ListingQueryDto) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const reportFilter: Prisma.ReportWhereInput = {};
    if (q.make) reportFilter.make = { equals: q.make, mode: 'insensitive' };
    if (q.model) reportFilter.model = { contains: q.model, mode: 'insensitive' };
    if (q.yearFrom || q.yearTo)
      reportFilter.year = { gte: q.yearFrom ?? undefined, lte: q.yearTo ?? undefined };
    if (q.mileageTo) reportFilter.mileageKm = { lte: q.mileageTo };

    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      // Exclude expired-but-not-yet-swept listings (null expiry = never expires).
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(q.city ? { city: { contains: q.city, mode: 'insensitive' } } : {}),
      ...(q.bodyType ? { bodyType: q.bodyType } : {}),
      ...(q.driveType ? { driveType: q.driveType } : {}),
      ...(q.priceFrom || q.priceTo
        ? { priceCents: { gte: q.priceFrom ?? undefined, lte: q.priceTo ?? undefined } }
        : {}),
      ...(Object.keys(reportFilter).length ? { report: reportFilter } : {}),
    };

    // Gold listings rank first. 'gold' < 'standard' lexically, so ascending
    // order on `package` puts Gold ahead of Standard.
    const orderBy: Prisma.ListingOrderByWithRelationInput[] =
      q.sort === 'price_asc'
        ? [{ package: 'asc' }, { priceCents: 'asc' }]
        : q.sort === 'price_desc'
          ? [{ package: 'asc' }, { priceCents: 'desc' }]
          : [{ package: 'asc' }, { publishedAt: 'desc' }];

    const [rows, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { report: true },
      }),
      this.prisma.listing.count({ where }),
    ]);

    const items = await Promise.all(rows.map((l) => this.toCard(l)));
    return { items, total, page, pageSize: PAGE_SIZE, pages: Math.ceil(total / PAGE_SIZE) };
  }

  async getListing(id: string) {
    const listing = await this.prisma.listing.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { report: true },
    });
    if (!listing) throw new NotFoundException({ error: { code: 'not_found', message: 'Listing not found' } });
    await this.prisma.listing.update({ where: { id }, data: { viewsCount: { increment: 1 } } });

    const photos = await this.signPhotos(listing.report.photosManifest, 12);
    return {
      id: listing.id,
      priceCents: listing.priceCents,
      city: listing.city,
      plz: listing.plz,
      description: listing.description,
      contactPhone: listing.contactPhone,
      contactEmail: listing.contactEmail,
      package: listing.package,
      vehicle: this.vehicle(listing.report),
      qualityScore: listing.report.qualityScore,
      reportCode: listing.report.code,
      verified: true,
      photos,
      views: listing.viewsCount + 1,
    };
  }

  /** Public report existence check by VIN or CSP code — no PII. */
  async checkReport(params: { vin?: string; code?: string }) {
    const where: Prisma.ReportWhereInput = { deletedAt: null, uploaded: true };
    if (params.code) where.code = params.code;
    else if (params.vin) where.vin = params.vin.toUpperCase();
    else return { found: false };

    const report = await this.prisma.report.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    });
    if (!report) return { found: false };
    return {
      found: true,
      code: report.code,
      date: report.createdAt.toISOString(),
      qualityScore: report.qualityScore,
      vehicle: this.vehicle(report),
    };
  }

  /** Free preview — header, score, damage count, 1–2 thumbnails. PII masked. */
  async reportPreview(code: string) {
    const report = await this.prisma.report.findFirst({
      where: { code, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!report) throw new NotFoundException({ error: { code: 'not_found', message: 'Report not found' } });

    const data = (report.reportData ?? {}) as Record<string, unknown>;
    const damages = Array.isArray((data as { damages?: unknown[] }).damages)
      ? ((data as { damages: unknown[] }).damages as unknown[])
      : [];

    return {
      code: report.code,
      date: report.createdAt.toISOString(),
      qualityScore: report.qualityScore,
      vehicle: this.vehicle(report),
      damageCount: damages.length,
      photos: await this.signPhotos(report.photosManifest, 2),
      vinMasked: report.vin ? this.maskVin(report.vin) : null,
      // PII (signatures, addresses, phones) is intentionally never included here.
    };
  }

  private vehicle(r: Report) {
    return {
      make: r.make,
      model: r.model,
      year: r.year,
      mileageKm: r.mileageKm,
      color: r.color,
      bodyType: r.bodyType,
      driveType: r.driveType,
    };
  }

  private async toCard(listing: Prisma.ListingGetPayload<{ include: { report: true } }>) {
    const [thumb] = await this.signPhotos(listing.report.photosManifest, 1);
    return {
      id: listing.id,
      priceCents: listing.priceCents,
      city: listing.city,
      package: listing.package,
      qualityScore: listing.report.qualityScore,
      verified: true,
      vehicle: this.vehicle(listing.report),
      thumbnailUrl: thumb?.url ?? null,
    };
  }

  private async signPhotos(
    manifest: Prisma.JsonValue | null,
    limit: number,
  ): Promise<{ url: string; kind?: string }[]> {
    if (!Array.isArray(manifest) || !this.r2.isConfigured()) return [];
    const refs = (manifest as PhotoRef[]).filter((p) => p?.s3Key).slice(0, limit);
    const out: { url: string; kind?: string }[] = [];
    for (const ref of refs) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(ref.s3Key!);
        out.push({ url, kind: ref.kind });
      } catch {
        /* skip unsignable */
      }
    }
    return out;
  }

  private maskVin(vin: string): string {
    return vin.length === 17 ? `${vin.slice(0, 3)}**********${vin.slice(-4)}` : vin;
  }
}
