import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { GeoService, NearestInspector } from '../geo/geo.service';
import { RouteEstimate, RoutingService } from '../geo/routing.service';
import { LegalContractService } from '../legal/legal-contract.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';
import { PaymentsService } from '../payments/payments.service';
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  CreateOrderDto,
  InspectorStatusUpdate,
  OrderRole,
  QuoteOrderDto,
} from './dto/order.dto';
import { canTransition } from './order-state-machine';
import { PriceBreakdown, computePrice } from './order-pricing';

/**
 * Result of a server-side quote.
 *
 * `breakdown` is additive-only: `baseFeeCents`, `distanceFeeCents`, `distanceKm`
 * and `totalCents` are the shape the website has always read, and every new
 * field sits alongside them. `minimumFareTopUpCents` and `surgeFeeCents` are
 * separate named lines on purpose — a floor or a multiplier that silently
 * inflates the total is the exact dark pattern an itemised quote exists to
 * avoid.
 */
export interface QuoteResult {
  available: boolean;
  currency?: string;
  totalCents?: number;
  breakdown?: {
    baseFeeCents: number;
    distanceFeeCents: number;
    distanceKm: number;
    /** 'road' when a routing provider answered, 'straight_line' when estimated. */
    distanceSource: 'road' | 'straight_line';
    durationMin: number;
    timeFeeCents: number;
    subtotalCents: number;
    surgeMultiplier: number;
    surgeFeeCents: number;
    peakApplied: boolean;
    minimumFareCents: number;
    minimumFareTopUpCents: number;
    minimumFareApplied: boolean;
  };
  nearestKm?: number;
  candidates?: Array<{ displayName: string | null; company: string | null; distanceKm: number }>;
}

