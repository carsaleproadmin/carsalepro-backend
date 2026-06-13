import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma, Role } from '@prisma/client';
import { GeoService, NearestInspector } from '../geo/geo.service';
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

/** Result of a server-side quote. */
export interface QuoteResult {
  available: boolean;
  totalCents?: number;
  breakdown?: { baseFeeCents: number; distanceFeeCents: number; distanceKm: number };
  nearestKm?: number;
  candidates?: Array<{ displayName: string | null; company: string | null; distanceKm: number }>;
}

/** Full priced quote, including the cents fields needed to persist an order. */
interface PricedQuote {
  available: boolean;
  nearest?: NearestInspector;
  candidates: NearestInspector[];
  baseFeeCents: number;
  distanceKm: number;
  distanceFeeCents: number;
  totalCents: number;
  platformFeeCents: number;
  inspectorShareCents: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly settings: SettingsService,
    private readonly stripe: StripeService,
    private readonly payments: PaymentsService,
  ) {}

  // ============================================================
  // Pricing
  // ============================================================

  /**
   * Single source of truth for pricing. `distanceKm` is the distance to the
   * NEAREST eligible inspector. All money is integer cents; rounding happens
   * only at the cents boundary.
   */
  private async priceQuote(lat: number, lng: number): Promise<PricedQuote> {
    const baseFeeCents = await this.settings.getCents('orderBaseFeeEur');
    const ratePerKmCents = await this.settings.getCents('orderRatePerKmEur');
    const platformFeePercent = await this.settings.getNumber('platformFeePercent');
    const radiusKm = await this.settings.getNumber('expertSearchRadiusKm');

    const candidates = await this.geo.findNearestInspectors(lat, lng, radiusKm, 3);

    if (candidates.length === 0) {
      return {
        available: false,
        candidates: [],
        baseFeeCents,
        distanceKm: 0,
        distanceFeeCents: 0,
        totalCents: 0,
        platformFeeCents: 0,
        inspectorShareCents: 0,
      };
    }

    const nearest = candidates[0];
    const distanceKm = nearest.distanceKm;
    const distanceFeeCents = Math.round(distanceKm * ratePerKmCents);
    const totalCents = baseFeeCents + distanceFeeCents;
    const platformFeeCents = Math.round((totalCents * platformFeePercent) / 100);
    const inspectorShareCents = totalCents - platformFeeCents;

    return {
      available: true,
      nearest,
      candidates,
      baseFeeCents,
      distanceKm,
      distanceFeeCents,
      totalCents,
      platformFeeCents,
      inspectorShareCents,
    };
  }

  /** Public quote. On no coverage, records a WaitlistEntry from the user email. */
  async quote(userId: string, dto: QuoteOrderDto): Promise<QuoteResult> {
    const priced = await this.priceQuote(dto.lat, dto.lng);

    if (!priced.available) {
      await this.addToWaitlist(userId, dto.lat, dto.lng);
      return { available: false };
    }

    return {
      available: true,
      totalCents: priced.totalCents,
      breakdown: {
        baseFeeCents: priced.baseFeeCents,
        distanceFeeCents: priced.distanceFeeCents,
        distanceKm: priced.distanceKm,
      },
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
    // Re-run the quote server-side; the client price is never trusted.
    const priced = await this.priceQuote(dto.lat, dto.lng);
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
        amountCents: priced.totalCents,
        currency: 'EUR',
        status: 'pending',
      },
    });

    if (this.stripe.configured) {
      const pi = await this.stripe.createOrderPaymentIntent({
        amountCents: priced.totalCents,
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
    const id = cuidLike();
    const distanceKm = new Prisma.Decimal(priced.distanceKm);
    await this.prisma.$executeRaw`
      INSERT INTO "order" (
        id, number, customer_id, status, vin, make, model, listing_url, address,
        location, scheduled_at, country_code,
        base_fee_cents, distance_km, distance_fee_cents, total_cents,
        platform_fee_cents, inspector_share_cents, currency, "createdAt"
      ) VALUES (
        ${id}, ${number}, ${customerId}, 'CREATED'::"OrderStatus",
        ${dto.vin?.toUpperCase() ?? null}, ${dto.make}, ${dto.model},
        ${dto.listingUrl ?? null}, ${dto.address},
        ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
        ${new Date(dto.scheduledAt)}, 'DE',
        ${priced.baseFeeCents}, ${distanceKm}, ${priced.distanceFeeCents},
        ${priced.totalCents}, ${priced.platformFeeCents}, ${priced.inspectorShareCents},
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
    // TODO E11: notify(nearest.userId, 'new_offer', orderId)
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
    // TODO E7: transfer inspectorShare to the inspector's connected account,
    // create the Payout row, then optionally transition APPROVED → COMPLETED.
    return { orderId, status: OrderStatus.APPROVED };
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
      // TODO E7: transfer inspectorShare on auto-approve too.
    }
    return { approved: overdue.length };
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
    return updated;
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

/**
 * Generate a cuid-like id for raw inserts. Order ids elsewhere come from Prisma
 * `@default(cuid())`; here we mint our own (the column is a plain text PK so any
 * unique string works) using the same `c` prefix + time + randomness.
 */
function cuidLike(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `c${time}${rand}`.slice(0, 25);
}
