import { Injectable, NotFoundException } from '@nestjs/common';
import { Listing, Prisma, Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import { ListingQueryDto, ListingSort, PAGE_SIZES } from './dto/listing-query.dto';
import {
  MAX_LISTING_PHOTOS,
  manifestPhotoRefs,
  mirroredPhotoKey,
  photoLocation,
} from '../listings/listing-photo-urls';
import { citySearchKeys, normalizeCompact, normalizeSearchText } from '../common/search-text';

/*
 * DEN-211. The reader chooses how many cards a page carries, out of the closed
 * set in the DTO. 20 is the default because it is the middle of that set and
 * the size the showroom's two-up layout is built around; the previous 12 is
 * not offered, so a bookmarked `?page=` cannot land on a page that no longer
 * exists at any offered size.
 */
const DEFAULT_PAGE_SIZE = 20;

/**
 * The eight orders the showroom offers.
 *
 * Two things are the same in every one of them, and both are deliberate:
 *
 *  - `package: 'asc'` first. 'gold' sorts before 'standard', so a paid listing
 *    ranks above a free one in EVERY order, including "cheapest first". That is
 *    a commercial rule, not a sorting bug - it predates this change and is left
 *    exactly as it was. It does mean the cheapest car on the page is not always
 *    the first card.
 *  - `id: 'asc'` last, the tiebreaker from DEN-205. Without a total order rows
 *    repeat across pages and others are never shown.
 *
 * `year` and `mileageKm` are NULLABLE, so both directions ask for nulls last.
 * The default in Postgres puts them first on a descending sort, which would
 * open "newest year first" with the cars whose year nobody filled in.
 */
function orderFor(sort: ListingSort | undefined): Prisma.ListingOrderByWithRelationInput[] {
  const gold: Prisma.ListingOrderByWithRelationInput = { package: 'asc' };
  const tiebreak: Prisma.ListingOrderByWithRelationInput = { id: 'asc' };
  const by: Record<ListingSort, Prisma.ListingOrderByWithRelationInput> = {
    default: { publishedAt: 'desc' },
    recent: { publishedAt: 'desc' },
    price_asc: { priceCents: 'asc' },
    price_desc: { priceCents: 'desc' },
    year_asc: { year: { sort: 'asc', nulls: 'last' } },
    year_desc: { year: { sort: 'desc', nulls: 'last' } },
    mileage_asc: { mileageKm: { sort: 'asc', nulls: 'last' } },
    mileage_desc: { mileageKm: { sort: 'desc', nulls: 'last' } },
  };
  return [gold, by[sort ?? 'default'], tiebreak];
}

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

/**
 * Mean paint thickness across the stations the inspector actually measured, in
 * micrometres, or null when nothing was measured.
 *
 * Free on the preview because it is a SUMMARY, not a finding: one number says
 * how thick the coating is on average and cannot say which panel is thicker
 * than the rest, which is the sentence a buyer pays for.
 *
 * Every field is treated as untrusted. `reportData` is free-form JSON on old
 * rows, and a preview must degrade to "no number" rather than throw on a shape
 * some 2025 mobile build wrote.
 */
export function averagePaintThicknessUm(data: Record<string, unknown>): number | null {
  const thickness = data.thickness as { panels?: unknown } | undefined;
  const panels = Array.isArray(thickness?.panels) ? thickness.panels : [];
  const values: number[] = [];
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue;
    const um = (panel as { um?: unknown }).um;
    // A station that was skipped carries no `um`, and counting it as 0 would
    // drag the mean towards a number nobody measured.
    if (typeof um === 'number' && Number.isFinite(um) && um > 0) values.push(um);
  }
  if (values.length === 0) return null;
  const mean = values.reduce((sum, um) => sum + um, 0) / values.length;
  return Math.round(mean);
}

