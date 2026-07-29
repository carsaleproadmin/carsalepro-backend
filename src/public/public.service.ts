import { Injectable, NotFoundException } from '@nestjs/common';
import { Listing, Prisma, Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import { ListingQueryDto } from './dto/listing-query.dto';

const PAGE_SIZE = 12;

type PhotoRef = { s3Key?: string; kind?: string; angle?: string };

type ListingWithReport = Prisma.ListingGetPayload<{ include: { report: true } }>;

/**
 * How a listing's vehicle data was established. Explicit rather than implied by
 * a `verified` boolean, because "we did not inspect this car" and "this car
 * failed inspection" are very different claims and a single flag conflates them.
 */
export interface ListingInspectionBlock {
  status: 'inspected' | 'self_declared';
  reportCode: string | null;
}

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly settings: SettingsService,
  ) {}

  /** Showroom search — ACTIVE listings, Gold first. */
  async searchListings(q: ListingQueryDto) {
    const page = q.page && q.page > 0 ? q.page : 1;

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
      // Vehicle filters read the LISTING's own columns, not the report relation.
      // A manual listing has no report to join, and `(make, model, year)` is
      // indexed on the listing, so this is both correct and faster.
      ...(q.make ? { make: { equals: q.make, mode: 'insensitive' as const } } : {}),
      ...(q.model ? { model: { contains: q.model, mode: 'insensitive' as const } } : {}),
      ...(q.yearFrom || q.yearTo
        ? { year: { gte: q.yearFrom ?? undefined, lte: q.yearTo ?? undefined } }
        : {}),
      ...(q.mileageTo ? { mileageKm: { lte: q.mileageTo } } : {}),
      // Opt-IN filter. Manual listings are shown by default and badged as
      // self-declared: hiding them would make the showroom look empty for the
      // exact seller segment BE-S2 exists to serve. A buyer who only wants
      // inspected cars asks for them.
      ...(q.verifiedOnly ? { reportId: { not: null }, source: 'report' } : {}),
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

    const inspection = this.inspectionOf(listing);
    const inspected = inspection.status === 'inspected';
    const photos = await this.listingPhotos(listing, 12);

    return {
      id: listing.id,
      priceCents: listing.priceCents,
      city: listing.city,
      plz: listing.plz,
      description: listing.description,
      contactPhone: listing.contactPhone,
      contactEmail: listing.contactEmail,
      package: listing.package,
      source: listing.source,
      vehicle: this.listingVehicle(listing),
      // A quality score is derived from an inspection. There is no honest value
      // for a self-declared car, so it is null rather than 0 (which reads as
      // "inspected and terrible") or omitted (which the UI would guess about).
      qualityScore: inspected ? (listing.report?.qualityScore ?? null) : null,
      reportCode: inspection.reportCode,
      verified: inspected,
      inspection,
      /** Seller's own claims. Never merged into `vehicle` — provenance matters. */
      selfDeclaration: this.selfDeclarationOf(listing),
      photos,
      views: listing.viewsCount + 1,
      // What unlocking the full report costs, so the page never hardcodes it.
      reportUnlockPriceCents: await this.settings.getCents('payPerViewPriceEur'),
      currency: 'EUR',
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
      unlockPriceCents: await this.settings.getCents('payPerViewPriceEur'),
      currency: 'EUR',
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

  /**
   * The listing's own denormalised vehicle facts.
   *
   * Identical shape for both provenances — the caller learns which it is from
   * `inspection.status`, not from a differently-shaped payload.
   */
  private listingVehicle(l: Listing) {
    return {
      make: l.make,
      model: l.model,
      year: l.year,
      mileageKm: l.mileageKm,
      color: l.color,
      bodyType: l.bodyType,
      driveType: l.driveType,
      fuelType: l.fuelType,
      transmission: l.transmission,
      powerKw: l.powerKw,
      firstRegistration: l.firstRegistration ? l.firstRegistration.toISOString() : null,
      huValidUntil: l.huValidUntil,
    };
  }

  /**
   * `source` alone is not enough: a report-backed listing whose report was
   * hard-deleted (GDPR erasure sets `report_id` to NULL) must stop claiming an
   * inspection immediately. The relation is the authority.
   */
  private inspectionOf(l: ListingWithReport): ListingInspectionBlock {
    if (l.source === 'report' && l.report) {
      return { status: 'inspected', reportCode: l.report.code };
    }
    return { status: 'self_declared', reportCode: null };
  }

  private selfDeclarationOf(l: Listing): Record<string, unknown> | null {
    if (l.source !== 'manual') return null;
    const data = (l.vehicleData ?? null) as Record<string, unknown> | null;
    const declared = data?.selfDeclaration;
    return declared && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : null;
  }

  private async toCard(listing: ListingWithReport) {
    const inspection = this.inspectionOf(listing);
    const inspected = inspection.status === 'inspected';
    const [thumb] = await this.listingPhotos(listing, 1);
    return {
      id: listing.id,
      priceCents: listing.priceCents,
      city: listing.city,
      package: listing.package,
      source: listing.source,
      qualityScore: inspected ? (listing.report?.qualityScore ?? null) : null,
      verified: inspected,
      inspection,
      vehicle: this.listingVehicle(listing),
      thumbnailUrl: thumb?.url ?? null,
    };
  }

  /**
   * Photos for a listing card/detail, resolved from whichever gallery the
   * listing actually has: the inspector's `photosManifest` for a report-backed
   * listing, the seller's own `ListingPhoto` rows for a manual one.
   */
  private async listingPhotos(
    listing: ListingWithReport,
    limit: number,
  ): Promise<{ url: string; kind?: string }[]> {
    if (listing.source === 'report' && listing.report) {
      return this.signPhotos(listing.report.photosManifest, limit);
    }
    if (!this.r2.isConfigured()) return [];
    const rows = await this.prisma.listingPhoto.findMany({
      where: { listingId: listing.id },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    const out: { url: string; kind?: string }[] = [];
    for (const row of rows) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(row.r2Key);
        out.push({ url, kind: 'listing' });
      } catch {
        /* skip unsignable */
      }
    }
    return out;
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
