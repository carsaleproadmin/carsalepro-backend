import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Listing, Prisma } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UpdateListingDto } from './dto/update-listing.dto';
import {
  ListingPackagesDto,
  MyListingsListDto,
  PublishResultDto,
} from './dto/listing-response.dto';

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
   * correctly without a transaction or a lock.
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
          status: 'DRAFT',
          package: 'standard',
          priceCents: 0,
          city: '',
          color: report.color,
          bodyType: report.bodyType,
          driveType: report.driveType,
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

    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.plz !== undefined ? { plz: dto.plz } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone } : {}),
        ...(dto.contactEmail !== undefined ? { contactEmail: dto.contactEmail } : {}),
      },
    });
  }

  /**
   * Publish an owned listing. Requires priceCents > 0 and a city.
   * - standard: activate immediately.
   * - gold: create a Stripe Checkout (or auto-activate in mock mode).
   */
  async publish(
    userId: string,
    id: string,
    pkg: 'standard' | 'gold',
  ): Promise<PublishResultDto> {
    const listing = await this.requireOwnedListing(userId, id);

    if (listing.priceCents <= 0 || !listing.city) {
      throw new BadRequestException({
        error: { code: 'incomplete_listing', message: 'A price and city are required to publish' },
      });
    }

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
      include: { report: true },
    });

    const items = listings.map((l) => ({
      id: l.id,
      status: l.status,
      package: l.package,
      priceCents: l.priceCents,
      city: l.city,
      plz: l.plz,
      description: l.description,
      vehicle: {
        make: l.report.make,
        model: l.report.model,
        year: l.report.year,
        mileageKm: l.report.mileageKm,
      },
      reportCode: l.report.code,
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
      include: { report: true },
    });
    if (overdue.length === 0) return 0;

    const { count } = await this.prisma.listing.updateMany({
      where: { id: { in: overdue.map((l) => l.id) } },
      data: { status: 'EXPIRED' },
    });

    for (const l of overdue) {
      await this.notifications.notify(l.sellerId, 'listing.expiring', {
        listingId: l.id,
        make: l.report.make,
        model: l.report.model,
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
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { report: true },
    });
    if (!listing) return;
    await this.notifications.notify(listing.sellerId, 'listing.published', {
      listingId: listing.id,
      make: listing.report.make,
      model: listing.report.model,
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

}