/**
 * How many report photographs the public page may show.
 *
 * The preview showed two, as a taste of a document nobody could read. There is
 * nothing left to hold back, so this is a guard against a malformed manifest
 * rather than an editorial choice - and it has to sit ABOVE the real work.
 *
 * 60 was the first number here and it was too low: `ReportDataV1Dto` accepts
 * 600 and says a thorough report runs to roughly 100-120 photographs - 17
 * exterior angles, 17 interior, 13 thickness stations, four wheels, the
 * odometer and VIN plate, and several shots per damage. The gallery orders
 * damage photographs LAST, so a cap below the real count cut exactly the
 * evidence a buyer opens the report for, and said nothing about it.
 *
 * 300 rather than the DTO's own 600: it clears the documented ceiling of the
 * work by a wide margin, and still refuses to sign six hundred URLs for one
 * page load if a manifest is nonsense.
 */
const MAX_REPORT_PHOTOS = 300;

/**
 * Keys that never leave the building, at any depth.
 *
 * `reportData` is free-form JSON written by the mobile app, so its shape is
 * not ours to promise. A blocklist rather than a whitelist is deliberate: a
 * whitelist would silently drop the next section the app starts sending, and
 * the client asked for the WHOLE report. The cost of that choice is that this
 * list has to be maintained - anything the app adds that names a person has to
 * be added here.
 *
 * WHERE THIS LIST COMES FROM. Not from imagination: `ReportDataV1Dto` is the
 * contract the mobile app writes to, and every field on it that can hold a
 * person is named below. The first version of this list was guessed from the
 * obvious words - signature, phone, email - and missed four fields that were
 * right there in the DTO: `vehicle.company`, `vehicle.branch`,
 * `vehicle.responsible` ("Responsible inspector display name") and the whole
 * `recipients` array, whose rows carry `name` beside the address. The generic
 * renderer prints every unknown key, so the customer's name and the
 * inspector's name were both on a public page. Read the DTO before adding a
 * section here.
 *
 * The signature is the clearest case. `signoff` itself is a FINDING - the
 * rating, the OBD result, whether the car is accident-free - and stays; what
 * goes is the inspector's drawn signature and their contact details inside it.
 *
 * `company` and `branch` are the inspection firm rather than a private person,
 * and they still go: naming the firm that signed a report we publish for free
 * is a claim about that firm, made without asking it.
 */
const PII_KEYS = new Set([
  'signature',
  'signatureurl',
  'signatureimage',
  'inspectorsignature',
  'customersignature',
  'ownersignature',
  'customer',
  'client',
  'owner',
  'seller',
  'contact',
  'contacts',
  'phone',
  'phonenumber',
  'email',
  'address',
  'street',
  'postaladdress',
  'iban',
  'taxid',
  'personalid',
  'idnumber',
  'passport',
  'licenseplate',
  'plate',
  'vin',
  // From ReportDataV1Dto - see the note above.
  'recipients',
  'responsible',
  'company',
  'branch',
  // A bare `name` is a person far more often than not in this payload, and the
  // catalogue ids the report is actually built from (`part`, `kind`, `angle`)
  // never travel under it.
  'name',
  'firstname',
  'lastname',
  'fullname',
  'mobile',
  'tel',
]);

/**
 * `reportData` with every PII-bearing key removed, at any depth.
 *
 * Recursive, because the app nests: a phone number under `signoff.inspector`
 * is the same leak as one at the top level. Arrays are walked as well - the
 * damages list is an array of objects, and a note field inside one of them is
 * reached the same way.
 */