/** Full priced quote, including the cents fields needed to persist an order. */
interface PricedQuote {
  available: boolean;
  nearest?: NearestInspector;
  candidates: NearestInspector[];
  price: PriceBreakdown;
  routingSource: RouteEstimate['source'];
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly routing: RoutingService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeService,
    private readonly payments: PaymentsService,
    private readonly legalContract: LegalContractService,
    private readonly notifications: NotificationsService,
  ) {}

  // ============================================================
  // Pricing
  // ============================================================

  /**
   * Single source of truth for pricing.
   *
   * Candidates are RANKED by PostGIS great-circle distance (cheap, indexed), but
   * the winner is then PRICED on a road route where one is available — routing
   * every candidate would cost three provider calls to change an ordering that
   * straight-line distance already gets right.
   *
   * The arithmetic itself lives in the pure `computePrice`; this method only
   * gathers inputs. All money is integer cents.
   */
  private async priceQuote(lat: number, lng: number, scheduledAt: Date): Promise<PricedQuote> {
    const [
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      radiusKm,
      surgeMultiplier,
      peakMultiplier,
      peakStartHour,
      peakEndHour,
      detourFactor,
      cacheHours,
    ] = await Promise.all([
      this.settings.getCents('orderBaseFeeEur'),
      this.settings.getCents('orderRatePerKmEur'),
      this.settings.getCents('orderRatePerMinuteEur'),
      this.settings.getCents('orderMinimumFareEur'),
      this.settings.getNumber('platformFeePercent'),
      this.settings.getNumber('expertSearchRadiusKm'),
      this.settings.getNumber('orderSurgeMultiplier'),
      this.settings.getNumber('orderPeakMultiplier'),
      this.settings.getNumber('orderPeakStartHour'),
      this.settings.getNumber('orderPeakEndHour'),
      this.settings.getNumber('orderDetourFactor'),
      this.settings.getNumber('orderRoutingCacheHours'),
    ]);

    const tariff = {
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      surgeMultiplier,
      peakMultiplier,
      peakStartHour,
      peakEndHour,
    };

    const candidates = await this.geo.findNearestInspectors(lat, lng, radiusKm, 3);

    if (candidates.length === 0) {
      return {
        available: false,
        candidates: [],
        routingSource: 'haversine',
        price: computePrice({ distanceKm: 0, durationMin: 0, scheduledAt, tariff }),
      };
    }

    const nearest = candidates[0];
    const route = await this.routing.estimate(
      { lat: nearest.lat, lng: nearest.lng },
      { lat, lng },
      detourFactor,
      cacheHours,
    );

    return {
      available: true,
      nearest,
      candidates,
      routingSource: route.source,
      price: computePrice({
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        scheduledAt,
        tariff,
      }),
    };
  }

  /** Public quote. On no coverage, records a WaitlistEntry from the user email. */
  async quote(userId: string, dto: QuoteOrderDto): Promise<QuoteResult> {
    const priced = await this.priceQuote(dto.lat, dto.lng, new Date(dto.scheduledAt));

    if (!priced.available) {
      await this.addToWaitlist(userId, dto.lat, dto.lng);
      return { available: false };
    }

    const p = priced.price;
    return {
      available: true,
      currency: 'EUR',
      totalCents: p.totalCents,
      breakdown: {
        baseFeeCents: p.baseFeeCents,
        distanceFeeCents: p.distanceFeeCents,
        distanceKm: p.distanceKm,
        distanceSource: priced.routingSource === 'mapbox' ? 'road' : 'straight_line',
        durationMin: p.durationMin,
        timeFeeCents: p.timeFeeCents,
        subtotalCents: p.subtotalCents,
        surgeMultiplier: p.surgeMultiplier,
        surgeFeeCents: p.surgeFeeCents,
        peakApplied: p.peakApplied,
        minimumFareCents: p.minimumFareCents,
        minimumFareTopUpCents: p.minimumFareTopUpCents,
        minimumFareApplied: p.minimumFareApplied,
      },
      // Straight-line distance to each candidate — this is a "who is near you"
      // list, not a priced figure, so it stays on the cheap measure.
      nearestKm: priced.nearest!.distanceKm,
      candidates: priced.candidates.slice(0, 3).map((c) => ({
        displayName: c.displayName,
        company: c.companyName,
        distanceKm: c.distanceKm,
      })),
    };
  }

  private async addToWaitlist(userId: string, lat: number, lng: number): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) return;
    const entry = await this.prisma.waitlistEntry.create({ data: { email: user.email } });
    await this.geo.setWaitlistLocation(entry.id, lat, lng);
  }

  // ============================================================
  // Order creation
  // ============================================================

  async createOrder(
    userId: string,
    dto: CreateOrderDto,
  ): Promise<{ orderId: string; paymentClientSecret: string | null; mock?: boolean }> {
    // Re-run the quote server-side; the client price is never trusted. This
    // also re-evaluates surge and the peak window against the scheduled time,
    // so a stale quote cannot lock in yesterday's multiplier.
    const priced = await this.priceQuote(dto.lat, dto.lng, new Date(dto.scheduledAt));
    if (!priced.available) {
      throw new ConflictException({
        error: { code: 'no_coverage', message: 'No inspector available in your area' },
      });
    }

    const number = await this.generateOrderNumber();

    // Order.location is NOT NULL geography(Unsupported) — insert via raw SQL so
    // the geography is set inline at insert time.
    const orderId = await this.insertOrder(number, userId, dto, priced);

    const payment = await this.prisma.payment.create({
      data: {
        purpose: 'order',
        orderId,
        userId,
        amountCents: priced.price.totalCents,
        currency: 'EUR',
        status: 'pending',
      },
    });

    // E11: confirm the order was placed (non-throwing).
    await this.notifications.notify(userId, 'order.created', {
      orderId,
      orderNumber: number,
      make: dto.make,
      model: dto.model,
      totalCents: priced.price.totalCents,
    });

    if (this.stripe.configured) {
      const pi = await this.stripe.createOrderPaymentIntent({
        amountCents: priced.price.totalCents,
        orderId,
        paymentId: payment.id,
        userId,
      });
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: pi.id },
      });
      // Order stays CREATED until the payment_intent.succeeded webhook → PAID.
      return { orderId, paymentClientSecret: pi.client_secret ?? null };
    }

    // MOCK mode: settle immediately, transition to PAID, dispatch.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'succeeded' },
    });
    await this.transition(orderId, OrderStatus.PAID, userId);
    await this.dispatch(orderId);
    return { orderId, paymentClientSecret: null, mock: true };
  }

  /** Insert an Order with its geography set inline (raw SQL). Returns the id. */
  private async insertOrder(
    number: string,
    customerId: string,
    dto: CreateOrderDto,
    priced: PricedQuote,
  ): Promise<string> {
    // The order row is inserted with raw SQL (PostGIS geography), so Prisma's
    // `@default(cuid())` never runs and we mint the id here. The column is a
    // plain text PK, so any unique string works.
    const id = randomUUID();
    const p = priced.price;
    const distanceKm = new Prisma.Decimal(p.distanceKm);
    const surgeMultiplier = new Prisma.Decimal(p.surgeMultiplier.toFixed(2));
    await this.prisma.$executeRaw`
      INSERT INTO "order" (
        id, number, customer_id, status, vin, make, model, listing_url, address,
        location, scheduled_at, country_code,
        base_fee_cents, distance_km, distance_fee_cents, duration_min,
        time_fee_cents, surge_multiplier, minimum_fare_applied, routing_source,
        total_cents, platform_fee_cents, inspector_share_cents, currency, "createdAt"
      ) VALUES (
        ${id}, ${number}, ${customerId}, 'CREATED'::"OrderStatus",
        ${dto.vin?.toUpperCase() ?? null}, ${dto.make}, ${dto.model},
        ${dto.listingUrl ?? null}, ${dto.address},
        ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
        ${new Date(dto.scheduledAt)}, 'DE',
        ${p.baseFeeCents}, ${distanceKm}, ${p.distanceFeeCents}, ${p.durationMin},
        ${p.timeFeeCents}, ${surgeMultiplier}, ${p.minimumFareApplied}, ${priced.routingSource},
        ${p.totalCents}, ${p.platformFeeCents}, ${p.inspectorShareCents},
        'EUR', ${new Date()}
      )
    `;
    return id;
  }

  /** ORD-#### unique order number; retries on the (rare) collision. */
  private async generateOrderNumber(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const n = 1000 + Math.floor(Math.random() * 9000);
      const number = `ORD-${n}`;
      const existing = await this.prisma.order.findUnique({ where: { number } });
      if (!existing) return number;
    }
    // Fallback: timestamp-based, effectively collision-free.
    return `ORD-${Date.now().toString().slice(-8)}`;
  }

  // ============================================================
  // Dispatch engine
  // ============================================================

  /**
   * Offer the order to the nearest eligible inspector not already offered or
   * declined for it. Creates a PENDING OrderOffer (expiresAt = now +
   * offerTimeoutMinutes). If nobody is left → UNASSIGNED.
   */
  async dispatch(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.UNASSIGNED) {
      // Only dispatch when waiting for assignment.
      return;
    }

    const { lat, lng } = await this.readOrderLatLng(orderId);
    const radiusKm = await this.settings.getNumber('expertSearchRadiusKm');

    // Exclude inspectors already offered (any status) for this order.
    const prior = await this.prisma.orderOffer.findMany({
      where: { orderId },
      select: { inspectorId: true },
    });
    const excluded = prior.map((o) => o.inspectorId);

    const candidates = await this.geo.findNearestInspectorsExcluding(
      lat,
      lng,
      radiusKm,
      1,
      excluded,
    );

    if (candidates.length === 0) {
      if (order.status !== OrderStatus.UNASSIGNED) {
        await this.transition(orderId, OrderStatus.UNASSIGNED, 'system');
      }
      return;
    }

    const nearest = candidates[0];
    const timeoutMinutes = await this.settings.getNumber('offerTimeoutMinutes');
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60_000);
    await this.prisma.orderOffer.create({
      data: { orderId, inspectorId: nearest.userId, status: 'PENDING', expiresAt },
    });
    await this.writeEvent(orderId, 'system', 'offer_sent', null, null, {
      inspectorId: nearest.userId,
      expiresAt: expiresAt.toISOString(),
    });
    // E11: notify the inspector an offer was sent to them (non-throwing).
    await this.notifications.notify(nearest.userId, 'offer.received', {
      orderId,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      inspectorShareCents: order.inspectorShareCents,
      expiresAt: expiresAt.toISOString(),
    });
  }

  // ============================================================
  // Offers (inspector actions)
  // ============================================================

  async acceptOffer(offerId: string, userId: string): Promise<{ orderId: string; status: OrderStatus }> {
    const offer = await this.prisma.orderOffer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Offer not found' } });
    }
    if (offer.inspectorId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your offer' } });
    }
    if (offer.status !== 'PENDING' || offer.expiresAt < new Date()) {
      throw new ConflictException({
        error: { code: 'offer_unavailable', message: 'Offer is not pending or has expired' },
      });
    }

    const order = await this.prisma.order.findUnique({ where: { id: offer.orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.UNASSIGNED) {
      throw new ConflictException({
        error: { code: 'already_assigned', message: 'Order is no longer open for assignment' },
      });
    }

    await this.prisma.orderOffer.update({ where: { id: offerId }, data: { status: 'ACCEPTED' } });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { inspectorId: userId },
    });
    await this.transition(order.id, OrderStatus.ASSIGNED, userId);
    return { orderId: order.id, status: OrderStatus.ASSIGNED };
  }

  async declineOffer(offerId: string, userId: string): Promise<{ orderId: string }> {
    const offer = await this.prisma.orderOffer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Offer not found' } });
    }
    if (offer.inspectorId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your offer' } });
    }
    if (offer.status === 'PENDING') {
      await this.prisma.orderOffer.update({ where: { id: offerId }, data: { status: 'DECLINED' } });
    }
    // Cascade to the next nearest inspector (or UNASSIGNED if none left).
    await this.dispatch(offer.orderId);
    return { orderId: offer.orderId };
  }

  // ============================================================
  // Inspector status pushes
  // ============================================================

  async updateStatusByInspector(
    orderId: string,
    userId: string,
    status: InspectorStatusUpdate,
  ): Promise<{ orderId: string; status: OrderStatus }> {
    const order = await this.requireOrder(orderId);
    if (order.inspectorId !== userId) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not the assigned inspector' },
      });
    }
    const target = status === InspectorStatusUpdate.EN_ROUTE ? OrderStatus.EN_ROUTE : OrderStatus.IN_PROGRESS;
    await this.transition(orderId, target, userId);
    return { orderId, status: target };
  }

  // ============================================================
  // Customer actions
  // ============================================================

  async cancel(orderId: string, userId: string): Promise<{ orderId: string; status: OrderStatus; refundCents: number }> {
    const order = await this.requireOrder(orderId);
    if (order.customerId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }

    const beforeAssign: OrderStatus[] = [OrderStatus.CREATED, OrderStatus.PAID, OrderStatus.UNASSIGNED];
    const afterAssign: OrderStatus[] = [OrderStatus.ASSIGNED, OrderStatus.EN_ROUTE];

    let refundPercent: number;
    let reason: string;
    if (beforeAssign.includes(order.status)) {
      refundPercent = await this.settings.getNumber('refundBeforeAssignPercent');
      reason = 'cancel_before_assign';
    } else if (afterAssign.includes(order.status)) {
      refundPercent = await this.settings.getNumber('refundAfterAssignPercent');
      reason = 'cancel_after_assign';
    } else {
      // IN_PROGRESS | SUBMITTED | ... → must dispute, not cancel.
      throw new ConflictException({
        error: { code: 'not_cancellable', message: 'Order cannot be cancelled; open a dispute instead' },
      });
    }

    const refundCents = Math.round((order.totalCents * refundPercent) / 100);
    await this.transition(orderId, OrderStatus.CANCELLED, userId);
    await this.refundOrder(order, refundCents, reason);
    return { orderId, status: OrderStatus.CANCELLED, refundCents };
  }

  async approve(orderId: string, userId: string): Promise<{ orderId: string; status: OrderStatus }> {
    const order = await this.requireOrder(orderId);
    if (order.customerId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }
    await this.transition(orderId, OrderStatus.APPROVED, userId);
    // E7: release the escrowed inspector share. Idempotent + non-throwing — a
    // failure here must not undo the approval.
    await this.releasePayout(orderId);
    const after = await this.requireOrder(orderId);
    return { orderId, status: after.status };
  }

  async dispute(
    orderId: string,
    userId: string,
    reason: string,
  ): Promise<{ orderId: string; status: OrderStatus }> {
    const order = await this.requireOrder(orderId);
    if (order.customerId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }
    await this.transition(orderId, OrderStatus.DISPUTED, userId);
    await this.prisma.dispute.upsert({
      where: { orderId },
      create: { orderId, openedBy: userId, reason, status: 'OPEN' },
      update: {},
    });
    return { orderId, status: OrderStatus.DISPUTED };
  }

  // ============================================================
  // Admin overrides (E9) — money logic stays centralized here
  // ============================================================

  /**
   * Admin manually assigns an eligible inspector to a PAID/UNASSIGNED order.
   * The target must have an InspectorProfile and a kycVerified user. Reconciles
   * OrderOffer rows (the chosen inspector's → ACCEPTED, any other PENDING →
   * EXPIRED) so the dispatch state stays consistent.
   */
  async adminAssign(orderId: string, inspectorId: string, adminId: string): Promise<Order> {
    const order = await this.requireOrder(orderId);

    const profile = await this.prisma.inspectorProfile.findUnique({
      where: { userId: inspectorId },
      include: { user: { select: { kycVerified: true } } },
    });
    if (!profile || !profile.user.kycVerified) {
      throw new BadRequestException({
        error: { code: 'inspector_not_eligible', message: 'Inspector is not eligible for assignment' },
      });
    }

    if (!canTransition(order.status, OrderStatus.ASSIGNED)) {
      throw new ConflictException({
        error: {
          code: 'illegal_transition',
          message: `Cannot assign an order in status ${order.status}`,
        },
      });
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { inspectorId },
    });

    // Reconcile offers: accept the chosen inspector's (creating one if absent),
    // expire any other still-pending offer for this order.
    await this.prisma.orderOffer.updateMany({
      where: { orderId, inspectorId: { not: inspectorId }, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    const chosen = await this.prisma.orderOffer.findFirst({ where: { orderId, inspectorId } });
    if (chosen) {
      await this.prisma.orderOffer.update({ where: { id: chosen.id }, data: { status: 'ACCEPTED' } });
    } else {
      await this.prisma.orderOffer.create({
        data: {
          orderId,
          inspectorId,
          status: 'ACCEPTED',
          expiresAt: new Date(),
        },
      });
    }

    return this.transition(orderId, OrderStatus.ASSIGNED, `admin:${adminId}`);
  }

  /**
   * Admin cancels an order with an explicit refund percent (0–100). If a
   * succeeded order Payment exists and the percent is > 0, a Refund of
   * round(totalCents * percent/100) is issued via the shared refund path with
   * reason 'admin'.
   */
  async adminCancel(
    orderId: string,
    refundPercent: number,
    adminId: string,
  ): Promise<{ orderId: string; status: OrderStatus; refundCents: number }> {
    const order = await this.requireOrder(orderId);
    if (!canTransition(order.status, OrderStatus.CANCELLED)) {
      throw new ConflictException({
        error: {
          code: 'illegal_transition',
          message: `Cannot cancel an order in status ${order.status}`,
        },
      });
    }

    const pct = Math.max(0, Math.min(100, refundPercent));
    let refundCents = 0;
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (pct > 0 && payment?.status === 'succeeded') {
      refundCents = Math.round((order.totalCents * pct) / 100);
    }

    await this.transition(orderId, OrderStatus.CANCELLED, `admin:${adminId}`);
    if (refundCents > 0) {
      await this.refundOrder(order, refundCents, 'admin');
    }
    return { orderId, status: OrderStatus.CANCELLED, refundCents };
  }

  /**
   * Admin resolves a DISPUTED order in favour of the customer or the inspector.
   * - customer: refund round(totalCents * pct/100) (pct default 100, reason
   *   'dispute'), Dispute → RESOLVED_CUSTOMER, order DISPUTED → REFUNDED.
   * - inspector: order DISPUTED → APPROVED then releasePayout (pays the
   *   inspector share and completes the order), Dispute → RESOLVED_INSPECTOR.
   */
  async resolveDispute(
    orderId: string,
    resolution: 'customer' | 'inspector',
    adminId: string,
    refundPercent?: number,
  ): Promise<{ orderId: string; status: OrderStatus; refundCents: number; payoutCents: number }> {
    const order = await this.requireOrder(orderId);
    if (order.status !== OrderStatus.DISPUTED) {
      throw new ConflictException({
        error: { code: 'not_disputed', message: 'Order is not in dispute' },
      });
    }

    const now = new Date();
    if (resolution === 'customer') {
      const pct = Math.max(0, Math.min(100, refundPercent ?? 100));
      const refundCents = Math.round((order.totalCents * pct) / 100);
      await this.transition(orderId, OrderStatus.REFUNDED, `admin:${adminId}`);
      if (refundCents > 0) {
        await this.refundOrder(order, refundCents, 'dispute');
      }
      await this.prisma.dispute.update({
        where: { orderId },
        data: {
          status: 'RESOLVED_CUSTOMER',
          resolution: `Resolved in favour of the customer (${pct}% refund)`,
          resolvedBy: adminId,
          resolvedAt: now,
        },
      });
      return { orderId, status: OrderStatus.REFUNDED, refundCents, payoutCents: 0 };
    }

    // inspector wins → APPROVED then release the escrowed share.
    await this.transition(orderId, OrderStatus.APPROVED, `admin:${adminId}`);
    await this.releasePayout(orderId);
    await this.prisma.dispute.update({
      where: { orderId },
      data: {
        status: 'RESOLVED_INSPECTOR',
        resolution: 'Resolved in favour of the inspector',
        resolvedBy: adminId,
        resolvedAt: now,
      },
    });
    const after = await this.requireOrder(orderId);
    const payout = await this.prisma.payout.findUnique({ where: { orderId } });
    return {
      orderId,
      status: after.status,
      refundCents: 0,
      payoutCents: payout?.amountCents ?? order.inspectorShareCents,
    };
  }

  // ============================================================
  // Queries
  // ============================================================

  async listMine(
    userId: string,
    role: OrderRole,
    status?: string,
  ): Promise<{ items: Array<ReturnType<OrdersService['toListItem']>> }> {
    const statusFilter = status ? { status: status as OrderStatus } : {};
    let orders: Order[];
    if (role === OrderRole.inspector) {
      // Orders assigned to me OR for which I have an offer.
      const offered = await this.prisma.orderOffer.findMany({
        where: { inspectorId: userId },
        select: { orderId: true },
      });
      const offeredIds = offered.map((o) => o.orderId);
      orders = await this.prisma.order.findMany({
        where: {
          ...statusFilter,
          OR: [{ inspectorId: userId }, { id: { in: offeredIds } }],
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      orders = await this.prisma.order.findMany({
        where: { customerId: userId, ...statusFilter },
        orderBy: { createdAt: 'desc' },
      });
    }
    return { items: orders.map((o) => this.toListItem(o)) };
  }

  async getDetail(orderId: string, userId: string, role: Role): Promise<OrderDetail> {
    const order = await this.requireOrder(orderId);
    const isCustomer = order.customerId === userId;
    const isInspector = order.inspectorId === userId;
    const isAdmin = role === Role.ADMIN;
    if (!isCustomer && !isInspector && !isAdmin) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }

    const events = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

    const assignedStatuses: OrderStatus[] = [
      OrderStatus.ASSIGNED,
      OrderStatus.EN_ROUTE,
      OrderStatus.IN_PROGRESS,
      OrderStatus.SUBMITTED,
      OrderStatus.APPROVED,
      OrderStatus.COMPLETED,
      OrderStatus.DISPUTED,
    ];

    // Inspector contact is only exposed once the order is at least ASSIGNED.
    let inspectorContact: { userId: string; name: string | null; phone: string | null; companyName: string | null } | null =
      null;
    if (order.inspectorId && assignedStatuses.includes(order.status)) {
      const insp = await this.prisma.user.findUnique({
        where: { id: order.inspectorId },
        select: { id: true, name: true, phone: true },
      });
      const profile = await this.prisma.inspectorProfile.findUnique({
        where: { userId: order.inspectorId },
        select: { companyName: true },
      });
      if (insp) {
        inspectorContact = {
          userId: insp.id,
          name: insp.name,
          phone: insp.phone,
          companyName: profile?.companyName ?? null,
        };
      }
    }

    // Report is exposed once SUBMITTED (or later).
    const submittedOrLater: OrderStatus[] = [
      OrderStatus.SUBMITTED,
      OrderStatus.APPROVED,
      OrderStatus.COMPLETED,
      OrderStatus.DISPUTED,
    ];
    let report: { id: string; code: string; qualityScore: number | null } | null = null;
    if (submittedOrLater.includes(order.status)) {
      const r = await this.prisma.report.findUnique({
        where: { orderId },
        select: { id: true, code: true, qualityScore: true },
      });
      if (r) report = { id: r.id, code: r.code, qualityScore: r.qualityScore };
    }

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      vehicle: { vin: order.vin, make: order.make, model: order.model },
      address: order.address,
      scheduledAt: order.scheduledAt.toISOString(),
      money: {
        baseFeeCents: order.baseFeeCents,
        distanceKm: Number(order.distanceKm),
        distanceFeeCents: order.distanceFeeCents,
        durationMin: order.durationMin,
        timeFeeCents: order.timeFeeCents,
        surgeMultiplier: Number(order.surgeMultiplier),
        minimumFareApplied: order.minimumFareApplied,
        distanceSource: order.routingSource === 'mapbox' ? 'road' : 'straight_line',
        totalCents: order.totalCents,
        platformFeeCents: order.platformFeeCents,
        inspectorShareCents: order.inspectorShareCents,
        currency: order.currency,
      },
      inspectorContact,
      report,
      autoApproveAt: order.autoApproveAt ? order.autoApproveAt.toISOString() : null,
      submittedAt: order.submittedAt ? order.submittedAt.toISOString() : null,
      createdAt: order.createdAt.toISOString(),
      events: events.map((e) => ({
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  // ============================================================
  // Time-based jobs (exposed for the future E11 worker; tested directly)
  // ============================================================

  /** PENDING offers past expiresAt → EXPIRED, then cascade dispatch. */
  async expireStaleOffers(): Promise<{ expired: number }> {
    const stale = await this.prisma.orderOffer.findMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    });
    for (const offer of stale) {
      await this.prisma.orderOffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED' } });
      await this.dispatch(offer.orderId);
    }
    return { expired: stale.length };
  }

  /** SUBMITTED orders past autoApproveAt → APPROVED. */
  async autoApproveOverdue(): Promise<{ approved: number }> {
    const overdue = await this.prisma.order.findMany({
      where: { status: OrderStatus.SUBMITTED, autoApproveAt: { lt: new Date() } },
    });
    for (const order of overdue) {
      await this.transition(order.id, OrderStatus.APPROVED, 'system');
      // E7: release the escrowed inspector share on auto-approve too.
      await this.releasePayout(order.id);
    }
    return { approved: overdue.length };
  }

  // ============================================================
  // Payout / escrow release (E7)
  // ============================================================

  /**
   * Release the escrowed inspector share for an APPROVED order (escrow → the
   * inspector's connected account). Non-throwing — wired into approve() /
   * autoApprove(), a failure here must never undo the approval.
   *
   * - Stripe configured: retrieve the PaymentIntent → latest_charge, transfer
   *   the inspector share via source_transaction, record a 'paid' Payout, then
   *   transition APPROVED → COMPLETED.
   * - MOCK mode: record a 'paid' Payout with a synthetic transfer id + COMPLETE.
   * - Not eligible / transfer failed: park the Payout with a retry schedule and
   *   alert operators. `retryStuckPayouts` picks it up later.
   *
   * Idempotency is "already PAID short-circuits", not "a row exists". The
   * previous `if (existing) return` made retrying structurally impossible: the
   * first failure parked a pending row, and that row then blocked every
   * subsequent attempt forever.
   */
  async releasePayout(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    // COMPLETED is allowed so a retry can finish an order whose earlier attempt
    // transitioned it but failed to transfer. `transition` no-ops on from===to.
    if (order.status !== OrderStatus.APPROVED && order.status !== OrderStatus.COMPLETED) return;
    if (!order.inspectorId) {
      this.logger.warn(`releasePayout: order ${orderId} has no inspector — skipping`);
      return;
    }

    const existing = await this.prisma.payout.findUnique({ where: { orderId } });
    if (existing?.status === 'paid') return;

    const amountCents = order.inspectorShareCents;
    const profile = await this.prisma.inspectorProfile.findUnique({
      where: { userId: order.inspectorId },
    });

    // Not eligible to receive funds yet → park a pending payout, stay APPROVED.
    if (!profile?.stripeOnboarded || !profile.stripeAccountId) {
      await this.parkPayout(order, amountCents, 'inspector is not onboarded for payouts');
      return;
    }

    let stripeTransferId: string | null = `tr_mock_${orderId}`;
    if (this.stripe.configured) {
      const payment = await this.prisma.payment.findUnique({ where: { orderId } });
      if (!payment?.stripePaymentIntentId) {
        await this.parkPayout(order, amountCents, 'order has no Stripe PaymentIntent');
        return;
      }
      try {
        const pi = await this.stripe.retrievePaymentIntent(payment.stripePaymentIntentId);
        const chargeId =
          typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
        if (!chargeId) throw new Error('PaymentIntent has no latest_charge');
        const transfer = await this.stripe.createTransfer({
          amountCents,
          destinationAccountId: profile.stripeAccountId,
          sourceChargeId: chargeId,
          transferGroup: order.number,
        });
        stripeTransferId = transfer.id;
      } catch (err) {
        // Transfer failed → park with a retry schedule, stay APPROVED.
        await this.parkPayout(order, amountCents, (err as Error).message);
        return;
      }
    }

    const wasAlreadyPaid = await this.markPayoutPaid(
      orderId,
      order.inspectorId,
      amountCents,
      stripeTransferId,
    );
    // If a concurrent caller already settled the payout, don't double-notify.
    if (!wasAlreadyPaid) {
      // E11: notify the inspector their payout was sent (non-throwing). Emitted
      // before COMPLETED so it reflects the payout event specifically.
      await this.notifications.notify(order.inspectorId, 'payout.sent', {
        orderId,
        orderNumber: order.number,
        amountCents,
      });
      await this.transition(orderId, OrderStatus.COMPLETED, 'system');
    }
  }

  /**
   * Backoff schedule by attempt number. After the last entry the payout is
   * terminal and needs an operator — an automated retry that never gives up
   * turns one broken transfer into a permanent hourly alert.
   */
  private static readonly PAYOUT_BACKOFF_MINUTES = [5, 15, 60, 360, 1440, 4320];

  /** Attempts after which a payout stops retrying by itself. */
  private static readonly PAYOUT_MAX_ATTEMPTS = OrdersService.PAYOUT_BACKOFF_MINUTES.length;

  /**
   * Record a payout that could not be settled, schedule the next attempt, and
   * tell someone. `orderId` is unique on Payout, so this upserts — the retry
   * path must update the parked row, never try to insert a second one.
   */
  private async parkPayout(
    order: { id: string; number: string; inspectorId: string | null },
    amountCents: number,
    reason: string,
  ): Promise<void> {
    if (!order.inspectorId) return;

    const existing = await this.prisma.payout.findUnique({ where: { orderId: order.id } });
    const attempts = (existing?.attempts ?? 0) + 1;
    const exhausted = attempts >= OrdersService.PAYOUT_MAX_ATTEMPTS;
    const backoffMinutes =
      OrdersService.PAYOUT_BACKOFF_MINUTES[
        Math.min(attempts - 1, OrdersService.PAYOUT_BACKOFF_MINUTES.length - 1)
      ];

    const data = {
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastError: reason.slice(0, 500),
      lastAttemptAt: new Date(),
      nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMinutes * 60_000),
    };

    await this.prisma.payout.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        inspectorId: order.inspectorId,
        amountCents,
        stripeTransferId: null,
        ...data,
      },
      update: data,
    });

    this.logger.warn(
      `releasePayout: order ${order.id} payout ${data.status} (attempt ${attempts}): ${reason}`,
    );

    // Alert on the FIRST parking and on going terminal — not on every retry, or
    // one stuck payout spams operators around the clock.
    if (attempts === 1 || exhausted) {
      await this.notifyAdminsOfStuckPayout(order, amountCents, reason, attempts, exhausted);
      // Tell the inspector once, so they are not left wondering where the money is.
      if (attempts === 1) {
        await this.notifications.notify(order.inspectorId, 'payout.delayed', {
          orderId: order.id,
          orderNumber: order.number,
          amountCents,
        });
      }
    }
  }

  private async notifyAdminsOfStuckPayout(
    order: { id: string; number: string },
    amountCents: number,
    reason: string,
    attempts: number,
    exhausted: boolean,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify(admin.id, 'payout.failed', {
        orderId: order.id,
        orderNumber: order.number,
        amountCents,
        reason,
        attempts,
        terminal: exhausted,
      });
    }
  }

  /**
   * Settle the order's single payout. Returns true when it was ALREADY paid, so
   * the caller can skip the notify/transition it has already done.
   */
  private async markPayoutPaid(
    orderId: string,
    inspectorId: string,
    amountCents: number,
    stripeTransferId: string | null,
  ): Promise<boolean> {
    const existing = await this.prisma.payout.findUnique({ where: { orderId } });
    if (existing?.status === 'paid') return true;

    const paid = {
      status: 'paid',
      stripeTransferId,
      lastAttemptAt: new Date(),
      nextRetryAt: null,
      lastError: null,
      attempts: (existing?.attempts ?? 0) + 1,
    };

    try {
      await this.prisma.payout.upsert({
        where: { orderId },
        create: { orderId, inspectorId, amountCents, ...paid },
        update: paid,
      });
      return false;
    } catch (err) {
      // A concurrent caller inserted the row between our read and our write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return true;
      }
      throw err;
    }
  }

  /**
   * Retry payouts whose backoff has elapsed. Driven by a cron; also reachable
   * from the admin panel for a single order.
   */
  async retryStuckPayouts(limit = 25): Promise<{ retried: number; settled: number }> {
    const due = await this.prisma.payout.findMany({
      where: {
        status: { in: ['pending', 'failed'] },
        nextRetryAt: { not: null, lte: new Date() },
        attempts: { lt: OrdersService.PAYOUT_MAX_ATTEMPTS },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
      select: { orderId: true },
    });

    let settled = 0;
    for (const { orderId } of due) {
      try {
        await this.releasePayout(orderId);
        const after = await this.prisma.payout.findUnique({ where: { orderId } });
        if (after?.status === 'paid') settled += 1;
      } catch (err) {
        // One bad order must not stop the batch.
        this.logger.error(`retryStuckPayouts: ${orderId} threw: ${(err as Error).message}`);
      }
    }
    return { retried: due.length, settled };
  }

  /**
   * Operator action: attempt a stuck payout right now, ignoring the backoff and
   * the attempt cap. Returns the resulting payout row.
   */
  async adminRetryPayout(orderId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { orderId } });
    if (!payout) {
      throw new NotFoundException({
        error: { code: 'payout_not_found', message: `No payout for order ${orderId}` },
      });
    }
    if (payout.status === 'paid') return payout;

    // Reset the counter so an operator retry is never refused by the cap, and so
    // the schedule restarts from the short end if it fails again.
    await this.prisma.payout.update({
      where: { orderId },
      data: { attempts: 0, nextRetryAt: new Date() },
    });
    await this.releasePayout(orderId);
    return this.prisma.payout.findUnique({ where: { orderId } });
  }

  /**
   * Operator action: record a payout settled outside Stripe (a bank transfer,
   * typically, when a connected account can no longer receive funds).
   */
  async adminMarkPayoutPaid(orderId: string, reference: string) {
    const payout = await this.prisma.payout.findUnique({ where: { orderId } });
    if (!payout) {
      throw new NotFoundException({
        error: { code: 'payout_not_found', message: `No payout for order ${orderId}` },
      });
    }
    const updated = await this.prisma.payout.update({
      where: { orderId },
      data: {
        status: 'paid',
        nextRetryAt: null,
        lastError: `settled out of band: ${reference}`.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    await this.transition(orderId, OrderStatus.COMPLETED, 'admin');
    return updated;
  }

  /** Payout queue for the admin finance view. */
  async listPayouts(status?: string, page = 1, pageSize = 50) {
    const where = status ? { status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'desc' }],
        skip: (Math.max(1, page) - 1) * pageSize,
        take: pageSize,
        include: {
          order: { select: { number: true, status: true } },
          inspector: { select: { userId: true, companyName: true } },
        },
      }),
      this.prisma.payout.count({ where }),
    ]);

    return {
      total,
      items: rows.map((p) => ({
        orderId: p.orderId,
        orderNumber: p.order.number,
        orderStatus: p.order.status,
        inspectorId: p.inspectorId,
        inspectorCompany: p.inspector.companyName,
        amountCents: p.amountCents,
        currency: 'EUR',
        status: p.status,
        attempts: p.attempts,
        lastError: p.lastError,
        lastAttemptAt: p.lastAttemptAt?.toISOString() ?? null,
        nextRetryAt: p.nextRetryAt?.toISOString() ?? null,
        stripeTransferId: p.stripeTransferId,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  // ============================================================
  // Report attach → SUBMITTED (called from ReportsService.create)
  // ============================================================

  /**
   * When an inspection report is uploaded against an order, transition that
   * order to SUBMITTED and stamp submittedAt + autoApproveAt. Only fires when
   * the order is in a transitionable state (IN_PROGRESS, or the slightly-early
   * ASSIGNED / EN_ROUTE). The Report→Order link itself lives on Report.orderId
   * (set by ReportsService); this only advances the order. No-op (returns false)
   * if the order is missing or not in a transitionable state.
   *
   * NOTE: device↔inspector identity is not yet wired, so we do not verify the
   * uploader is the assigned inspector here — any report whose orderId matches a
   * transitionable order advances it. Tighten in a later epoch.
   */
  async submitReportForOrder(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;

    const transitionable: OrderStatus[] = [
      OrderStatus.ASSIGNED,
      OrderStatus.EN_ROUTE,
      OrderStatus.IN_PROGRESS,
    ];
    if (!transitionable.includes(order.status)) return false;

    // Walk forward to IN_PROGRESS so the SUBMITTED edge is always legal.
    if (order.status === OrderStatus.ASSIGNED) {
      await this.transition(orderId, OrderStatus.EN_ROUTE, 'system');
      await this.transition(orderId, OrderStatus.IN_PROGRESS, 'system');
    } else if (order.status === OrderStatus.EN_ROUTE) {
      await this.transition(orderId, OrderStatus.IN_PROGRESS, 'system');
    }

    const autoApproveDays = await this.settings.getNumber('autoApproveAfterDays');
    const now = new Date();
    const autoApproveAt = new Date(now.getTime() + autoApproveDays * 86_400_000);
    await this.prisma.order.update({
      where: { id: orderId },
      data: { submittedAt: now, autoApproveAt },
    });
    await this.transition(orderId, OrderStatus.SUBMITTED, 'system');
    return true;
  }

  // ============================================================
  // State machine (single place for all transitions)
  // ============================================================

  /**
   * Apply a status transition with an allowed-edge guard. Idempotent when
   * from === to (no-op). Every applied transition writes an OrderEvent.
   * Illegal edges throw 409 illegal_transition.
   */
  async transition(orderId: string, to: OrderStatus, actor: string): Promise<Order> {
    const order = await this.requireOrder(orderId);
    if (order.status === to) return order; // idempotent
    if (!canTransition(order.status, to)) {
      throw new ConflictException({
        error: {
          code: 'illegal_transition',
          message: `Cannot move order from ${order.status} to ${to}`,
        },
      });
    }
    const from = order.status;
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: to },
    });
    await this.writeEvent(orderId, actor, 'status_change', from, to, null);

    // E10 LegalSync: generate the per-order contract on entry to ASSIGNED. This
    // fires for BOTH acceptOffer and adminAssign. Best-effort — a failure here must
    // never break the assignment, so it is caught and logged.
    if (to === OrderStatus.ASSIGNED) {
      try {
        await this.legalContract.renderContractForOrder(orderId);
      } catch (err) {
        this.logger.warn(
          `Failed to generate contract for order ${orderId}: ${(err as Error).message}`,
        );
      }
    }

    // E11 notifications: map the new status → per-status notification(s). notify()
    // is internally non-throwing, but the whole block is also guarded so a failure
    // can never break the transition.
    try {
      await this.notifyStatusChange(updated, from);
    } catch (err) {
      this.logger.warn(
        `Status notification failed for order ${orderId} (${to}): ${(err as Error).message}`,
      );
    }

    return updated;
  }

  /**
   * Emit the per-status notifications for a successful transition (E11 matrix).
   * Recipients are derived from the order's customer/inspector. Each entry is
   * fired through notify(), which is itself non-throwing.
   */
  private async notifyStatusChange(order: Order, _from: OrderStatus): Promise<void> {
    const payload = {
      orderId: order.id,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      totalCents: order.totalCents,
      inspectorShareCents: order.inspectorShareCents,
    };
    const customer = order.customerId;
    const inspector = order.inspectorId;

    const emit = (userId: string | null, type: NotificationType): Promise<void> =>
      userId ? this.notifications.notify(userId, type, payload) : Promise.resolve();

    switch (order.status) {
      case OrderStatus.ASSIGNED:
        await emit(customer, 'order.assigned');
        break;
      case OrderStatus.EN_ROUTE:
        await emit(customer, 'order.en_route');
        break;
      case OrderStatus.IN_PROGRESS:
        await emit(customer, 'order.in_progress');
        break;
      case OrderStatus.SUBMITTED:
        await emit(customer, 'order.submitted');
        break;
      case OrderStatus.APPROVED:
        // The report's author (inspector) is notified their report was approved.
        await emit(inspector, 'order.approved');
        break;
      case OrderStatus.COMPLETED:
        await emit(customer, 'order.completed');
        await emit(inspector, 'order.completed');
        break;
      case OrderStatus.CANCELLED:
        // Notify the "other party" — whoever did not initiate. We don't have the
        // actor's role here cheaply, so notify both known parties; each only gets
        // an in-app row plus their enabled channels.
        await emit(customer, 'order.cancelled');
        await emit(inspector, 'order.cancelled');
        break;
      case OrderStatus.DISPUTED:
        await emit(inspector, 'order.disputed');
        break;
      default:
        break;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async requireOrder(orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    return order;
  }

  private async refundOrder(order: Order, amountCents: number, reason: string): Promise<void> {
    let stripeRefundId = `mock_re_${order.id}_${Date.now()}`;
    const payment = await this.prisma.payment.findUnique({ where: { orderId: order.id } });
    if (this.stripe.configured && payment?.stripePaymentIntentId) {
      const refund = await this.stripe.createRefund(payment.stripePaymentIntentId, amountCents, reason);
      stripeRefundId = refund.id;
    } else if (payment) {
      await this.payments.markPaymentRefunded(payment.id);
    }
    await this.prisma.refund.create({
      data: { orderId: order.id, amountCents, reason, stripeRefundId },
    });
  }

  private async readOrderLatLng(orderId: string): Promise<{ lat: number; lng: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM "order"
      WHERE id = ${orderId}
    `);
    if (rows.length === 0) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) };
  }

  private async writeEvent(
    orderId: string,
    actor: string,
    type: string,
    fromStatus: OrderStatus | null,
    toStatus: OrderStatus | null,
    payload: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await this.prisma.orderEvent.create({
      data: {
        orderId,
        actor,
        type,
        fromStatus,
        toStatus,
        payload: payload ?? undefined,
      },
    });
  }

  private toListItem(o: Order) {
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      make: o.make,
      model: o.model,
      address: o.address,
      scheduledAt: o.scheduledAt.toISOString(),
      totalCents: o.totalCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    };
  }
}

export interface OrderDetail {
  id: string;
  number: string;
  status: OrderStatus;
  vehicle: { vin: string | null; make: string; model: string };
  address: string;
  scheduledAt: string;
  money: {
    baseFeeCents: number;
    distanceKm: number;
    distanceFeeCents: number;
    /** Null for orders placed before the ride-hailing tariff. */
    durationMin: number | null;
    timeFeeCents: number;
    surgeMultiplier: number;
    minimumFareApplied: boolean;
    /** Pre-tariff orders report 'straight_line', which is what they were. */
    distanceSource: 'road' | 'straight_line';
    totalCents: number;
    platformFeeCents: number;
    inspectorShareCents: number;
    currency: string;
  };
  inspectorContact: {
    userId: string;
    name: string | null;
    phone: string | null;
    companyName: string | null;
  } | null;
  report: { id: string; code: string; qualityScore: number | null } | null;
  autoApproveAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  events: Array<{
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    actor: string;
    createdAt: string;
  }>;
}

