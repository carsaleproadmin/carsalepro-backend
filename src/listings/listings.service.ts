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
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
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
import {
  MAX_LISTING_PHOTOS,
  manifestPhotoRefs,
  mirroredPhotoKey,
  photoLocation,
} from './listing-photo-urls';

export { MAX_LISTING_PHOTOS };

/** What one call to {@link ListingsService.mirrorShowroomPhotos} did. */
export interface ShowroomMirrorResult {
  listingId: string;
  /** Report photos copied into the public bucket under a deterministic key. */
  mirrored: number;
  /** Seller-uploaded `ListingPhoto` rows moved from the private bucket. */
  promoted: number;
  /** Objects that could not be copied. A non-zero value leaves the stamp unset. */
  failed: number;
  /** True when there was nothing to do (public bucket unconfigured, or done). */
  skipped: boolean;
}

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

  /**
   * Read one listing the caller owns, in full.
   *
   * `GET /me/listings` is a summary projection and the public route only serves
   * ACTIVE rows, so neither can rehydrate a DRAFT in the multi-stage editor.
   */
  async getOwned(userId: string, id: string): Promise<Listing> {
    return this.requireOwnedListing(userId, id);
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

    const { checkoutUrl, sessionId } = await this.stripe.createGoldCheckout({
      paymentId: payment.id,
      listingId: id,
      userId,
      amountCents,
      successUrl: `${this.webOrigin}/account/listings?gold=success`,
      cancelUrl: `${this.webOrigin}/account/listings`,
    });

    // Stripe hands us the session id; it used to be scraped out of the URL with
    // a regex whose failure was silent, leaving the payment with no session id
    // and reconciliation with nothing to ask Stripe about.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: sessionId },
    });

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
    // Called for its ownership CHECK, which throws. The returned row stopped
    // being needed when the seller id came out of the object key.
    await this.requireOwnedListing(userId, listingId);

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
    // The seller id is deliberately NOT in the key.
    //
    // Once the public bucket is configured this key becomes a permanent,
    // unsigned URL. A stable seller identifier in it is a correlation handle:
    // every advert by one pseudonymous seller becomes linkable from an image
    // URL alone, without ever loading a page. `mirroredPhotoKey` already goes
    // out of its way to hash the source so a device id and report id cannot
    // appear in a public URL, and this is the same rule applied to the other
    // way an image gets there. The listing id is already public — it is in the
    // page URL — and a UUID carries nothing.
    //
    // Existing rows keep their old keys: `ListingPhoto.r2Key` is stored, so
    // this changes new uploads only and needs no migration.
    const r2Key = `listings/${listingId}/${randomUUID()}.jpg`;
    // A new photo goes straight to the public bucket when one is configured:
    // same key, different bucket, so nothing downstream has to translate keys
    // and the migration script can treat an old row exactly like a new one.
    //
    // Deliberately NOT gated on the listing already being published. Gating it
    // would strand every DRAFT photo in the private bucket (a manual listing
    // cannot be published without a photo, so that is where most uploads
    // happen) and need a second promotion pass for objects that were private
    // for no reason but the gate. A draft's URL is only ever handed to its
    // owner, over a key that still carries a random UUID — exactly as
    // unguessable as the presigned URL it replaces, merely permanent.
    const bucket = this.r2.isPublicBucketConfigured()
      ? await this.r2.publicPutObject(r2Key, processed.data, 'image/jpeg')
      : await this.r2.putObject(r2Key, processed.data, 'image/jpeg').then(() => null);

    const highest = (
      await this.prisma.listingPhoto.aggregate({ where: { listingId }, _max: { order: true } })
    )._max.order;
    const order = dto.order ?? (highest === null ? 0 : highest + 1);

    const row = await this.prisma.listingPhoto.create({
      data: {
        listingId,
        r2Key,
        bucket,
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
      // Delete from whichever bucket the ROW says the object is in. Deleting
      // from the wrong one is silent (both calls swallow a 404), and would
      // leave a permanently public object behind after the seller removed it.
      const location = photoLocation(photo.bucket, this.r2.isPublicBucketConfigured());
      const remove =
        location === 'public'
          ? this.r2.publicDeleteObject(photo.r2Key)
          : this.r2.deleteObject(photo.r2Key);
      await remove.catch(() => undefined);
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
    if (photoLocation(photo.bucket, this.r2.isPublicBucketConfigured()) === 'public') {
      url = this.r2.publicObjectUrl(photo.r2Key);
    } else if (this.r2.isConfigured()) {
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
   * The publication hook: notify the seller, then make sure the listing's
   * showroom photos have permanent URLs. Both paths run through it — Standard
   * from `activateStandard`, Gold from `PaymentsService.activateGoldListing`
   * once Stripe confirms — which is why the mirror hangs off it rather than off
   * `publish()`: a Gold listing goes live in a webhook, not in the request that
   * started the checkout.
   *
   * Neither half may throw into the caller. A notification that fails must not
   * unpublish a paid listing, and neither must a photo copy — an un-mirrored
   * listing simply keeps serving signed URLs and is picked up by the nightly
   * backlog pass.
   */
  async notifyListingPublished(listingId: string): Promise<void> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) return;
    await this.notifications.notify(listing.sellerId, 'listing.published', {
      listingId: listing.id,
      make: listing.make,
      model: listing.model,
    });
    try {
      await this.mirrorShowroomPhotos(listingId);
    } catch (err) {
      this.logger.error(
        `mirrorShowroomPhotos failed for listing ${listingId}: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // Permanent showroom image URLs
  //
  // Showroom images used to be 15-minute presigned URLs: a shared link died, a
  // crawler indexed an expired URL, and no CDN could cache anything because the
  // query string changed on every render. The fix is a SEPARATE public bucket —
  // publicity in R2 is a property of the bucket, so "publish the `listings/`
  // prefix" does not exist, and publishing the reports bucket would publish the
  // paid inspection PDFs sitting in it.
  //
  // With `R2_PUBLIC_*` unset every method below is a no-op, `ListingPhoto.bucket`
  // stays NULL everywhere, and behaviour is byte-for-byte what it was.
  // ============================================================

  /**
   * Put this listing's showroom photos in the public bucket.
   *
   * Two distinct jobs, because the two kinds of listing keep their pictures in
   * completely different places:
   *
   * - a MANUAL listing owns `ListingPhoto` rows; a row uploaded before the
   *   public bucket existed is *promoted* — same key, copied into the public
   *   bucket, `bucket` recorded on the row;
   * - a REPORT-backed listing owns no rows at all. Its images are entries in
   *   `Report.photosManifest`, in the private reports bucket beside the paid
   *   PDF, and they must stay there: they are the inspection's evidence, sold
   *   per view. So the showroom subset is *mirrored* — copied under
   *   `mirroredPhotoKey`, which the read path recomputes from the manifest.
   *   The price is a second copy of at most 20 x ~300 KB per listing. That is
   *   the cost of not exposing the reports bucket, and it is the right trade.
   *
   * Nothing is ever deleted from the reports bucket here. Reclaiming that space
   * is a separate, later pass once the public copies are proven — and it is also
   * what makes the `private` fallback in `photoLocation` safe.
   *
   * Idempotent by construction: promotion skips rows that already name a bucket,
   * and the mirror writes deterministic keys, so a second run overwrites the
   * same bytes at the same URLs instead of accumulating copies.
   */
  async mirrorShowroomPhotos(listingId: string): Promise<ShowroomMirrorResult> {
    const result: ShowroomMirrorResult = {
      listingId,
      mirrored: 0,
      promoted: 0,
      failed: 0,
      skipped: true,
    };
    if (!this.r2.isPublicBucketConfigured()) return result;

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { report: { select: { photosManifest: true } } },
    });
    if (!listing) return result;
    result.skipped = false;

    // 1. Seller uploads still sitting in the private bucket.
    const privateRows = await this.prisma.listingPhoto.findMany({
      where: { listingId, bucket: null },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      take: MAX_LISTING_PHOTOS,
    });
    for (const row of privateRows) {
      try {
        const bytes = await this.r2.getObjectBytes(row.r2Key);
        if (!bytes) {
          // The row already points at nothing; a signed URL for it 404s just as
          // loudly. Not a failure of the copy.
          this.logger.warn(`Listing photo ${row.id} has no object at ${row.r2Key} — skipped`);
          continue;
        }
        const bucket = await this.r2.publicPutObject(row.r2Key, bytes, 'image/jpeg');
        await this.prisma.listingPhoto.update({ where: { id: row.id }, data: { bucket } });
        result.promoted += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Promoting listing photo ${row.id} to the public bucket failed: ` +
            `${(err as Error).message}`,
        );
      }
    }

    // 2. The report's own photos.
    const refs = manifestPhotoRefs(listing.report?.photosManifest, MAX_LISTING_PHOTOS);
    for (const ref of refs) {
      try {
        const bytes = await this.r2.getObjectBytes(ref.s3Key);
        if (!bytes) {
          this.logger.warn(`Report photo ${ref.s3Key} is missing — not mirrored`);
          continue;
        }
        await this.r2.publicPutObject(mirroredPhotoKey(listingId, ref.s3Key), bytes, 'image/jpeg');
        result.mirrored += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Mirroring ${ref.s3Key} for listing ${listingId} failed: ${(err as Error).message}`,
        );
      }
    }

    // The stamp is what switches the READ path over, so it is only set when
    // every copy that could be made was made. A partially-mirrored listing keeps
    // serving signed URLs and is retried by the nightly pass; stamping
    // optimistically would turn one transient R2 error into a permanently broken
    // image on a live advert.
    if (result.failed === 0) {
      await this.prisma.listing.update({
        where: { id: listingId },
        data: { publicPhotosMirroredAt: new Date() },
      });
    }
    if (result.mirrored > 0 || result.promoted > 0) {
      this.logger.log(
        `Listing ${listingId}: mirrored ${result.mirrored} report photo(s), ` +
          `promoted ${result.promoted} upload(s), ${result.failed} failure(s)`,
      );
    }
    return result;
  }

  /**
   * The backlog pass: mirror listings that went live before the public bucket
   * existed, or whose mirror failed. Exposed for the nightly cron.
   *
   * Batched on purpose — every object is a download from one bucket and an
   * upload to another, so an unbounded sweep of the whole showroom on the first
   * night after the switch is a self-inflicted R2 bill. It is resumable: each
   * listing records its own completion, so the next run starts where this one
   * stopped.
   */
  /**
   * Remove the PUBLIC copies of a seller's showroom images, for GDPR erasure.
   *
   * This lives here, and not in the two erasure paths, because there are two of
   * them: the mobile `DELETE /me` and the website `DELETE /api/v1/users/me`.
   * The mobile one swept the private reports bucket; the website one deleted no
   * objects at all, which was survivable only while every showroom image was a
   * 15-minute signed URL. Once photos moved to a public bucket with
   * `Cache-Control: immutable`, a website-only seller — who has no `DeviceLink`
   * and never touches the mobile path — could erase their account and leave
   * their driveway, house number and number plate readable at a permanent,
   * unsigned URL forever.
   *
   * Two shapes, matching the two ways an image gets there:
   *   - seller uploads: `ListingPhoto` rows whose `bucket` is set, at their key;
   *   - mirrored report photos: no row at all, so the keys are recomputed from
   *     the report manifest exactly as the mirror derived them.
   *
   * Best-effort and non-throwing: a failed delete must not abort an erasure that
   * has already anonymised the account. The mirror stamp is cleared either way,
   * so the read path stops pointing at objects that are meant to be gone.
   */
  async erasePublicPhotoObjects(userId: string): Promise<number> {
    if (!this.r2.isPublicBucketConfigured()) return 0;

    let deleted = 0;
    const rows = await this.prisma.listingPhoto.findMany({
      where: { bucket: { not: null }, listing: { sellerId: userId } },
      select: { r2Key: true },
    });
    const listings = await this.prisma.listing.findMany({
      where: { sellerId: userId, publicPhotosMirroredAt: { not: null } },
      select: { id: true, report: { select: { photosManifest: true } } },
    });

    // Derived from the WHOLE manifest, not from the mirrored subset.
    //
    // The subset is "the first MAX_LISTING_PHOTOS entries in manifest order",
    // and both halves of that have moved: the cap went 20 -> 32 -> 40, and the order
    // is now the catalog walk-around rather than `kind ASC`. Anything mirrored
    // under the old rule and no longer in the new top-N would be skipped here —
    // leaving a permanent, unsigned, CDN-cached public photograph of a car
    // whose owner has just asked to be erased. Computing the key set from every
    // entry costs a few `publicDeleteObject` calls that 404 harmlessly, and
    // this method already treats a failed delete as non-fatal.
    const keys = [
      ...rows.map((r) => r.r2Key),
      ...listings.flatMap((l) =>
        manifestPhotoRefs(l.report?.photosManifest, Number.MAX_SAFE_INTEGER).map((ref) =>
          mirroredPhotoKey(l.id, ref.s3Key),
        ),
      ),
    ];

    for (const key of keys) {
      try {
        await this.r2.publicDeleteObject(key);
        deleted += 1;
      } catch (err) {
        this.logger.error(
          `GDPR erasure could not delete public object ${key}: ${(err as Error).message}`,
        );
      }
    }
    if (listings.length > 0) {
      await this.prisma.listing.updateMany({
        where: { id: { in: listings.map((l) => l.id) } },
        data: { publicPhotosMirroredAt: null },
      });
    }
    return deleted;
  }

  async mirrorPendingShowroomPhotos(
    batchSize = 50,
  ): Promise<{ scanned: number; mirrored: number; promoted: number; failed: number }> {
    const totals = { scanned: 0, mirrored: 0, promoted: 0, failed: 0 };
    if (!this.r2.isPublicBucketConfigured()) return totals;

    const pending = await this.prisma.listing.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { publicPhotosMirroredAt: null },
          // A listing stamped before a seller added a photo, or whose promotion
          // failed: the row's own NULL bucket is the authority, not the stamp.
          { photos: { some: { bucket: null } } },
        ],
      },
      select: { id: true },
      orderBy: { publishedAt: 'asc' },
      take: batchSize,
    });

    for (const { id } of pending) {
      totals.scanned += 1;
      try {
        const one = await this.mirrorShowroomPhotos(id);
        totals.mirrored += one.mirrored;
        totals.promoted += one.promoted;
        totals.failed += one.failed;
      } catch (err) {
        totals.failed += 1;
        this.logger.error(
          `mirrorShowroomPhotos failed for listing ${id}: ${(err as Error).message}`,
        );
      }
    }
    if (totals.scanned > 0) {
      this.logger.log(
        `mirrorPendingShowroomPhotos: ${totals.scanned} listing(s), ` +
          `${totals.mirrored} mirrored, ${totals.promoted} promoted, ${totals.failed} failed`,
      );
    }
    return totals;
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