function publicReportData(value: unknown, dropTopLevel: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => publicReportData(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(key.toLowerCase())) continue;
      if (dropTopLevel.includes(key)) continue;
      out[key] = publicReportData(child);
    }
    return out;
  }
  return value ?? null;
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

    /*
     * DEN-205. Every filter below reads a NORMALIZED value, and the reasons are
     * one bug report each.
     *
     * Text is folded on both sides. A seller's city is free text written in
     * whatever language their geocoder answered in; a buyer types whatever
     * language they think in. Matching those raw finds the car only when both
     * happened to choose the same alphabet - the report that opened this was a
     * Berlin car that "Berlin" found and "Берлин" did not.
     *
     * Numbers are tested with `!= null`, never for truthiness. `mileageTo=0` is
     * a real question ("nothing on the clock") and `0 ? … : {}` dropped the
     * filter and answered it with the entire table.
     */
    const cityKeys = citySearchKeys(q.city);
    const makeKey = normalizeCompact(q.make);
    const modelKey = normalizeCompact(q.model);
    const bodyType = normalizeSearchText(q.bodyType);
    const driveType = normalizeSearchText(q.driveType);

    const where: Prisma.ListingWhereInput = {
      status: 'ACTIVE',
      /*
       * Everything that needs an OR of its own lives in this AND, and nothing
       * writes a top-level `OR` any more. Two sibling `OR` keys in one object
       * literal do not combine - the second silently replaces the first - so
       * the expiry window and the city search would have cancelled each other
       * out, and whichever was written last would have been the only filter
       * applied.
       */
      AND: [
        // Exclude expired-but-not-yet-swept listings (null expiry = never expires).
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        /*
         * A city matches if ANY spelling of it does. `citySearchKeys` returns
         * the folded query plus its transliterations and exonyms, so "Берлин",
         * "Munchen" and "Vienna" reach rows stored "Berlin", "München" and
         * "Wien". `contains` stays - a buyer half-remembers a city and types
         * "Frankfurt" for "Frankfurt am Main".
         */
        ...(cityKeys.length
          ? [{ OR: cityKeys.map((key) => ({ citySearch: { contains: key } })) }]
          : []),
      ],
      /*
       * The country is an EXACT code, never a `contains`. A city is free text a
       * seller typed and a buyer half-remembers, so it stays fuzzy; a country
       * arrives from a fixed list on both sides, and matching it loosely would
       * make "AT" answer a search for "A".
       *
       * A listing with no country is deliberately NOT returned here. Null means
       * "nobody said", and answering a country search with rows that never
       * claimed it is the same defect as backfilling the column.
       */
      ...(q.country ? { countryCode: q.country } : {}),
      /*
       * Case-insensitive, because these arrive from a dropdown on the site but
       * from a hand-written query string everywhere else, and "SEDAN" finding
       * nothing while "sedan" finds five reads as a broken filter rather than
       * as a typo.
       */
      ...(bodyType ? { bodyType: { equals: bodyType, mode: 'insensitive' as const } } : {}),
      ...(driveType ? { driveType: { equals: driveType, mode: 'insensitive' as const } } : {}),
      ...(q.priceFrom != null || q.priceTo != null
        ? { priceCents: { gte: q.priceFrom ?? undefined, lte: q.priceTo ?? undefined } }
        : {}),
      // Vehicle filters read the LISTING's own columns, not the report relation.
      // A manual listing has no report to join, and `(make, model, year)` is
      // indexed on the listing, so this is both correct and faster.
      /*
       * Both read the SEPARATOR-FREE column, and both are a `contains` rather
       * than an `equals`. Nobody agrees on the punctuation in a car name: the
       * table holds "Mercedes-Benz" and "C 220", and buyers type "mercedes
       * benz", "Mercedes", "C220" and "c-220" meaning the same car. An exact
       * match on the raw column answered every one of those with nothing.
       */
      ...(makeKey ? { makeSearch: { contains: makeKey } } : {}),
      ...(modelKey ? { modelSearch: { contains: modelKey } } : {}),
      ...(q.yearFrom != null || q.yearTo != null
        ? { year: { gte: q.yearFrom ?? undefined, lte: q.yearTo ?? undefined } }
        : {}),
      ...(q.mileageTo != null ? { mileageKm: { lte: q.mileageTo } } : {}),
      // Opt-IN filter. Manual listings are shown by default and badged as
      // self-declared: hiding them would make the showroom look empty for the
      // exact seller segment BE-S2 exists to serve. A buyer who only wants
      // inspected cars asks for them.
      ...(q.verifiedOnly ? { reportId: { not: null }, source: 'report' } : {}),
    };

    const orderBy = orderFor(q.sort);

    /*
     * The DTO has already refused a size outside the offered set, so this only
     * fills in the default. It is written as a membership test rather than a
     * clamp so the two cannot drift: adding a size to `PAGE_SIZES` is the whole
     * change.
     */
    const pageSize =
      q.perPage && (PAGE_SIZES as readonly number[]).includes(q.perPage)
        ? q.perPage
        : DEFAULT_PAGE_SIZE;

    const [rows, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { report: true },
      }),
      this.prisma.listing.count({ where }),
    ]);

    const items = await Promise.all(rows.map((l) => this.toCard(l)));
    return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
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
    // The detail page shows the whole mirrored subset. It was capped at 12
    // independently of MAX_LISTING_PHOTOS, so raising that constant alone
    // changed nothing here — and 12 no longer even covers the 17 required
    // exterior angles, let alone the cabin.
    const photos = await this.listingPhotos(listing, MAX_LISTING_PHOTOS);

    return {
      id: listing.id,
      priceCents: listing.priceCents,
      city: listing.city,
      countryCode: listing.countryCode,
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
      // Free, because it is a summary and not a finding: one number cannot say
      // WHICH panel was repainted, which is what the paid report is for.
      paintThicknessAvgUm: averagePaintThicknessUm(data),
      photos: await this.signPhotos(report.photosManifest, 2),
      vinMasked: report.vin ? this.maskVin(report.vin) : null,
      unlockPriceCents: await this.settings.getCents('payPerViewPriceEur'),
      currency: 'EUR',
      // PII (signatures, addresses, phones) is intentionally never included here.
    };
  }

  /**
   * The WHOLE report, free, for a car that is on sale - DEN-224.
   *
   * The report used to be sold per view: the page showed a summary and the
   * findings were behind a payment. That is reversed on the client's decision,
   * and this route is what makes it possible - the authed
   * `GET /reports/:id/full` answers 403 to anyone who has not bought the
   * report, so an anonymous reader could not reach it at all.
   *
   * THE GATE IS THE LISTING, NOT THE REPORT. A report becomes public because
   * its car is publicly for sale, so the same conditions the showroom applies
   * apply here: ACTIVE and not expired. A report whose owner never published a
   * car, or whose listing was taken down, stays unreachable - free to read is
   * a property of a listing on the market, not of every report we hold.
   */
  async reportFull(code: string) {
    const listing = await this.prisma.listing.findFirst({
      where: {
        status: 'ACTIVE',
        source: 'report',
        /*
         * NOT gated on `uploaded`, and that is deliberate - review finding 8
         * asked for it and the flag does not mean what the finding assumes.
         *
         * `uploaded` is set by `POST /reports/:id/complete`, which verifies
         * that THE PDF exists in R2. It says nothing about `reportData` or the
         * photo manifest, and this route serves no PDF. The paid route
         * (`ReportAccessService.getFull`) does not test it either: it returns
         * the findings and signs the PDF only when the flag is true.
         *
         * Requiring it here would make the free route stricter than the paid
         * one and would hide reports whose findings are complete because a
         * document nobody is being offered was never finished uploading.
         *
         * `checkReport` does test it, for a different question: it answers
         * "is there a report to buy", and what was for sale was the PDF.
         */
        report: { code, deletedAt: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { report: true },
    });
    const report = listing?.report;
    if (!report) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Report not found' } });
    }

    return {
      code: report.code,
      date: report.createdAt.toISOString(),
      qualityScore: report.qualityScore,
      tier: report.tier,
      vehicle: this.vehicle(report),
      /*
       * MASKED, exactly as in the preview beside it. The findings are free
       * now; the identifier that lets a stranger pull the car's registration,
       * finance and insurance records elsewhere is a separate thing, and
       * nothing in "show the report for free" asks for it. The buyer who is
       * actually standing in front of the car reads it off the windscreen.
       */
      vinMasked: report.vin ? this.maskVin(report.vin) : null,
      /*
       * `photos` is dropped out of the payload, and it is not a finding being
       * withheld. It is the app's own manifest - kind, angle, position, pixel
       * size - and the photographs themselves are delivered signed in the
       * field below. Left in, the generic renderer prints it as a section of
       * forty rows reading "Angle: exterior-left, Position: 1", underneath the
       * pictures it describes.
       */
      reportData: publicReportData(report.reportData, ['photos']),
      photos: await this.signPhotos(report.photosManifest, MAX_REPORT_PHOTOS),
      /*
       * NO PDF. The document is the inspector's own file: it carries the
       * signature image, the full VIN and whatever else the mobile app put on
       * the page, none of which passes through the masking above. Publishing
       * the findings does not publish the paperwork.
       */
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
      countryCode: listing.countryCode,
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
   *
   * Both branches answer the same question per image — is there a permanent
   * public copy of this object, or does it still need a 15-minute signature?
   * The two provenances answer it from different columns (`Listing`.
   * `publicPhotosMirroredAt` for the mirrored report subset, `ListingPhoto`.
   * `bucket` per row) because they are stored differently, but the fallback is
   * identical and it is the behaviour that shipped before this feature existed.
   */
  private async listingPhotos(
    listing: ListingWithReport,
    limit: number,
  ): Promise<{ url: string; kind?: string; angle?: string }[]> {
    if (listing.source === 'report' && listing.report) {
      return this.reportPhotos(listing, listing.report.photosManifest, limit);
    }
    const publicConfigured = this.r2.isPublicBucketConfigured();
    if (!this.r2.isConfigured() && !publicConfigured) return [];
    const rows = await this.prisma.listingPhoto.findMany({
      where: { listingId: listing.id },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    const out: { url: string; kind?: string; angle?: string }[] = [];
    for (const row of rows) {
      if (photoLocation(row.bucket, publicConfigured) === 'public') {
        out.push({ url: this.r2.publicObjectUrl(row.r2Key), kind: 'listing' });
        continue;
      }
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(row.r2Key);
        out.push({ url, kind: 'listing' });
      } catch {
        /* skip unsignable */
      }
    }
    return out;
  }

  /**
   * The report-backed gallery.
   *
   * `publicPhotosMirroredAt` is the switch: once the showroom subset has been
   * copied into the public bucket, every URL is the deterministic mirror key,
   * recomputed here from the same manifest entry the mirror read. No join table
   * remembers the mapping — the key IS the mapping, which is also what makes a
   * re-run of the mirror idempotent.
   *
   * The subset is capped at `MAX_LISTING_PHOTOS` on both sides. Asking for more
   * than was mirrored would produce URLs for objects that were never copied, so
   * anything past the cap falls back to a signed URL against the original.
   */
  private async reportPhotos(
    listing: ListingWithReport,
    manifest: Prisma.JsonValue | null,
    limit: number,
  ): Promise<{ url: string; kind?: string; angle?: string }[]> {
    if (listing.publicPhotosMirroredAt && this.r2.isPublicBucketConfigured()) {
      const refs = manifestPhotoRefs(manifest, Math.min(limit, MAX_LISTING_PHOTOS));
      const mirrored = refs.map((ref) => ({
        url: this.r2.publicObjectUrl(mirroredPhotoKey(listing.id, ref.s3Key)),
        ...(ref.kind ? { kind: ref.kind } : {}),
        ...(ref.angle ? { angle: ref.angle } : {}),
      }));
      // Every showroom caller asks for 1 or 12, so this is the only branch that
      // ever runs. The tail below exists so that raising the display limit past
      // the mirrored subset degrades to signed URLs instead of returning URLs
      // for objects that were never copied.
      if (limit <= MAX_LISTING_PHOTOS || mirrored.length < MAX_LISTING_PHOTOS) return mirrored;
      const rest = await this.signPhotos(manifest, limit);
      return [...mirrored, ...rest.slice(mirrored.length)];
    }
    return this.signPhotos(manifest, limit);
  }

  private async signPhotos(
    manifest: Prisma.JsonValue | null,
    limit: number,
  ): Promise<{ url: string; kind?: string; angle?: string }[]> {
    if (!this.r2.isConfigured()) return [];
    const refs = manifestPhotoRefs(manifest, limit);
    const out: { url: string; kind?: string; angle?: string }[] = [];
    for (const ref of refs) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(ref.s3Key);
        out.push({
          url,
          ...(ref.kind ? { kind: ref.kind } : {}),
          ...(ref.angle ? { angle: ref.angle } : {}),
        });
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
