import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Listing, ListingPhoto, Prisma, Report } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { StripeService } from '../payments/stripe.service';
import { PhotoProcessingService } from '../reports/photo-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import { CreateManualListingDto } from './dto/create-manual-listing.dto';
import {
  ListingPhotoDto,
  ListingPhotoListDto,
  UploadListingPhotoDto,
} from './dto/listing-photo.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import {
  ListingPackagesDto,
  MyListingsListDto,
  PublishResultDto,
} from './dto/listing-response.dto';
import {
  JsonObject,
  mergeVehicleData,
  normalizeVehicleDataDto,
  projectVehicleColumns,
  sanitizeVehicleData,
} from './listing-vehicle-data';

/**
 * Photos per listing. A gallery is a sales tool, not an archive: twenty shots
 * covers every angle a buyer looks at, and the cap bounds both the R2 spend and
 * the size of the public listing response.
 */
export const MAX_LISTING_PHOTOS = 20;

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);
  private readonly webOrigin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly r2: R2Service,
    private readonly photoProcessing: PhotoProcessingService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.webOrigin = config.get('web', { infer: true }).origin.replace(/\/$/, '');
  }

  /**
   * Claim a Report ID and open a DRAFT listing for it.
   *
   * The Report ID is a BEARER CAPABILITY: holding the code is the authorisation.
   * This replaces the previous device-link ownership check, and it is a
   * deliberate product trade-off — whoever sees a report code can list that car,
   * which is what makes the printed code useful to a seller who never installed
   * the app. The mitigations are that the claim is single-use, irreversible, and
   * throttled, and that the UI says so before the user commits.
   *
   * Single-use is enforced by `Listing.reportId @unique` rather than a second
   * "claimed" column. One source of truth cannot disagree with itself, and the
   * unique index is atomic at any isolation level, so concurrent claims resolve
   * correctly without a transaction or a lock. The column became NULLABLE when
   * manual listings arrived; Postgres treats NULLs as distinct in a unique
   * index, so unlimited manual listings coexist with the one-per-report rule.
   *
   * "Not found" and "already claimed" return the SAME 404. Distinguishing them
   * would turn this endpoint into an oracle for which report codes exist.
   */
  async create(userId: string, reportCode: string): Promise<Listing> {
    const report = await this.prisma.report.findFirst({
      where: { code: reportCode, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!report) throw this.unclaimable();

    try {
      return await this.prisma.listing.create({
        data: {
          sellerId: userId,
          reportId: report.id,
          source: 'report',
          status: 'DRAFT',
          package: 'standard',
          priceCents: 0,
          city: '',
          ...this.columnsFromReport(report),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Already claimed — by this user or anyone else. Same answer either way.
        throw this.unclaimable();
      }
      throw err;
    }
  }

  /**
   * BE-S2: open a DRAFT listing for a car that has NOT been inspected.
   *
   * No `Report` row is synthesised. A report carries a device id, an R2 key and
   * a tier, all NOT NULL and all meaningless for a seller who never ran an
   * inspection — and GDPR erasure keys off that `<tier>/<deviceId>/` layout. A
   * nullable `reportId` plus `source` states the truth instead of faking it, and
   * every read path that used to assume an inspection now has to say which of
   * the two it is looking at.
   */
  async createManual(userId: string, dto: CreateManualListingDto): Promise<Listing> {
    const vehicleData = dto.vehicleData ? normalizeVehicleDataDto(dto.vehicleData) : null;
    const columns: Partial<ReturnType<typeof projectVehicleColumns>> = vehicleData
      ? projectVehicleColumns(vehicleData)
      : {};

    return this.prisma.listing.create({
      data: {
        sellerId: userId,
        reportId: null,
        source: 'manual',
        status: 'DRAFT',
        package: 'standard',
        priceCents: dto.priceCents ?? 0,
        city: dto.city ?? '',
        plz: dto.plz ?? null,
        description: dto.description ?? null,
        contactPhone: dto.contactPhone ?? null,
        contactEmail: dto.contactEmail ?? null,
        ...columns,
        ...(vehicleData ? { vehicleData: vehicleData as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * The single response for every unsuccessful claim. Deliberately vague, and
   * deliberately identical whether the code is unknown, already claimed, or
   * belongs to someone else.
   *
   * Note the report's original owner is NOT reassigned on a claim: the device
   * that produced the report keeps it in its archive. Claiming grants the right
   * to sell the car, not ownership of the inspection.
   */
  private unclaimable(): NotFoundException {
    return new NotFoundException({
      error: {
        code: 'report_not_claimable',
        message: 'This Report ID is not available. It may not exist or may already be in use.',
      },
    });
  }

  /** Patch editable fields on an owned, non-deleted listing. */
  async update(userId: string, id: string, dto: UpdateListingDto): Promise<Listing> {
    const listing = await this.requireOwnedListing(userId, id);
    if (listing.status === 'DELETED') {
      throw new BadRequestException({
        error: { code: 'listing_deleted', message: 'Cannot edit a deleted listing' },
      });
    }

    let vehiclePatch: Prisma.ListingUpdateInput = {};
    if (dto.vehicleData !== undefined) {
      if (listing.source !== 'manual') {
        // An inspected listing's vehicle data IS the report. Letting the seller
        // edit it would let the listing contradict the document buyers trust.
        throw new BadRequestException({
          error: {
            code: 'vehicle_immutable',
            message:
              'This listing is backed by an inspection report; its vehicle data cannot be edited.',
          },
        });
      }
      const base = (listing.vehicleData ?? {}) as JsonObject;
      const merged = sanitizeVehicleData(
        mergeVehicleData(base, normalizeVehicleDataDto(dto.vehicleData)),
      );
      vehiclePatch = {
        ...projectVehicleColumns(merged),
        vehicleData: merged as Prisma.InputJsonValue,
      };
    }

    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.plz !== undefined ? { plz: dto.plz } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone } : {}),
        ...(dto.contactEmail !== undefined ? { contactEmail: dto.contactEmail } : {}),
        ...vehiclePatch,
      },
    });
  }

  /**
   * Publish an owned listing.
   * - standard: activate immediately.
   * - gold: create a Stripe Checkout (or auto-activate in mock mode).
   */
  async publish(
    userId: string,
    id: string,
    pkg: 'standard' | 'gold',
  ): Promise<PublishResultDto> {
    const listing = await this.requireOwnedListing(userId, id);
    await this.assertPublishable(listing);

    if (pkg === 'standard') {
      const { expiresAt } = await this.activateStandard(id);
      return {
        status: 'ACTIVE',
        expiresAt: expiresAt.toISOString(),
        amountCents: await this.settings.getCents('standardListingPriceEur'),
        currency: 'EUR',
      };
    }

    // Gold: charge via Stripe (or auto-activate in mock mode).
    const amountCents = await this.settings.getCents('goldPackagePriceEur');
    const payment = await this.prisma.payment.create({
      data: { purpose: 'gold', userId, amountCents, status: 'pending' },
    });

    if (!this.stripe.configured) {
      await this.payments.activateGoldListing(payment.id, id);
      return {
        checkoutUrl: `${this.webOrigin}/account/listings?gold=mock`,
        mock: true,
        amountCents,
        currency: 'EUR',
      };
    }

    const { checkoutUrl } = await this.stripe.createGoldCheckout({
      paymentId: payment.id,
      listingId: id,
      userId,
      amountCents,
      successUrl: `${this.webOrigin}/account/listings?gold=success`,
      cancelUrl: `${this.webOrigin}/account/listings`,
    });

    const session = checkoutUrl.match(/cs_[A-Za-z0-9_]+/)?.[0];
    if (session) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripeCheckoutSessionId: session },
      });
    }

    return { checkoutUrl, amountCents, currency: 'EUR' };
  }

  /**
   * The publish gate.
   *
   * A report-backed listing inherits its vehicle facts from an inspection that
   * already exists, so it only needs a price and a city. A MANUAL listing has no
   * such backstop: an empty card in the showroom is worse than no card, and a
   * car with no photo does not sell. The failure names every missing field so
   * the seller's form can highlight them all at once instead of the UI guessing.
   */
  private async assertPublishable(listing: Listing): Promise<void> {
    const missing: string[] = [];
    if (listing.priceCents <= 0) missing.push('priceCents');
    if (!listing.city) missing.push('city');

    if (listing.source === 'manual') {
      if (!listing.make) missing.push('make');
      if (!listing.model) missing.push('model');
      if (!listing.year) missing.push('year');
      const photos = await this.prisma.listingPhoto.count({ where: { listingId: listing.id } });
      if (photos < 1) missing.push('photos');
    }

    if (missing.length === 0) return;
    throw new BadRequestException({
      error: {
        code: 'incomplete_listing',
        message: `Cannot publish — missing: ${missing.join(', ')}`,
        missing,
      },
    });
  }

  /**
   * The package price list. Exists so the seller-facing picker renders live
   * tariffs — before this, the prices and the 30-day duration were hardcoded
   * strings inside the website's translation files, one copy per locale.
   */
  async packages(): Promise<ListingPackagesDto> {
    const [standardCents, goldCents, durationDays] = await Promise.all([
      this.settings.getCents('standardListingPriceEur'),
      this.settings.getCents('goldPackagePriceEur'),
      this.settings.getNumber('listingDurationDays'),
    ]);
    return {
      items: [
        { package: 'standard', amountCents: standardCents, currency: 'EUR', durationDays },
        { package: 'gold', amountCents: goldCents, currency: 'EUR', durationDays },
      ],
    };
  }

  /** Hide a listing from the showroom. */
  async unpublish(userId: string, id: string): Promise<Listing> {
    await this.requireOwnedListing(userId, id);
    return this.prisma.listing.update({ where: { id }, data: { status: 'HIDDEN' } });
  }

  /** Mark a listing sold. */
  async markSold(userId: string, id: string): Promise<Listing> {
    await this.requireOwnedListing(userId, id);
    return this.prisma.listing.update({ where: { id }, data: { status: 'SOLD' } });
  }

  /** Renew an EXPIRED/ACTIVE listing: extend expiry and set ACTIVE. */
  async renew(userId: string, id: string): Promise<Listing> {
    const listing = await this.requireOwnedListing(userId, id);
    if (listing.status !== 'EXPIRED' && listing.status !== 'ACTIVE') {
      throw new BadRequestException({
        error: { code: 'not_renewable', message: 'Only active or expired listings can be renewed' },
      });
    }
    const durationDays = await this.settings.getNumber('listingDurationDays');
    const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
    return this.prisma.listing.update({
      where: { id },
      data: { status: 'ACTIVE', expiresAt, publishedAt: listing.publishedAt ?? new Date() },
    });
  }

  // ============================================================
  // Photos (BE-S2) — the seller's own gallery
  //
  // Reuses `PhotoProcessingService` from the report pipeline unchanged: same
  // 1920 px / mozjpeg q80 / EXIF-stripped output, so a listing photo and a
  // report photo are the same kind of object in R2.
  // ============================================================

  async addPhoto(
    userId: string,
    listingId: string,
    dto: UploadListingPhotoDto,
    file: Express.Multer.File,
  ): Promise<ListingPhotoDto> {
    const listing = await this.requireOwnedListing(userId, listingId);

    if (!this.r2.isConfigured()) {
      throw new HttpException(
        { error: { code: 'storage_unavailable', message: 'Cloud storage is not configured' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const count = await this.prisma.listingPhoto.count({ where: { listingId } });
    if (count >= MAX_LISTING_PHOTOS) {
      throw new BadRequestException({
        error: {
          code: 'photo_limit_reached',
          message: `A listing may hold at most ${MAX_LISTING_PHOTOS} photos`,
          max: MAX_LISTING_PHOTOS,
        },
      });
    }

    const originalHash = createHash('sha256').update(file.buffer).digest('hex');
    if (dto.hash && dto.hash.toLowerCase() !== originalHash) {
      throw new BadRequestException({
        error: { code: 'hash_mismatch', message: 'Provided hash does not match the uploaded bytes' },
      });
    }

    // Same bytes already in this gallery — a retried upload, not a new photo.
    const duplicate = await this.prisma.listingPhoto.findFirst({
      where: { listingId, hash: originalHash },
    });
    if (duplicate) return this.toPhotoDto(duplicate);

    const processed = await this.photoProcessing.compress(file.buffer);
    const r2Key = `listings/${listing.sellerId}/${listingId}/${randomUUID()}.jpg`;
    await this.r2.putObject(r2Key, processed.data, 'image/jpeg');

    const highest = (
      await this.prisma.listingPhoto.aggregate({ where: { listingId }, _max: { order: true } })
    )._max.order;
    const order = dto.order ?? (highest === null ? 0 : highest + 1);

    const row = await this.prisma.listingPhoto.create({
      data: {
        listingId,
        r2Key,
        sizeBytes: processed.sizeBytes,
        sourceBytes: file.size,
        width: processed.width,
        height: processed.height,
        format: processed.format,
        hash: originalHash,
        order,
        caption: dto.caption ?? null,
      },
    });

    this.logger.log(
      `Stored listing photo ${row.id} for listing ${listingId} ` +
        `${file.size}→${processed.sizeBytes} bytes`,
    );
    return this.toPhotoDto(row);
  }

  async listPhotos(userId: string, listingId: string): Promise<ListingPhotoListDto> {
    await this.requireOwnedListing(userId, listingId);
    const rows = await this.prisma.listingPhoto.findMany({
      where: { listingId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    const items = await Promise.all(rows.map((r) => this.toPhotoDto(r)));
    return { items, max: MAX_LISTING_PHOTOS };
  }

  async deletePhoto(
    userId: string,
    listingId: string,
    photoId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.requireOwnedListing(userId, listingId);
    const photo = await this.prisma.listingPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.listingId !== listingId) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Photo not found' } });
    }
    if (this.r2.isConfigured()) {
      await this.r2.deleteObject(photo.r2Key).catch(() => undefined);
    }
    await this.prisma.listingPhoto.delete({ where: { id: photoId } });
    return { id: photoId, deleted: true };
  }

  /**
   * Reorder the whole gallery in one transaction. The request must name every
   * current photo exactly once — a partial reorder has no well-defined result,
   * and applying half of one leaves the gallery in an order the seller never
   * asked for.
   */
  async reorderPhotos(
    userId: string,
    listingId: string,
    ids: string[],
  ): Promise<ListingPhotoListDto> {
    await this.requireOwnedListing(userId, listingId);
    const current = await this.prisma.listingPhoto.findMany({
      where: { listingId },
      select: { id: true },
    });
    const currentIds = new Set(current.map((p) => p.id));
    const givenIds = new Set(ids);

    const sameSize = currentIds.size === givenIds.size && givenIds.size === ids.length;
    const sameMembers = ids.every((id) => currentIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new BadRequestException({
        error: {
          code: 'photo_order_mismatch',
          message: 'ids must list every photo of this listing exactly once',
          expected: current.map((p) => p.id),
        },
      });
    }

    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.listingPhoto.update({ where: { id }, data: { order: index } }),
      ),
    );
    return this.listPhotos(userId, listingId);
  }

  private async toPhotoDto(photo: ListingPhoto): Promise<ListingPhotoDto> {
    let url: string | null = null;
    if (this.r2.isConfigured()) {
      url = await this.r2
        .createPresignedDownloadUrl(photo.r2Key)
        .then((r) => r.url)
        .catch(() => null);
    }
    return {
      id: photo.id,
      order: photo.order,
      caption: photo.caption,
      width: photo.width,
      height: photo.height,
      sizeBytes: photo.sizeBytes,
      url,
      createdAt: photo.createdAt.toISOString(),
    };
  }

  // ============================================================
  // Admin overrides (E9) — skip seller-ownership checks
  // ============================================================

  /** Admin: hide any listing from the showroom. */
  async adminHide(id: string): Promise<Listing> {
    await this.requireListing(id);
    return this.prisma.listing.update({ where: { id }, data: { status: 'HIDDEN' } });
  }

  /**
   * Admin: restore a hidden/expired listing. Returns it to ACTIVE if its
   * expiry is still in the future, otherwise EXPIRED.
   */
  async adminUnhide(id: string): Promise<Listing> {
    const listing = await this.requireListing(id);
    const stillValid = listing.expiresAt ? listing.expiresAt.getTime() > Date.now() : false;
    return this.prisma.listing.update({
      where: { id },
      data: { status: stillValid ? 'ACTIVE' : 'EXPIRED' },
    });
  }

  /** Admin: extend a listing's expiry by listingDurationDays and set it ACTIVE. */
  async adminRenew(id: string): Promise<Listing> {
    const listing = await this.requireListing(id);
    const durationDays = await this.settings.getNumber('listingDurationDays');
    const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
    return this.prisma.listing.update({
      where: { id },
      data: { status: 'ACTIVE', expiresAt, publishedAt: listing.publishedAt ?? new Date() },
    });
  }

  /** Load a listing by id (no ownership check), or throw 404. */
  private async requireListing(id: string): Promise<Listing> {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'Listing not found' },
      });
    }
    return listing;
  }

  /** List the current user's listings (any status except DELETED). */
  async listMine(userId: string): Promise<MyListingsListDto> {
    const listings = await this.prisma.listing.findMany({
      where: { sellerId: userId, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      include: { report: { select: { code: true } }, _count: { select: { photos: true } } },
    });

    const items = listings.map((l) => ({
      id: l.id,
      status: l.status,
      source: l.source,
      package: l.package,
      priceCents: l.priceCents,
      city: l.city,
      plz: l.plz,
      description: l.description,
      // Read from the listing's own columns: for a manual listing there is no
      // report to read from, and for a report-backed one these were copied at
      // claim time (and backfilled for pre-existing rows).
      vehicle: {
        make: l.make,
        model: l.model,
        year: l.year,
        mileageKm: l.mileageKm,
      },
      reportCode: l.report?.code ?? null,
      photoCount: l._count.photos,
      publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
      expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
      viewsCount: l.viewsCount,
    }));

    return { items };
  }

  /**
   * Flip ACTIVE listings whose expiry has passed to EXPIRED. Exposed for the
   * cron/worker. Returns the number of listings swept. Emits a
   * `listing.expiring` notification to each affected seller (non-throwing).
   */
  async expireOverdue(): Promise<number> {
    const overdue = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    });
    if (overdue.length === 0) return 0;

    const { count } = await this.prisma.listing.updateMany({
      where: { id: { in: overdue.map((l) => l.id) } },
      data: { status: 'EXPIRED' },
    });

    for (const l of overdue) {
      await this.notifications.notify(l.sellerId, 'listing.expiring', {
        listingId: l.id,
        make: l.make,
        model: l.model,
      });
    }
    if (count > 0) this.logger.log(`Expired ${count} overdue listing(s)`);
    return count;
  }

  /**
   * Emit a `listing.published` notification to the seller (non-throwing).
   * Public so the Gold activation path in PaymentsService can reuse it.
   */
  async notifyListingPublished(listingId: string): Promise<void> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) return;
    await this.notifications.notify(listing.sellerId, 'listing.published', {
      listingId: listing.id,
      make: listing.make,
      model: listing.model,
    });
  }

  private async activateStandard(id: string): Promise<{ expiresAt: Date }> {
    const durationDays = await this.settings.getNumber('listingDurationDays');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 86_400_000);
    await this.prisma.listing.update({
      where: { id },
      data: { status: 'ACTIVE', package: 'standard', publishedAt: now, expiresAt },
    });
    await this.notifyListingPublished(id);
    return { expiresAt };
  }

  /** Load a listing the user owns, or throw 404/403. */
  private async requireOwnedListing(userId: string, id: string): Promise<Listing> {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'Listing not found' },
      });
    }
    if (listing.sellerId !== userId) {
      throw new ForbiddenException({
        error: { code: 'not_listing_owner', message: 'You do not own this listing' },
      });
    }
    return listing;
  }

  /**
   * Denormalise a report onto the listing's own columns.
   *
   * `fuelType`/`transmission`/`tuvDate`/`firstRegistration` only ever existed
   * inside the structured `reportData` payload, never as report columns, so they
   * are read out of the JSON — the same keys the mobile app writes.
   */
  private columnsFromReport(report: Report): Partial<Prisma.ListingUncheckedCreateInput> {
    const data = (report.reportData ?? {}) as JsonObject;
    const fromJson = projectVehicleColumns(data);
    return {
      vin: report.vin,
      make: report.make,
      model: report.model,
      year: report.year,
      mileageKm: report.mileageKm,
      color: report.color ?? fromJson.color,
      bodyType: report.bodyType ?? fromJson.bodyType,
      driveType: report.driveType ?? fromJson.driveType,
      fuelType: fromJson.fuelType,
      transmission: fromJson.transmission,
      powerKw: fromJson.powerKw,
      firstRegistration: fromJson.firstRegistration,
      huValidUntil: fromJson.huValidUntil,
    };
  }
}
