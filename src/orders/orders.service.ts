import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { GeoService, NearestInspector } from '../geo/geo.service';
import { RouteEstimate, RoutingService } from '../geo/routing.service';
import { DEFAULT_COUNTRY_CODE, GeocodingService } from '../geo/geocoding.service';
import { resolveContact, type PartyContact } from '../inspector/inspector-contact';
import { LegalContractService } from '../legal/legal-contract.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';
import { PaymentsService } from '../payments/payments.service';
import {
  StripePaymentIntent,
  StripeService,
  classifyStripeError,
} from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  CreateOrderDto,
  InspectorStatusUpdate,
  OrderRole,
  QuoteOrderDto,
} from './dto/order.dto';
import { ATTACHABLE_REPORT_ORDER_STATUSES, canTransition } from './order-state-machine';
import { PriceBreakdown, computePrice } from './order-pricing';
import { RegionalOverrides, exceedsCap, resolveTariff } from './tariff-resolution';
import { MONEY_RETRY_MAX_ATTEMPTS, planRetry } from './retry-schedule';
import {
  countMissing,
  currentRequiredAngles,
  evaluateCompleteness,
  thicknessPanelIds,
} from '../reports/report-completeness';

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
  /**
   * Only meaningful when `available` is false: true when a WaitlistEntry was
   * recorded, false when we have no email to record one against (an anonymous
   * quote), so the UI knows to ask for one.
   */
  waitlisted?: boolean;
  /**
   * Only meaningful when `available` is false. 'no_coverage' means nobody is
   * within the search radius; 'too_far' means the nearest inspector is beyond
   * what this region serves. Optional in the type so the website can deploy in
   * either order — it read a bare `available: false` before.
   */
  refusal?: 'no_coverage' | 'too_far';
  currency?: string;
  totalCents?: number;
  breakdown?: {
    baseFeeCents: number;
    distanceFeeCents: number;
    /** One direction: how far the inspector is. */
    distanceKm: number;
    /**
     * What `distanceFeeCents` was computed from: `distanceKm ×
     * returnTripFactor`. Optional in the type so the website can deploy in
     * either order — while it is absent, `distanceKm` is the billed quantity,
     * which is exactly true while the factor is 1.
     */
    billedDistanceKm?: number;
    returnTripFactor?: number;
    /** Kilometres that carried no travel charge. */
    freeRadiusKm?: number;
    /** One direction, after the free radius came off. */
    chargeableDistanceKm?: number;
    /** 'road' when a routing provider answered, 'straight_line' when estimated. */
    distanceSource: 'road' | 'straight_line';
    /** One direction, as measured. */
    durationMin: number;
    /** What `timeFeeCents` was computed from. */
    billedDurationMin?: number;
    timeFeeCents: number;
    subtotalCents: number;
    surgeMultiplier: number;
    surgeFeeCents: number;
    peakApplied: boolean;
    minimumFareCents: number;
    minimumFareTopUpCents: number;
    minimumFareApplied: boolean;
    /**
     * The split of `totalCents`. Both sides are quoted the same two numbers:
     * the customer is shown what the platform keeps, the inspector what they
     * earn, and `platformFeeCents + inspectorShareCents === totalCents` holds.
     * Quoted before an inspector exists because the split is a function of the
     * tariff, not of who takes the job.
     */
    platformFeeCents: number;
    inspectorShareCents: number;
  };
  nearestKm?: number;
  candidates?: Array<{ displayName: string | null; company: string | null; distanceKm: number }>;
}

/**
 * What `releasePayout` did. Callers ignore it in the happy path; the retry cron
 * needs `skipped` to tell "not yet" from "never" — a row that can never settle
 * must leave the queue instead of being re-selected on every run.
 */
export interface PayoutOutcome {
  status: 'paid' | 'already_paid' | 'parked' | 'skipped';
  reason?: string;
}

/**
 * What `settleRefund` did. It never throws, so this is the only channel through
 * which a caller learns whether money moved.
 *
 * - `refunded`  — the provider accepted it (or mock mode settled it locally).
 * - `parked`    — the provider refused; the row carries a retry schedule.
 * - `skipped`   — there was nothing to give back (no payment, an uncaptured or
 *                 failed one, or one already refunded). No provider call, no row.
 * - `released`  — an authorization hold was released. Deliberately NOT a Refund
 *                 row: the money never left the customer.
 * - `error`     — something below the provider broke (the database, typically).
 *                 Surfaced rather than thrown, because a refund must never be
 *                 the reason an order fails to cancel.
 */
export interface RefundOutcome {
  status: 'refunded' | 'parked' | 'skipped' | 'released' | 'error';
  /** Cents the customer is owed: 0 when nothing was, or will be, returned. */
  amountCents: number;
  refundId: string | null;
  stripeRefundId: string | null;
  /** The refund reason key — the second half of the (orderId, reason) identity. */
  reason: string;
  /** Why it was skipped/parked/errored. Null on a clean settlement. */
  detail: string | null;
  attempts: number;
  /** Null when no further automatic attempt is scheduled. */
  nextRetryAt: Date | null;
}

/** The order fields a refund needs: an id to key on and a number to report. */
type RefundableOrder = Pick<Order, 'id' | 'number'>;

/**
 * What `captureOrderPayment` did. It never throws: the caller decides what a
 * failure means for the ORDER, and "this inspector cannot have the job" and
 * "this customer's order is dead" are different outcomes with different HTTP
 * contracts.
 *
 * - `captured`         — the funds are ours; the Payment is 'succeeded'.
 * - `already_captured` — an idempotent replay (a retried Accept, the reconciler).
 * - `retryable`        — a transient provider failure. Nothing is destroyed: the
 *                        claim is undone, the offer goes back to PENDING and the
 *                        same inspector can accept again in a minute.
 * - `fatal`            — the card cannot pay, ever. The caller releases the hold
 *                        and cancels the order.
 */
export type CaptureOutcome =
  | { status: 'captured' | 'already_captured'; detail?: undefined }
  | { status: 'retryable' | 'fatal'; detail: string };

/**
 * How a cancellation settled, for the client. `refundCents: 0` on its own is
 * ambiguous — it is both "you were never charged" and "your hold was released"
 * — and the website words the confirmation differently for each.
 */
export type RefundMode = 'refunded' | 'refund_pending' | 'authorization_released' | 'none';

/** Where an order's money is, as the website's `orderPhase()` reads it. */
export type OrderPaymentState =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'released'
  | 'refunded'
  | 'failed';

/**
 * `Payment.status` (our ledger) → the payment state the API publishes.
 *
 * The two vocabularies are deliberately different. Ours is a payment-provider
 * word list that predates manual capture ('succeeded' meant "charged"); the
 * public one says where the MONEY is, which is what a customer looking at an
 * order actually needs to know. 'succeeded' is 'captured' — taken — and
 * 'cancelled' is 'released': the hold is gone and nothing ever left the card.
 */
const PUBLIC_PAYMENT_STATE: Record<string, OrderPaymentState> = {
  pending: 'pending',
  authorized: 'authorized',
  succeeded: 'captured',
  cancelled: 'released',
  refunded: 'refunded',
  failed: 'failed',
};

/**
 * How long a payment may sit before the reconciler treats it as stuck.
 *
 * Stripe delivers a webhook in seconds; five minutes is long enough that a
 * healthy delivery is never second-guessed, and short enough that a customer
 * whose event was lost is not left staring at a CREATED order.
 */
const RECONCILE_MIN_AGE_MS = 5 * 60_000;

/** Order statuses in which we are still looking for an inspector. */
const PRE_ASSIGNMENT_STATUSES: OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.PAID,
  OrderStatus.UNASSIGNED,
];

/**
 * Order statuses in which an inspector has committed to the job. An uncaptured
 * payment on any of these means someone is working for free.
 */
const POST_ASSIGNMENT_STATUSES: OrderStatus[] = [
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.IN_PROGRESS,
  OrderStatus.SUBMITTED,
  OrderStatus.APPROVED,
  OrderStatus.DISPUTED,
];

/**
 * Wave 3 introduces manual capture and, with it, `cancelPaymentIntent` on
 * StripeService. Releasing a hold is a refund-path branch, so it is implemented
 * here — but implementing manual capture is not this wave's job, so the call is
 * made through a capability check instead of a hard dependency. Today the method
 * is absent and the branch degrades to releasing the hold in our own ledger;
 * the day it exists, the same code cancels the intent for real.
 */
interface AuthorizationCanceller {
  cancelPaymentIntent(
    paymentIntentId: string,
    paymentId: string,
    reason?: string,
  ): Promise<unknown>;
}

function canCancelAuthorization(stripe: unknown): stripe is AuthorizationCanceller {
  return typeof (stripe as AuthorizationCanceller).cancelPaymentIntent === 'function';
}

/** Full priced quote, including the cents fields needed to persist an order. */
interface PricedQuote {
  available: boolean;
  /** Why not, when `available` is false. */
  refusal?: 'no_coverage' | 'too_far';
  /** The country the tariff was resolved for. Never null: falls back to DE. */
  countryCode: string;
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
    private readonly geocoding: GeocodingService,
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
   * The band row and the country row that apply to a country, as plain numbers.
   *
   * Prisma `Decimal` columns are converted here and nowhere else, so the pure
   * resolver never sees a database type. A country with no row, or a country
   * whose row points at no band, is not an error: both levels stay silent and
   * the global tariff answers.
   */
  private async loadRegionalOverrides(
    countryCode: string,
  ): Promise<{ zone: RegionalOverrides | null; country: RegionalOverrides | null }> {
    const row = await this.prisma.countryTariff.findUnique({
      where: { countryCode },
      include: { zone: true },
    });
    if (!row) return { zone: null, country: null };

    const toOverrides = (r: {
      baseFeeCents: number | null;
      perKmCents: number | null;
      ratePerMinuteCents: number | null;
      minimumFareCents: number | null;
      freeRadiusKm: Prisma.Decimal | null;
      capKm: Prisma.Decimal | null;
      returnTripFactor: Prisma.Decimal | null;
    }): RegionalOverrides => ({
      baseFeeCents: r.baseFeeCents,
      perKmCents: r.perKmCents,
      ratePerMinuteCents: r.ratePerMinuteCents,
      minimumFareCents: r.minimumFareCents,
      freeRadiusKm: r.freeRadiusKm === null ? null : Number(r.freeRadiusKm),
      capKm: r.capKm === null ? null : Number(r.capKm),
      returnTripFactor: r.returnTripFactor === null ? null : Number(r.returnTripFactor),
    });

    return {
      zone: row.zone ? toOverrides(row.zone) : null,
      country: toOverrides(row),
    };
  }

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
   *
   * `customerId` is the caller (undefined for an anonymous quote) and is
   * excluded from the candidate set: an account that is both a customer and an
   * inspector must never be quoted — or later dispatched — its own job (F-13).
   */
  private async priceQuote(
    lat: number,
    lng: number,
    scheduledAt: Date,
    customerId?: string,
  ): Promise<PricedQuote> {
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
      returnTripFactor,
      freeRadiusKm,
      capKm,
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
      this.settings.getNumber('orderReturnTripFactor'),
      this.settings.getNumber('orderFreeRadiusKm'),
      this.settings.getNumber('orderCapKm'),
      this.settings.getNumber('orderRoutingCacheHours'),
    ]);

    const globalTariff = {
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      surgeMultiplier,
      peakMultiplier,
      peakStartHour,
      peakEndHour,
      returnTripFactor,
      freeRadiusKm,
    };

    // The region of the INSPECTION ADDRESS decides the tariff. Resolved here
    // rather than only at order creation so a quote and the order it turns into
    // cannot disagree: the customer must be charged what they were shown.
    // A geocode costs a provider request on a cache miss and nothing after —
    // the cache key is a ~1 km cell held for 30 days.
    const countryCode = (await this.geocoding.countryCodeFor({ lat, lng })) ?? DEFAULT_COUNTRY_CODE;
    const region = await this.loadRegionalOverrides(countryCode);
    const resolved = resolveTariff(globalTariff, freeRadiusKm, region.zone, region.country);
    const tariff = resolved.tariff;
    // A region may set its own cap; the global setting is the fallback.
    const effectiveCapKm = resolved.limits.capKm ?? (capKm > 0 ? capKm : null);

    const candidates = await this.geo.findNearestInspectors({
      lat,
      lng,
      radiusKm,
      limit: 3,
      excludeCustomerId: customerId ?? null,
    });

    if (candidates.length === 0) {
      return {
        available: false,
        refusal: 'no_coverage',
        countryCode,
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

    // The cap refuses HERE, before a price exists. Quoting a 300 km trip and
    // letting the customer pay produces an order no inspector accepts, which
    // then holds their money for the whole six-hour search window before the
    // cron cancels it. Measured one direction, on the same basis the operator
    // typed the number in.
    if (exceedsCap(route.distanceKm, effectiveCapKm)) {
      return {
        available: false,
        refusal: 'too_far',
        countryCode,
        candidates: [],
        routingSource: route.source,
        price: computePrice({ distanceKm: 0, durationMin: 0, scheduledAt, tariff }),
      };
    }

    return {
      available: true,
      countryCode,
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

  /**
   * Public quote — reachable WITHOUT an account (F-10): a visitor who cannot see
   * a price has no reason to create one.
   *
   * On no coverage a WaitlistEntry is recorded only when we actually know who is
   * asking; `WaitlistEntry.email` is the whole point of the row and we will not
   * invent one. `waitlisted` tells the UI whether it still needs to ask for an
   * email.
   */
  async quote(userId: string | undefined, dto: QuoteOrderDto): Promise<QuoteResult> {
    const priced = await this.priceQuote(dto.lat, dto.lng, new Date(dto.scheduledAt), userId);

    if (!priced.available) {
      // A waitlist entry is recorded for BOTH refusals: "too far" is a lead in
      // exactly the same sense as "no coverage" — someone wants an inspection
      // at a place we do not serve yet — and the row carries the location.
      const waitlisted = userId ? await this.addToWaitlist(userId, dto.lat, dto.lng) : false;
      return { available: false, waitlisted, refusal: priced.refusal ?? 'no_coverage' };
    }

    const p = priced.price;
    return {
      available: true,
      currency: 'EUR',
      totalCents: p.totalCents,
      breakdown: {
        baseFeeCents: p.baseFeeCents,
        distanceFeeCents: p.distanceFeeCents,
        // Both distances travel to the client. `distanceKm` answers "how far is
        // the inspector"; `billedDistanceKm` is the quantity the rate was
        // applied to, so a customer checking our arithmetic reaches our number
        // and not half of it.
        distanceKm: p.distanceKm,
        freeRadiusKm: p.freeRadiusKm,
        chargeableDistanceKm: p.chargeableDistanceKm,
        billedDistanceKm: p.billedDistanceKm,
        returnTripFactor: p.returnTripFactor,
        distanceSource: priced.routingSource === 'mapbox' ? 'road' : 'straight_line',
        durationMin: p.durationMin,
        billedDurationMin: p.billedDurationMin,
        timeFeeCents: p.timeFeeCents,
        subtotalCents: p.subtotalCents,
        surgeMultiplier: p.surgeMultiplier,
        surgeFeeCents: p.surgeFeeCents,
        peakApplied: p.peakApplied,
        minimumFareCents: p.minimumFareCents,
        minimumFareTopUpCents: p.minimumFareTopUpCents,
        minimumFareApplied: p.minimumFareApplied,
        platformFeeCents: p.platformFeeCents,
        inspectorShareCents: p.inspectorShareCents,
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

  /** Returns true when a WaitlistEntry was actually created. */
  private async addToWaitlist(userId: string, lat: number, lng: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) return false;
    const entry = await this.prisma.waitlistEntry.create({ data: { email: user.email } });
    await this.geo.setWaitlistLocation(entry.id, lat, lng);
    return true;
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
    // `userId` is passed so the customer is excluded from their own candidate
    // set here too — otherwise a self-dealing account would pay for an order
    // that dispatch could never fill.
    const priced = await this.priceQuote(dto.lat, dto.lng, new Date(dto.scheduledAt), userId);
    if (!priced.available) {
      // Two codes, because the two refusals need different words from the UI:
      // "we are not there yet" invites a waitlist signup, "that is too far" is
      // about this particular vehicle and may be answered by another address.
      throw new ConflictException(
        priced.refusal === 'too_far'
          ? {
              error: {
                code: 'distance_cap_exceeded',
                message: 'The vehicle is beyond the distance we serve from the nearest inspector',
              },
            }
          : { error: { code: 'no_coverage', message: 'No inspector available in your area' } },
      );
    }

    const number = await this.generateOrderNumber();

    // The country the price was resolved for, straight from the quote — asking
    // the geocoder a second time could answer differently and store a country
    // the fare was not calculated with.
    const countryCode = priced.countryCode;

    // Order.location is NOT NULL geography(Unsupported) — insert via raw SQL so
    // the geography is set inline at insert time.
    const orderId = await this.insertOrder(number, userId, dto, priced, countryCode);

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
      // The intent uses MANUAL capture, so confirming it in the browser places a
      // hold — it does not charge. The order stays CREATED until
      // `payment_intent.amount_capturable_updated` says the hold is in place;
      // that webhook starts the search window and dispatches. Nothing is taken
      // until an inspector accepts.
      return { orderId, paymentClientSecret: pi.client_secret ?? null };
    }

    // MOCK mode: there is no card to hold, so authorize in our own ledger and
    // run exactly the path the webhook would — PAID, a search deadline,
    // dispatch. The money is deliberately NOT taken here: `captureOrderPayment`
    // still runs at acceptance, so mock mode exercises the real two-step shape
    // instead of a shortcut that would leave capture untested everywhere except
    // the one suite that stands a fake Stripe up.
    await this.authorizeOrderPayment(payment.id, orderId);
    return { orderId, paymentClientSecret: null, mock: true };
  }

  // ============================================================
  // Money state machine: authorize → capture → (release)
  // ============================================================

  /**
   * The hold is in place: the card was authorized and the funds are reserved,
   * but nothing has been taken. Move the payment to 'authorized', start the
   * inspector search window, take the order CREATED → PAID and dispatch.
   *
   * Called from the `payment_intent.amount_capturable_updated` webhook, from
   * mock-mode order creation, and from the reconciler when that webhook was
   * lost. Idempotent in every half, because all three can race.
   *
   * `searchExpiresAt` is only ever set FROM NULL. Re-authorizing must not
   * silently extend a deadline the expiry cron is already counting down — and
   * an order that reached PAID some other way (the legacy captured-at-creation
   * path) must never acquire one at all: there is no hold to release.
   */
  async authorizeOrderPayment(paymentId: string, orderId: string): Promise<void> {
    const now = new Date();
    // Guarded on the statuses that may still become a hold. 'pending' is the
    // normal one; 'failed' covers a first card that was declined and a second
    // that was not. A 'succeeded' payment has been CAPTURED and must never be
    // walked backwards into a hold.
    await this.prisma.payment
      .updateMany({
        where: { id: paymentId, status: { in: ['pending', 'failed'] } },
        data: { status: 'authorized', authorizedAt: now },
      })
      .catch(() => undefined);

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.CREATED) return;

    if (order.searchExpiresAt === null) {
      const windowMinutes = await this.settings.getNumber('orderSearchWindowMinutes');
      await this.prisma.order.update({
        where: { id: orderId },
        data: { searchExpiresAt: new Date(now.getTime() + windowMinutes * 60_000) },
      });
    }

    await this.transition(orderId, OrderStatus.PAID, 'system');
    await this.dispatch(orderId);
  }

  /**
   * Take the money that has been held for an order — the single place a capture
   * happens. Never throws; see {@link CaptureOutcome} for what the caller must
   * do with each answer.
   *
   * The invariant this exists to protect: **an order must never be ASSIGNED
   * with uncaptured money.** Every path that assigns an inspector calls this
   * first and refuses the assignment unless it comes back captured.
   */
  async captureOrderPayment(orderId: string): Promise<CaptureOutcome> {
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) return { status: 'fatal', detail: 'order has no payment' };
    if (payment.status === 'succeeded') return { status: 'already_captured' };
    if (payment.status !== 'authorized' && payment.status !== 'pending') {
      // refunded / cancelled / anything else: the money is gone or was given
      // back. No amount of retrying makes this order payable.
      return { status: 'fatal', detail: `payment is ${payment.status}` };
    }

    if (!this.stripe.configured) {
      // MOCK mode: no provider to call, but the ledger still records that the
      // money moved at ACCEPTANCE rather than at creation — which is the whole
      // behavioural change, and it stays observable without a Stripe key.
      await this.markPaymentCaptured(payment.id);
      return { status: 'captured' };
    }

    if (!payment.stripePaymentIntentId) {
      // The intent id is written at creation, so this is a lost write or a
      // half-created order. Retryable, not fatal: cancelling a customer's order
      // over a gap in our own bookkeeping is the worse mistake, and
      // `reconcileStuckOrderPayments` keeps the row visible.
      return { status: 'retryable', detail: 'payment has no Stripe PaymentIntent' };
    }
    if (payment.status === 'pending') {
      // No hold yet — the customer has not finished paying, or the
      // `amount_capturable_updated` webhook has not landed. Capturing would
      // fail anyway; let the inspector accept again once it has.
      return { status: 'retryable', detail: 'the authorization hold is not in place yet' };
    }

    try {
      await this.stripe.capturePaymentIntent(payment.stripePaymentIntentId, payment.id);
    } catch (err) {
      const failure = classifyStripeError(err);
      // `payment_intent_unexpected_state` is ambiguous: Stripe says it both when
      // the intent was ALREADY captured (a retry past the 24-hour idempotency
      // window) and when it can never be captured. Ask which — treating an
      // already-captured intent as fatal would cancel an order and "release" a
      // hold whose money we are actually holding.
      if (failure.code === 'payment_intent_unexpected_state') {
        const intent = await this.stripe
          .retrievePaymentIntent(payment.stripePaymentIntentId)
          .catch(() => null);
        if (intent?.status === 'succeeded') {
          await this.markPaymentCaptured(payment.id);
          return { status: 'already_captured' };
        }
      }
      this.logger.error(
        `captureOrderPayment: order ${orderId} could not be captured: ${failure.message}`,
      );
      return { status: failure.retryable ? 'retryable' : 'fatal', detail: failure.message };
    }

    await this.markPaymentCaptured(payment.id);
    return { status: 'captured' };
  }

  /**
   * Record that the money was taken. `capturedAt` is written once and never
   * moved: it is the only evidence distinguishing a fresh capture from an old
   * charge, and the reconciler reads it.
   */
  private async markPaymentCaptured(paymentId: string): Promise<void> {
    const now = new Date();
    await this.prisma.payment.updateMany({
      where: { id: paymentId },
      data: { status: 'succeeded' },
    });
    await this.prisma.payment.updateMany({
      where: { id: paymentId, capturedAt: null },
      data: { capturedAt: now },
    });
  }

  /** Insert an Order with its geography set inline (raw SQL). Returns the id. */
  private async insertOrder(
    number: string,
    customerId: string,
    dto: CreateOrderDto,
    priced: PricedQuote,
    countryCode: string,
  ): Promise<string> {
    // The order row is inserted with raw SQL (PostGIS geography), so Prisma's
    // `@default(cuid())` never runs and we mint the id here. The column is a
    // plain text PK, so any unique string works.
    const id = randomUUID();
    const p = priced.price;
    // The BILLED distance, not the measured one: this column is what the
    // invoice and the contract quote, so it must be the quantity the per-km
    // rate multiplied. `return_trip_factor` beside it recovers the measured
    // distance for anyone who needs it.
    const distanceKm = new Prisma.Decimal(p.billedDistanceKm);
    const returnTripFactor = new Prisma.Decimal(p.returnTripFactor.toFixed(2));
    const freeRadiusKm = new Prisma.Decimal(p.freeRadiusKm.toFixed(2));
    const surgeMultiplier = new Prisma.Decimal(p.surgeMultiplier.toFixed(2));
    await this.prisma.$executeRaw`
      INSERT INTO "order" (
        id, number, customer_id, status, vin, make, model, listing_url, address,
        location, scheduled_at, country_code,
        base_fee_cents, distance_km, return_trip_factor, free_radius_km, distance_fee_cents, duration_min,
        time_fee_cents, surge_multiplier, minimum_fare_applied, routing_source,
        total_cents, platform_fee_cents, inspector_share_cents, currency, "createdAt"
      ) VALUES (
        ${id}, ${number}, ${customerId}, 'CREATED'::"OrderStatus",
        ${dto.vin?.toUpperCase() ?? null}, ${dto.make}, ${dto.model},
        ${dto.listingUrl ?? null}, ${dto.address},
        ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
        ${new Date(dto.scheduledAt)}, ${countryCode},
        ${p.baseFeeCents}, ${distanceKm}, ${returnTripFactor}, ${freeRadiusKm}, ${p.distanceFeeCents}, ${p.billedDurationMin},
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

    const candidates = await this.geo.findNearestInspectors({
      lat,
      lng,
      radiusKm,
      limit: 1,
      excludeUserIds: excluded,
      // F-13: never offer the order to the account that placed it.
      excludeCustomerId: order.customerId,
    });

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
      data: {
        orderId,
        inspectorId: nearest.userId,
        status: 'PENDING',
        expiresAt,
        // How far THIS inspector is, which is not what the order was priced on
        // once dispatch has walked past the first candidate.
        straightLineKm: new Prisma.Decimal(nearest.distanceKm.toFixed(2)),
      },
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

  /**
   * An inspector takes the job. This is the moment the customer's money is
   * actually TAKEN, so the method is written around two guarantees:
   *
   * 1. **One inspector wins.** The claim is a single conditional `updateMany`
   *    on (status, inspectorId IS NULL), so the database decides the race. The
   *    previous version did three unguarded writes after a read — two
   *    inspectors accepting the same order milliseconds apart both "won", the
   *    second silently overwrote the first's `inspectorId`, and the loser was
   *    told they had the job while the winner's contract named them.
   * 2. **An order is never ASSIGNED with uncaptured money.** Capture happens
   *    BEFORE the transition, and any failure undoes the claim first.
   *
   * A retryable capture failure returns the offer to PENDING and answers 503:
   * nothing is lost and the same inspector can accept again. A fatal one
   * releases the hold and cancels the order — the card cannot pay, and leaving
   * an unpayable order in the pool only sends the next inspector to the same
   * dead end.
   */
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

    // F-13, second line of defence. The candidate query already excludes the
    // customer, but a hand-written or legacy OrderOffer row reaches this method
    // without ever passing through it — and self-assignment ends with the
    // account approving its own report and collecting its own payout. Checked
    // before the claim so a self-dealing account never even briefly holds it.
    if (order.customerId === userId) {
      throw new ForbiddenException({
        error: {
          code: 'self_assignment_forbidden',
          message: 'You cannot accept an inspection you ordered yourself',
        },
      });
    }

    // The race is decided here, in one statement, by the database. `count === 0`
    // means the order left the pool or someone else claimed it first.
    const claim = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PAID, OrderStatus.UNASSIGNED] },
        inspectorId: null,
      },
      data: { inspectorId: userId },
    });
    if (claim.count === 0) {
      throw new ConflictException({
        error: { code: 'already_assigned', message: 'Order is no longer open for assignment' },
      });
    }

    await this.prisma.orderOffer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });

    const capture = await this.captureOrderPayment(order.id);

    if (capture.status === 'retryable') {
      // Transient. Put everything back exactly as it was — the offer is still
      // within its window, so the same inspector can accept again.
      await this.releaseOrderClaim(order.id, userId);
      await this.prisma.orderOffer.updateMany({
        where: { id: offerId, status: 'ACCEPTED' },
        data: { status: 'PENDING' },
      });
      await this.writeEvent(order.id, userId, 'capture_deferred', null, null, {
        offerId,
        detail: capture.detail,
      });
      throw new ServiceUnavailableException({
        error: {
          code: 'payment_capture_unavailable',
          message: 'The payment could not be taken right now. Please try accepting again shortly.',
        },
      });
    }

    if (capture.status === 'fatal') {
      // The card cannot pay. Undo the claim, give the hold back, and take the
      // order out of the pool: re-offering it would only send the next
      // inspector to the same dead end.
      await this.releaseOrderClaim(order.id, userId);
      await this.prisma.orderOffer.updateMany({
        where: { orderId: order.id, status: { in: ['PENDING', 'ACCEPTED'] } },
        data: { status: 'EXPIRED' },
      });
      await this.writeEvent(order.id, userId, 'capture_failed', null, null, {
        offerId,
        detail: capture.detail,
      });
      // Non-throwing by contract; releases the hold and writes no Refund row.
      await this.settleRefund(order, order.totalCents, 'capture_failed');
      await this.transition(order.id, OrderStatus.CANCELLED, 'system');
      throw new ConflictException({
        error: {
          code: 'payment_capture_failed',
          message: 'The customer\u2019s payment could not be taken; the order has been cancelled.',
        },
      });
    }

    // Any OTHER live offer on this order is dead now. Left PENDING it would keep
    // showing the job in a losing inspector's list, and `getDetail` would keep
    // granting them access to an order they cannot take. Runs only after a
    // successful capture, so the retryable branch's restore is never clobbered.
    await this.prisma.orderOffer.updateMany({
      where: { orderId: order.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    await this.transition(order.id, OrderStatus.ASSIGNED, userId);
    return { orderId: order.id, status: OrderStatus.ASSIGNED };
  }

  /**
   * Hand a claimed order back to the pool. Guarded on the claiming inspector so
   * a late undo can never strip an assignment somebody else legitimately holds.
   */
  private async releaseOrderClaim(orderId: string, inspectorId: string): Promise<void> {
    await this.prisma.order.updateMany({
      where: {
        id: orderId,
        inspectorId,
        status: { in: [OrderStatus.PAID, OrderStatus.UNASSIGNED] },
      },
      data: { inspectorId: null },
    });
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

  /**
   * Customer cancellation.
   *
   * `refundMode` exists because `refundCents: 0` is ambiguous under manual
   * capture: it means both "you were never charged" and "the hold on your card
   * has been released". The website words those two confirmations differently,
   * and a released hold must NOT be described as a refund — the money never
   * left the customer's account, so there is no Refund row and nothing will
   * appear on their statement to reconcile against.
   */
  async cancel(
    orderId: string,
    userId: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    refundCents: number;
    refundMode: RefundMode;
  }> {
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
    // Settle the money BEFORE moving the order, and never let it decide whether
    // the cancellation happens: `settleRefund` cannot throw. An order whose card
    // was never charged records a skip instead of calling Stripe — that call,
    // made against a PaymentIntent with no successful charge, is why cancelling
    // an unpaid order used to answer 500 and leave the order untouched.
    const outcome = await this.settleRefund(order, refundCents, reason);
    await this.transition(orderId, OrderStatus.CANCELLED, userId);
    // What the customer is actually owed: zero when there was nothing to give
    // back, the full amount when the refund is issued or queued for retry.
    return {
      orderId,
      status: OrderStatus.CANCELLED,
      refundCents: outcome.amountCents,
      refundMode: refundModeOf(outcome.status),
    };
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

    // F-13, third line of defence: an admin override must not be able to do what
    // the dispatcher is forbidden from doing.
    if (order.customerId === inspectorId) {
      throw new BadRequestException({
        error: {
          code: 'self_assignment_forbidden',
          message: 'The customer of an order cannot be assigned as its inspector',
        },
      });
    }

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

    // The SAME conditional claim `acceptOffer` uses, for the same reason. An
    // unconditional write here loses the race it looks like it wins: an
    // inspector accepting their pending offer at the same moment claims the
    // order, captures the money and gets a contract rendered in their name —
    // and then this overwrites `inspectorId`. The capture below would answer
    // `already_captured`, the transition would no-op on `from === to` so the
    // contract is never re-rendered, and the order would end up assigned to one
    // inspector while its legal contract names another, with two ACCEPTED
    // offers and the losing inspector holding a 200.
    //
    // The undo path made it worse: `releaseOrderClaim` is guarded on
    // PAID/UNASSIGNED, so once the other inspector moved the order to ASSIGNED
    // it silently no-ops and the admin's inspector stays on the row.
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: order.status, inspectorId: null },
      data: { inspectorId },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        error: {
          code: 'already_assigned',
          message: 'This order was assigned to an inspector while you were assigning it',
        },
      });
    }

    // An admin override is still an assignment, so the same invariant applies:
    // an order must never be ASSIGNED with uncaptured money. Capturing here is
    // not optional politeness — without it an operator could hand an inspector
    // a job whose funds are only held, and the hold would then expire at Stripe
    // in the middle of the inspection.
    const capture = await this.captureOrderPayment(orderId);
    if (capture.status === 'retryable') {
      await this.releaseOrderClaim(orderId, inspectorId);
      throw new ServiceUnavailableException({
        error: {
          code: 'payment_capture_unavailable',
          message: 'The payment could not be taken right now. Try the assignment again shortly.',
        },
      });
    }
    if (capture.status === 'fatal') {
      await this.releaseOrderClaim(orderId, inspectorId);
      await this.writeEvent(orderId, `admin:${adminId}`, 'capture_failed', null, null, {
        inspectorId,
        detail: capture.detail,
      });
      await this.settleRefund(order, order.totalCents, 'capture_failed');
      await this.transition(orderId, OrderStatus.CANCELLED, `admin:${adminId}`);
      throw new ConflictException({
        error: {
          code: 'payment_capture_failed',
          message: 'The customer\u2019s payment could not be taken; the order has been cancelled.',
        },
      });
    }

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
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    refundCents: number;
    refundMode: RefundMode;
  }> {
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
    const intendedCents = pct > 0 ? Math.round((order.totalCents * pct) / 100) : 0;
    // Whether there is anything to refund is `settleRefund`'s decision, not a
    // payment-status check duplicated here: it also covers a released hold and
    // an already-refunded payment, which this check never did.
    const outcome =
      intendedCents > 0 ? await this.settleRefund(order, intendedCents, 'admin') : null;

    await this.transition(orderId, OrderStatus.CANCELLED, `admin:${adminId}`);
    return {
      orderId,
      status: OrderStatus.CANCELLED,
      refundCents: outcome?.amountCents ?? 0,
      refundMode: outcome ? refundModeOf(outcome.status) : 'none',
    };
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
      const intendedCents = Math.round((order.totalCents * pct) / 100);
      const outcome =
        intendedCents > 0 ? await this.settleRefund(order, intendedCents, 'dispute') : null;

      // The dispute closes WHATEVER the money did. It used to close only after a
      // successful refund, so a refund Stripe rejected threw out of this method
      // and left the dispute OPEN in the admin queue for ever — one incident
      // reported twice, and the second report is the one nobody can action.
      let transitionError: unknown = null;
      try {
        await this.transition(orderId, OrderStatus.REFUNDED, `admin:${adminId}`);
      } catch (err) {
        transitionError = err;
      }
      await this.closeDispute(
        orderId,
        'RESOLVED_CUSTOMER',
        `Resolved in favour of the customer (${pct}% refund)`,
        adminId,
        now,
      );
      if (transitionError) throw transitionError;

      const resolved = await this.requireOrder(orderId);
      return {
        orderId,
        status: resolved.status,
        refundCents: outcome?.amountCents ?? 0,
        payoutCents: 0,
      };
    }

    // inspector wins → APPROVED then release the escrowed share.
    let transitionError: unknown = null;
    try {
      await this.transition(orderId, OrderStatus.APPROVED, `admin:${adminId}`);
      await this.releasePayout(orderId);
    } catch (err) {
      transitionError = err;
    }
    await this.closeDispute(
      orderId,
      'RESOLVED_INSPECTOR',
      'Resolved in favour of the inspector',
      adminId,
      now,
    );
    if (transitionError) throw transitionError;
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
      const now = new Date();
      // Orders assigned to me OR for which I have an active offer.
      const offered = await this.prisma.orderOffer.findMany({
        where: {
          inspectorId: userId,
          status: 'PENDING',
          expiresAt: { gt: now },
        },
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
    const offer = await this.prisma.orderOffer.findFirst({
      where: {
        orderId,
        inspectorId: userId,
        OR: [
          { status: 'ACCEPTED' },
          { status: 'PENDING', expiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    const isCustomer = order.customerId === userId;
    const isInspector = order.inspectorId === userId;
    const hasInspectorOffer = !!offer;
    const isAdmin = role === Role.ADMIN;
    if (!isCustomer && !isInspector && !hasInspectorOffer && !isAdmin) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }

    const events = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

    /*
     * ⚠ DISCLOSURE IS ONE-WAY AND STARTS AT THE FINISH LINE.
     *
     * Both halves of this changed on 2026-08-11, by the owner's decision, and
     * neither is an implementation detail that may drift back:
     *
     *  1. The inspector's channels reach the customer only at COMPLETED. While
     *     the job is running the platform carries the conversation; the point of
     *     the card is the period AFTER the report, when the customer wants to
     *     ask the person who looked at the car. Disclosing at assignment let the
     *     two parties step out of the platform before it had delivered anything.
     *  2. The customer's channels are never disclosed to the inspector at all.
     *
     * COMPLETED is reached by a successful PAYOUT, not by the inspection — an
     * order whose payout parks (an inspector without Stripe onboarding) stays
     * APPROVED, and its customer sees no contacts. That is the accepted cost of
     * "only when it is finished"; `releasePayout` parks rather than fails, and
     * the admin finance queue is where such an order gets unstuck.
     */
    /*
     * COMPLETED and nothing else.
     *
     * DISPUTED is deliberately NOT here (owner's decision, reverted 2026-08-11
     * after being tried): a dispute is handled by the platform, and handing the
     * two sides each other's channels mid-conflict moves the argument somewhere
     * nobody can see or arbitrate. The admin holds both sides for exactly that
     * reason — see the admin branch below.
     */
    const disclosedToCustomer = order.status === OrderStatus.COMPLETED;

    /*
     * The status gate binds the CUSTOMER, never the admin: an admin who could
     * only see the parties of a finished order would be blind on the cases they
     * exist for. Both directions are admin-readable in every status, and neither
     * is customer- or inspector-readable outside the rule above.
     */
    let inspectorContact: PartyContact | null = null;
    if (order.inspectorId && ((isCustomer && disclosedToCustomer) || isAdmin)) {
      const [insp, profile] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: order.inspectorId },
          select: { id: true, name: true, email: true, phone: true, deletedAt: true },
        }),
        this.prisma.inspectorProfile.findUnique({
          where: { userId: order.inspectorId },
          select: {
            companyName: true,
            contactPhone: true,
            contactEmail: true,
            contactWhatsapp: true,
            contactTelegram: true,
          },
        }),
      ]);
      inspectorContact = resolveContact(insp, profile);
    }

    /*
     * The customer's channels go to an ADMIN and to nobody else.
     *
     * Not even to the assigned inspector, and not at any status: an inspector
     * who has the customer's phone number can arrange the next job — and every
     * one after it — directly, which takes the platform out of the transaction
     * it is responsible for. The address and the scheduled time are already on
     * the order, so the work itself needs no personal channel.
     *
     * The admin keeps it because a dispute cannot be resolved without reaching
     * both sides.
     */
    let customerContact: PartyContact | null = null;
    if (isAdmin) {
      const customer = await this.prisma.user.findUnique({
        where: { id: order.customerId },
        select: { id: true, name: true, email: true, phone: true, deletedAt: true },
      });
      customerContact = resolveContact(customer);
    }

    // The report row is read in EVERY status, because `reportRequirement` below
    // is, but it is only EXPOSED from SUBMITTED onwards — a customer must not be
    // able to read the report before it is filed.
    const submittedOrLater: OrderStatus[] = [
      OrderStatus.SUBMITTED,
      OrderStatus.APPROVED,
      OrderStatus.COMPLETED,
      OrderStatus.DISPUTED,
    ];
    const reportRow = await this.prisma.report.findUnique({
      where: { orderId },
      select: { id: true, code: true, qualityScore: true },
    });
    const report =
      submittedOrLater.includes(order.status) && reportRow
        ? { id: reportRow.id, code: reportRow.code, qualityScore: reportRow.qualityScore }
        : null;

    const [payment, minQualityScore] = await Promise.all([
      this.prisma.payment.findUnique({ where: { orderId } }),
      this.settings.getNumber('minReportQualityScore'),
    ]);

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      vehicle: { vin: order.vin, make: order.make, model: order.model },
      address: order.address,
      scheduledAt: order.scheduledAt.toISOString(),
      money: {
        baseFeeCents: order.baseFeeCents,
        // Stored billed; everything else is derived, so a stored order and a
        // fresh quote describe the same quantities. Undo the return trip first,
        // then add the free radius back: that is the order the fare applied
        // them in, and reversing it would report the wrong trip.
        distanceKm:
          Number(order.distanceKm) / Number(order.returnTripFactor) + Number(order.freeRadiusKm),
        chargeableDistanceKm: Number(order.distanceKm) / Number(order.returnTripFactor),
        billedDistanceKm: Number(order.distanceKm),
        returnTripFactor: Number(order.returnTripFactor),
        freeRadiusKm: Number(order.freeRadiusKm),
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
      customerContact,
      report,
      // Where the money is. Under manual capture the order status alone no
      // longer answers that: PAID means "committed", and held-versus-taken is a
      // payment fact, not an order state.
      payment: payment
        ? {
            state: PUBLIC_PAYMENT_STATE[payment.status] ?? 'pending',
            amountCents: payment.amountCents,
            authorizedAt: payment.authorizedAt?.toISOString() ?? null,
            capturedAt: payment.capturedAt?.toISOString() ?? null,
            releasedAt: payment.canceledAt?.toISOString() ?? null,
          }
        : null,
      // Null for an order created before manual capture: its money was charged
      // outright, so there was never a search window and never a hold. The
      // website reads null as "no countdown", which is exactly right.
      search: order.searchExpiresAt
        ? {
            deadlineAt: order.searchExpiresAt.toISOString(),
            // Derived from the event the expiry cron writes rather than a
            // seventh column: one fact, one place, and the timeline already
            // carries it.
            expiredAt:
              events.find((e) => e.type === 'search_expired')?.createdAt.toISOString() ?? null,
          }
        : null,
      // Returned in EVERY status on purpose. Its entire job is to be read while
      // the order is ASSIGNED — before the inspector drives anywhere — so they
      // know what the report has to reach to close the job. Telling them at
      // submission time is telling them too late.
      reportRequirement: {
        minQualityScore,
        currentQualityScore: reportRow?.qualityScore ?? null,
        // The counts the inspector actually has to satisfy. Data, not copy:
        // the frontend owns the wording of "photograph every exterior angle",
        // this owns how many angles that is, so growing the walk-around does
        // not need a website release. `gateEnabled` mirrors the lever in
        // `assertReportComplete` so a disabled gate does not display a
        // requirement nobody is being held to.
        gateEnabled: minQualityScore > 0,
        exteriorAngles: currentRequiredAngles().length,
        thicknessPanels: thicknessPanelIds().length,
        calibrationPhotos: 2,
        wheels: 4,
      },
      autoApproveAt: order.autoApproveAt ? order.autoApproveAt.toISOString() : null,
      submittedAt: order.submittedAt ? order.submittedAt.toISOString() : null,
      createdAt: order.createdAt.toISOString(),
      offer: offer ? { id: offer.id, status: offer.status } : null,
      offerId: offer?.id ?? null,
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

  /**
   * Nobody accepted in time. Release the customer's hold and cancel.
   *
   * **`searchExpiresAt IS NULL` is skipped, and that is load-bearing.** A null
   * deadline means the order predates manual capture: its money was CHARGED at
   * creation, not held, so there is no authorization to release and cancelling
   * it here would take a live order away from a customer who has actually paid.
   * The column is deliberately never backfilled — see the migration. `not: null`
   * is therefore written out even though `lt` implies it, because it is the
   * invariant, not an optimisation.
   *
   * One bad order must not stop the batch: the loop is individually guarded.
   */
  async expireUnfilledSearches(limit = 50): Promise<{ expired: number }> {
    const now = new Date();
    const due = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PAID, OrderStatus.UNASSIGNED] },
        inspectorId: null,
        searchExpiresAt: { not: null, lt: now },
      },
      orderBy: { searchExpiresAt: 'asc' },
      take: limit,
    });

    let expired = 0;
    for (const order of due) {
      try {
        // ── The claim, and why it comes first ──────────────────────────────
        //
        // The rows above are a SNAPSHOT. A batch of fifty spends a Stripe round
        // trip and a notification on each, so tens of seconds pass before the
        // last one is reached — and an offer's own timeout is unrelated to the
        // search deadline, so a live PENDING offer past the deadline is normal.
        // An inspector can therefore accept an order that is sitting in this
        // list: they capture the money, the contract renders, and this loop then
        // arrives with a stale row, refunds a CAPTURED payment as
        // `search_expired`, and cancels a job someone may already be driving to.
        //
        // So the status change is the claim, not the conclusion: one conditional
        // write, and `count === 0` means acceptOffer won the race.
        //
        // This deliberately inverts the settle-before-transition rule the cancel
        // paths follow. That rule protects against transitioning with the money
        // still taken; here the money is a HOLD, `settleRefund` never throws, and
        // a release that fails is parked and retried. Refunding a captured order
        // by accident is not recoverable in the same way.
        const claimed = await this.prisma.order.updateMany({
          where: {
            id: order.id,
            status: { in: [OrderStatus.PAID, OrderStatus.UNASSIGNED] },
            inspectorId: null,
            searchExpiresAt: { not: null, lt: now },
          },
          data: { status: OrderStatus.CANCELLED },
        });
        if (claimed.count === 0) continue;

        await this.prisma.orderOffer.updateMany({
          where: { orderId: order.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        // Releases the hold and writes NO Refund row — nothing ever left the
        // customer's account. Non-throwing by contract.
        const outcome = await this.settleRefund(order, order.totalCents, 'search_expired');
        // Written BEFORE the transition so `getDetail().search.expiredAt` can be
        // derived from it, and so the timeline explains the cancellation that
        // follows rather than just recording it.
        await this.writeEvent(order.id, 'system', 'search_expired', null, null, {
          deadlineAt: order.searchExpiresAt?.toISOString() ?? null,
          release: outcome.status,
          detail: outcome.detail,
        });
        // The claim above already wrote the status, so this records the change
        // `transition` would have recorded. Its other work for CANCELLED is a
        // `status_change` event and an `order.cancelled` notification — the
        // event is written here, and the notification is deliberately replaced
        // by the one below.
        await this.writeEvent(
          order.id,
          'system',
          'status_change',
          order.status,
          OrderStatus.CANCELLED,
          null,
        );
        // `order.cancelled` would be true and useless: the customer did nothing,
        // and what they need to hear is about their money. A released
        // authorization can sit in a card statement for several working days, so
        // a message that only says "cancelled" reads as "charged me and
        // cancelled anyway". Notifications never throw into a domain flow, so
        // this cannot un-expire the order.
        await this.notifications.notify(order.customerId, 'order.search_expired', {
          orderId: order.id,
          orderNumber: order.number,
          released: outcome.status,
        });
        expired += 1;
      } catch (err) {
        this.logger.error(
          `expireUnfilledSearches: order ${order.id} threw: ${(err as Error).message}`,
        );
      }
    }
    return { expired };
  }

  /**
   * Insurance against a lost or delayed webhook — not a plan. Stripe must be
   * subscribed to `payment_intent.amount_capturable_updated`; without it every
   * order authorizes and sits in CREATED, and this job would be the only thing
   * moving them, fifteen minutes at a time.
   *
   * Two selections, because the two failures are opposite and both cost real
   * money:
   *
   * - **Waiting**: a payment still 'pending'/'authorized' on an order that has
   *   not left the search pool. Ask Stripe what actually became of the intent
   *   and drive the order to the state the money is already in.
   * - **Working**: an order at or past ASSIGNED whose payment is still only
   *   held. An inspector is doing the job for free, and the hold expires at
   *   Stripe after seven days. Capture it.
   */
  async reconcileStuckOrderPayments(limit = 25): Promise<{ scanned: number; advanced: number }> {
    const staleBefore = new Date(Date.now() - RECONCILE_MIN_AGE_MS);
    const uncaptured = { in: ['pending', 'authorized'] };

    const [waiting, working, stranded] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          purpose: 'order',
          status: uncaptured,
          createdAt: { lt: staleBefore },
          order: { is: { status: { in: PRE_ASSIGNMENT_STATUSES } } },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      this.prisma.payment.findMany({
        where: {
          purpose: 'order',
          status: uncaptured,
          createdAt: { lt: staleBefore },
          order: { is: { status: { in: POST_ASSIGNMENT_STATUSES } } },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      // A hold whose release FAILED, on an order that was cancelled anyway.
      //
      // Nothing else picks these up. `releaseAuthorization` writes no `Refund`
      // row by design (a Refund means money went back, and nothing was ever
      // taken), so the refund retry cron cannot see it; and the two selections
      // above are both scoped to statuses that exclude CANCELLED. The result was
      // a customer told "nothing was charged and the hold has been released"
      // while their funds stayed frozen until Stripe expired the authorization
      // on its own — up to seven days.
      this.prisma.payment.findMany({
        where: {
          purpose: 'order',
          status: 'authorized',
          createdAt: { lt: staleBefore },
          order: { is: { status: { in: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] } } },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    ]);

    let advanced = 0;

    for (const payment of stranded) {
      const orderId = payment.orderId as string;
      try {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) continue;
        const outcome = await this.releaseAuthorization(order, payment, 'reconcile_stranded_hold');
        if (outcome.status === 'released') {
          advanced += 1;
          this.logger.warn(`reconcile: released a stranded hold on cancelled order ${orderId}`);
        }
      } catch (err) {
        this.logger.error(
          `reconcile: stranded hold on order ${orderId} threw: ${(err as Error).message}`,
        );
      }
    }

    for (const payment of working) {
      const orderId = payment.orderId as string;
      try {
        const outcome = await this.captureOrderPayment(orderId);
        if (outcome.status === 'captured') {
          advanced += 1;
          this.logger.warn(
            `reconcile: captured the late payment on assigned order ${orderId}`,
          );
        } else if (outcome.status === 'fatal') {
          // Deliberately NOT cancelled here. The inspection may already be done;
          // unwinding it is a decision for an operator, not a cron.
          this.logger.error(
            `reconcile: order ${orderId} is assigned but unpayable (${outcome.detail}) — needs an operator`,
          );
        }
      } catch (err) {
        this.logger.error(`reconcile: order ${orderId} threw: ${(err as Error).message}`);
      }
    }

    for (const payment of waiting) {
      try {
        if (await this.reconcileWaitingPayment(payment)) advanced += 1;
      } catch (err) {
        this.logger.error(
          `reconcile: payment ${payment.id} threw: ${(err as Error).message}`,
        );
      }
    }

    return { scanned: waiting.length + working.length + stranded.length, advanced };
  }

  /**
   * One stuck pre-assignment payment. Returns true when the order moved.
   *
   * Stripe is the authority here, not our ledger: the whole reason this row is
   * being looked at is that we did not hear what happened.
   */
  private async reconcileWaitingPayment(payment: {
    id: string;
    orderId: string | null;
    status: string;
    stripePaymentIntentId: string | null;
  }): Promise<boolean> {
    const orderId = payment.orderId;
    if (!orderId) return false;
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;

    if (payment.status === 'authorized') {
      // A hold on an order still looking for an inspector is healthy until
      // `searchExpiresAt` — unless the order never left CREATED, which means the
      // webhook that starts the search was lost after we recorded the hold.
      if (order.status !== OrderStatus.CREATED) return false;
      await this.authorizeOrderPayment(payment.id, orderId);
      return true;
    }

    // 'pending': we never heard what became of the intent. Ask.
    if (!this.stripe.configured || !payment.stripePaymentIntentId) return false;
    let intent: StripePaymentIntent;
    try {
      intent = await this.stripe.retrievePaymentIntent(payment.stripePaymentIntentId);
    } catch (err) {
      this.logger.error(
        `reconcile: could not read the PaymentIntent for order ${orderId}: ${classifyStripeError(err).message}`,
      );
      return false;
    }

    switch (intent.status) {
      case 'requires_capture':
        // The hold IS in place; only the webhook went missing.
        await this.authorizeOrderPayment(payment.id, orderId);
        return true;
      case 'succeeded': {
        // Captured out of band — an automatic-capture order from before this
        // deploy, or a capture made in the Stripe dashboard. Record the money and
        // start the order, but deliberately do NOT open a search window: there is
        // no hold left to release, so a deadline would only give the expiry cron
        // a captured order to cancel.
        await this.payments.settleOrderPayment(payment.id, orderId);
        return true;
      }
      case 'canceled': {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { not: 'cancelled' } },
          data: { status: 'cancelled', canceledAt: new Date() },
        });
        if (!canTransition(order.status, OrderStatus.CANCELLED)) return false;
        await this.writeEvent(orderId, 'system', 'authorization_released', null, null, {
          reason: 'reconciled',
          released: true,
          error: null,
        });
        await this.transition(orderId, OrderStatus.CANCELLED, 'system');
        return true;
      }
      default:
        // requires_payment_method / requires_confirmation / requires_action /
        // processing — the customer simply has not finished paying. There is
        // nothing to reconcile, and no search window has started.
        return false;
    }
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
  async releasePayout(orderId: string): Promise<PayoutOutcome> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return this.skipPayout(orderId, 'order no longer exists');
    // COMPLETED is allowed so a retry can finish an order whose earlier attempt
    // transitioned it but failed to transfer. `transition` no-ops on from===to.
    if (order.status !== OrderStatus.APPROVED && order.status !== OrderStatus.COMPLETED) {
      return this.skipPayout(orderId, `order is ${order.status} — no payout is owed`);
    }
    if (!order.inspectorId) {
      this.logger.warn(`releasePayout: order ${orderId} has no inspector — skipping`);
      return this.skipPayout(orderId, 'order has no inspector');
    }

    const existing = await this.prisma.payout.findUnique({ where: { orderId } });
    if (existing?.status === 'paid') return { status: 'already_paid' };

    const amountCents = order.inspectorShareCents;
    const profile = await this.prisma.inspectorProfile.findUnique({
      where: { userId: order.inspectorId },
    });

    // Not eligible to receive funds yet → park a pending payout, stay APPROVED.
    if (!profile?.stripeOnboarded || !profile.stripeAccountId) {
      return this.parkPayout(order, amountCents, 'inspector is not onboarded for payouts');
    }

    let stripeTransferId: string | null = `tr_mock_${orderId}`;
    if (this.stripe.configured) {
      const payment = await this.prisma.payment.findUnique({ where: { orderId } });
      if (!payment?.stripePaymentIntentId) {
        return this.parkPayout(order, amountCents, 'order has no Stripe PaymentIntent');
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
          // One payout per order (`Payout.orderId` is unique), so the order id
          // IS the payout's identity and is stable across every retry.
          idempotencyKey: `transfer_${order.id}`,
        });
        stripeTransferId = transfer.id;
      } catch (err) {
        // Transfer failed → park with a retry schedule, stay APPROVED.
        return this.parkPayout(order, amountCents, classifyStripeError(err).message);
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
    return { status: wasAlreadyPaid ? 'already_paid' : 'paid' };
  }

  /**
   * Terminate a payout row that can never settle on its own — the order was
   * cancelled, lost its inspector, or vanished. `nextRetryAt` is cleared so the
   * cron stops re-selecting it (it used to match the due query on every single
   * run, for ever, because `releasePayout` returned early without re-parking),
   * and the reason is written where an operator reads it.
   */
  private async skipPayout(orderId: string, reason: string): Promise<PayoutOutcome> {
    await this.prisma.payout.updateMany({
      where: { orderId, status: { not: 'paid' } },
      data: {
        nextRetryAt: null,
        lastError: `skipped: ${reason}`.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    return { status: 'skipped', reason };
  }

  /**
   * Record a payout that could not be settled, schedule the next attempt, and
   * tell someone. `orderId` is unique on Payout, so this upserts — the retry
   * path must update the parked row, never try to insert a second one.
   */
  private async parkPayout(
    order: { id: string; number: string; inspectorId: string | null },
    amountCents: number,
    reason: string,
  ): Promise<PayoutOutcome> {
    if (!order.inspectorId) return this.skipPayout(order.id, 'order has no inspector');

    const existing = await this.prisma.payout.findUnique({ where: { orderId: order.id } });
    const { attempts, terminal: exhausted, nextRetryAt } = planRetry(existing?.attempts ?? 0);

    const data = {
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastError: reason.slice(0, 500),
      lastAttemptAt: new Date(),
      nextRetryAt,
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

    return { status: 'parked', reason };
  }

  /**
   * Stripe told us, after the fact, that a transfer failed or was reversed.
   *
   * The attempt arithmetic lives in `parkPayout` and nowhere else. The webhook
   * handler used to do its own `attempts: { increment: 1 }`, which could push a
   * payout past the cap — and the retry cron filters on `attempts < cap`, so
   * once past it the row was never looked at again by anything: not terminal,
   * not alerted, not retried, just silently owed.
   */
  async parkPayoutForFailedTransfer(orderId: string, reason: string): Promise<void> {
    const payout = await this.prisma.payout.findUnique({ where: { orderId } });
    if (!payout) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, number: true, inspectorId: true },
    });
    if (!order) return;

    // Free the transfer id first: `parkPayout` never touches it, and a retry
    // must be able to record a transfer of its own.
    await this.prisma.payout.update({
      where: { orderId },
      data: { stripeTransferId: null },
    });
    await this.parkPayout(
      { id: order.id, number: order.number, inspectorId: order.inspectorId ?? payout.inspectorId },
      payout.amountCents,
      reason,
    );
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
        attempts: { lt: MONEY_RETRY_MAX_ATTEMPTS },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
      select: { orderId: true },
    });

    let settled = 0;
    for (const { orderId } of due) {
      try {
        const outcome = await this.releasePayout(orderId);
        if (outcome.status === 'skipped') {
          // `releasePayout` has already cleared nextRetryAt, so this row leaves
          // the queue instead of being re-selected on every run for ever.
          this.logger.warn(`retryStuckPayouts: ${orderId} skipped — ${outcome.reason}`);
          continue;
        }
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
  // Refunds (F-14)
  // ============================================================

  /**
   * Give money back for an order. **Never throws.**
   *
   * This is the refund counterpart of `releasePayout`/`parkPayout`, and it
   * follows the same shape deliberately: the provider call is attempted, a
   * failure parks a visible row with a retry schedule, and the caller's own work
   * — the state transition — carries on regardless.
   *
   * That last part is the point. Refunds used to be issued by an unguarded
   * `stripe.createRefund` inside `cancel`, so:
   *   - cancelling an order whose card was never charged called Stripe against a
   *     PaymentIntent with no successful charge, got an `invalid_request_error`,
   *     and answered 500 — every single time, for the most ordinary cancellation
   *     there is;
   *   - a refund Stripe refused for any reason threw out of `resolveDispute`
   *     before the Dispute row was closed, leaving the dispute OPEN for ever.
   *
   * What happens is decided by the payment, not by the caller:
   *
   * | payment            | behaviour                                            |
   * |--------------------|------------------------------------------------------|
   * | none / pending / failed / cancelled | record a `refund_skipped` event, never call the provider |
   * | succeeded          | refund, upserted on (orderId, reason); park on failure |
   * | refunded           | skip — the money is already back                     |
   * | authorized         | release the hold, record `authorization_released`, write NO Refund row |
   *
   * A `Refund` row means money went back, or is still trying to. An uncaptured
   * authorization never left the customer's account, so recording one for it
   * would double-count every hold-and-release in the finance ledger.
   */
  async settleRefund(
    order: RefundableOrder,
    amountCents: number,
    reason: string,
  ): Promise<RefundOutcome> {
    try {
      return await this.settleRefundInner(order, amountCents, reason);
    } catch (err) {
      // Only reachable if the database itself misbehaves. Reported, not thrown:
      // the transition this refund belongs to must still happen.
      this.logger.error(
        `settleRefund: order ${order.id} (${reason}) failed unexpectedly: ${(err as Error).message}`,
      );
      return {
        status: 'error',
        amountCents: 0,
        refundId: null,
        stripeRefundId: null,
        reason,
        detail: (err as Error).message,
        attempts: 0,
        nextRetryAt: null,
      };
    }
  }

  private async settleRefundInner(
    order: RefundableOrder,
    amountCents: number,
    reason: string,
  ): Promise<RefundOutcome> {
    const existing = await this.findRefund(order.id, reason);
    if (existing?.status === 'succeeded') {
      // Idempotency: (orderId, reason) is unique, and this one already settled.
      return this.refundOutcome('refunded', amountCents, existing, 'already refunded');
    }

    if (amountCents <= 0) {
      await this.skipRefund(order, 0, reason, null, 'refund amount is zero');
      return this.skippedRefund(reason, 'refund amount is zero');
    }

    const payment = await this.prisma.payment.findUnique({ where: { orderId: order.id } });
    const paymentStatus = payment?.status ?? null;

    if (
      !payment ||
      paymentStatus === 'pending' ||
      paymentStatus === 'failed' ||
      paymentStatus === 'cancelled'
    ) {
      const detail = payment ? `payment is ${paymentStatus}` : 'order has no payment';
      await this.skipRefund(order, amountCents, reason, paymentStatus, detail);
      return this.skippedRefund(reason, detail);
    }

    if (paymentStatus === 'refunded') {
      const detail = 'payment is already refunded';
      await this.skipRefund(order, amountCents, reason, paymentStatus, detail);
      return this.skippedRefund(reason, detail);
    }

    if (paymentStatus === 'authorized') {
      return this.releaseAuthorization(order, payment, reason);
    }

    // `search_expired` can only ever mean a hold was released — the reason IS
    // "nobody accepted", and money is captured only when someone does. A
    // captured payment here means the caller is working from a stale read, and
    // refunding on it would take a paid job away from an inspector who accepted
    // it. `expireUnfilledSearches` claims the order atomically so this should be
    // unreachable; it is checked anyway because the failure is a customer
    // charged and refunded for an inspection that is going ahead.
    if (reason === 'search_expired') {
      const detail = `payment is ${paymentStatus} — the order was accepted after the search window closed`;
      this.logger.warn(`settleRefund: refusing search_expired refund on order ${order.id}: ${detail}`);
      await this.skipRefund(order, amountCents, reason, paymentStatus, detail);
      return this.skippedRefund(reason, detail);
    }

    // paymentStatus === 'succeeded' — the money really is out there.
    let stripeRefundId: string;
    if (this.stripe.configured) {
      if (!payment.stripePaymentIntentId) {
        // Recording a local refund id here would put "money returned" in the
        // ledger while Stripe never returned it. Park instead: the PaymentIntent
        // may still arrive on a later webhook.
        return this.parkRefund(order, amountCents, reason, 'payment has no Stripe PaymentIntent');
      }
      try {
        const refund = await this.stripe.createRefund(
          payment.stripePaymentIntentId,
          amountCents,
          reason,
          // `(orderId, reason)` is the refund's identity and is unique, so this
          // is stable across retries and identical for two callers racing on the
          // same row — which is the case that matters.
          `refund_${order.id}_${reason}`,
        );
        stripeRefundId = refund.id;
      } catch (err) {
        const failure = classifyStripeError(err);
        // `retryable: false` means the same request cannot succeed however often
        // it is repeated — a card error, a missing charge. Scheduling six
        // retries for it would only delay the operator's involvement by three
        // days, so it goes terminal now and stays visible in the queue.
        return this.parkRefund(order, amountCents, reason, failure.message, !failure.retryable);
      }
    } else {
      // MOCK mode: deterministic per (order, reason), so a retry updates its own
      // row rather than colliding on the unique stripeRefundId.
      stripeRefundId = `re_mock_${order.id}_${reason}`;
    }

    const data = {
      amountCents,
      status: 'succeeded',
      stripeRefundId,
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: null,
      lastAttemptAt: new Date(),
      nextRetryAt: null,
    };
    const row = await this.prisma.refund.upsert({
      where: { orderId_reason: { orderId: order.id, reason } },
      create: { orderId: order.id, reason, ...data },
      update: data,
    });

    // Marking the payment refunded also revokes whatever it entitled the buyer
    // to (PaymentsService.revokeEntitlementsFor). Idempotent.
    await this.payments.markPaymentRefunded(payment.id);
    await this.writeEvent(order.id, 'system', 'refund_issued', null, null, {
      reason,
      amountCents,
      stripeRefundId,
    });
    return this.refundOutcome('refunded', amountCents, row, null);
  }

  /**
   * Release an authorization hold. No Refund row is written — see the note on
   * `settleRefund`. The hold is only marked released in our ledger once the
   * provider confirms it, so a failure leaves the hold visible instead of
   * pretending the customer's money is free.
   */
  private async releaseAuthorization(
    order: RefundableOrder,
    payment: { id: string; stripePaymentIntentId: string | null },
    reason: string,
  ): Promise<RefundOutcome> {
    let released = true;
    let detail: string | null = null;

    if (this.stripe.configured && payment.stripePaymentIntentId) {
      if (canCancelAuthorization(this.stripe)) {
        try {
          await this.stripe.cancelPaymentIntent(payment.stripePaymentIntentId, payment.id, reason);
        } catch (err) {
          released = false;
          detail = classifyStripeError(err).message;
          this.logger.error(
            `settleRefund: could not release the hold on order ${order.id}: ${detail}`,
          );
          // A failed release writes no Refund row (correctly — no money moved),
          // so it cannot enter the refund retry queue and used to leave nothing
          // behind but this log line. Meanwhile the customer has been told the
          // hold is gone, and their funds stay frozen until Stripe expires the
          // authorization on its own. `reconcileStuckOrderPayments` retries it;
          // this is what makes it visible in the meantime.
          await this.notifyAdminsOfStrandedHold(order, detail);
        }
      } else {
        detail = 'provider cannot release holds — released locally only';
        this.logger.warn(`settleRefund: ${detail} (order ${order.id})`);
      }
    }

    if (released) {
      await this.prisma.payment
        .update({
          where: { id: payment.id },
          data: { status: 'cancelled', canceledAt: new Date() },
        })
        .catch(() => undefined);
    }

    await this.writeEvent(order.id, 'system', 'authorization_released', null, null, {
      reason,
      released,
      error: detail,
    });

    return {
      status: released ? 'released' : 'error',
      amountCents: 0,
      refundId: null,
      stripeRefundId: null,
      reason,
      detail,
      attempts: 0,
      nextRetryAt: null,
    };
  }

  /**
   * Record a refund the provider refused, schedule the next attempt, and tell
   * someone. Upserted on (orderId, reason), so a retried cancellation tops up
   * the existing row instead of minting a second one and refunding twice.
   */
  private async parkRefund(
    order: RefundableOrder,
    amountCents: number,
    reason: string,
    error: string,
    fatal = false,
  ): Promise<RefundOutcome> {
    const existing = await this.findRefund(order.id, reason);
    const {
      attempts,
      terminal: exhausted,
      nextRetryAt,
    } = planRetry(existing?.attempts ?? 0, { fatal });

    const data = {
      amountCents,
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastError: (fatal ? `permanent: ${error}` : error).slice(0, 500),
      lastAttemptAt: new Date(),
      nextRetryAt,
    };

    const row = await this.prisma.refund.upsert({
      where: { orderId_reason: { orderId: order.id, reason } },
      create: { orderId: order.id, reason, ...data },
      update: data,
    });

    this.logger.warn(
      `settleRefund: order ${order.id} refund ${data.status} (attempt ${attempts}): ${error}`,
    );
    await this.writeEvent(order.id, 'system', 'refund_failed', null, null, {
      reason,
      amountCents,
      attempts,
      terminal: exhausted,
      error,
    });

    // Alert on the FIRST parking and on going terminal — not on every retry.
    if (attempts === 1 || exhausted) {
      await this.notifyAdminsOfStuckRefund(order, amountCents, reason, error, attempts, exhausted);
    }

    return this.refundOutcome('parked', amountCents, row, error);
  }

  /** Record that no refund was owed, so the timeline explains the silence. */
  private async skipRefund(
    order: RefundableOrder,
    amountCents: number,
    reason: string,
    paymentStatus: string | null,
    detail: string,
  ): Promise<void> {
    this.logger.log(`settleRefund: order ${order.id} (${reason}) skipped — ${detail}`);
    await this.writeEvent(order.id, 'system', 'refund_skipped', null, null, {
      reason,
      amountCents,
      paymentStatus,
      detail,
    });
  }

  private async notifyAdminsOfStuckRefund(
    order: RefundableOrder,
    amountCents: number,
    reason: string,
    error: string,
    attempts: number,
    terminal: boolean,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify(admin.id, 'refund.failed', {
        orderId: order.id,
        orderNumber: order.number,
        amountCents,
        reason,
        error,
        attempts,
        terminal,
      });
    }
  }

  /**
   * A hold we could not release. Reuses `refund.failed` rather than minting a
   * type: to an operator this is the same task — money the customer should not
   * be without — and the payload says which it is. `amountCents: 0` is the
   * honest figure, because nothing was ever taken; what is stuck is the hold.
   */
  private async notifyAdminsOfStrandedHold(
    order: RefundableOrder,
    error: string,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    for (const admin of admins) {
      await this.notifications.notify(admin.id, 'refund.failed', {
        orderId: order.id,
        orderNumber: order.number,
        amountCents: 0,
        reason: 'authorization_release_failed',
        error,
        attempts: 1,
        terminal: false,
      });
    }
  }

  private findRefund(orderId: string, reason: string) {
    return this.prisma.refund.findUnique({
      where: { orderId_reason: { orderId, reason } },
    });
  }

  private refundOutcome(
    status: 'refunded' | 'parked',
    amountCents: number,
    row: {
      id: string;
      stripeRefundId: string | null;
      reason: string;
      attempts: number;
      nextRetryAt: Date | null;
    },
    detail: string | null,
  ): RefundOutcome {
    return {
      status,
      amountCents,
      refundId: row.id,
      stripeRefundId: row.stripeRefundId,
      reason: row.reason,
      detail,
      attempts: row.attempts,
      nextRetryAt: row.nextRetryAt,
    };
  }

  private skippedRefund(reason: string, detail: string): RefundOutcome {
    return {
      status: 'skipped',
      amountCents: 0,
      refundId: null,
      stripeRefundId: null,
      reason,
      detail,
      attempts: 0,
      nextRetryAt: null,
    };
  }

  /**
   * Retry refunds whose backoff has elapsed. Driven by a cron every ten minutes:
   * money owed back to a customer is not a cold queue item.
   *
   * A refund that turns out to be un-owed after all (the payment was refunded by
   * a chargeback in the meantime, or the order is gone) is terminated rather
   * than left to match this query on every run for ever.
   */
  async retryStuckRefunds(limit = 25): Promise<{ retried: number; settled: number }> {
    const due = await this.prisma.refund.findMany({
      where: {
        status: { in: ['pending', 'failed'] },
        nextRetryAt: { not: null, lte: new Date() },
        attempts: { lt: MONEY_RETRY_MAX_ATTEMPTS },
        orderId: { not: null },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
      select: { id: true, orderId: true, amountCents: true, reason: true },
    });

    let settled = 0;
    for (const refund of due) {
      try {
        const order = await this.prisma.order.findUnique({
          where: { id: refund.orderId as string },
          select: { id: true, number: true },
        });
        if (!order) {
          await this.terminateRefund(refund.id, 'order no longer exists');
          continue;
        }
        const outcome = await this.settleRefund(order, refund.amountCents, refund.reason);
        if (outcome.status === 'refunded') {
          settled += 1;
        } else if (outcome.status === 'skipped' || outcome.status === 'released') {
          await this.terminateRefund(refund.id, outcome.detail ?? 'nothing left to refund');
        }
      } catch (err) {
        // One bad row must not stop the batch.
        this.logger.error(`retryStuckRefunds: ${refund.id} threw: ${(err as Error).message}`);
      }
    }
    return { retried: due.length, settled };
  }

  /** Take a refund out of the retry queue, leaving the reason where it shows. */
  private async terminateRefund(refundId: string, reason: string): Promise<void> {
    await this.prisma.refund.update({
      where: { id: refundId },
      data: { nextRetryAt: null, lastError: `skipped: ${reason}`.slice(0, 500) },
    });
  }

  /**
   * Operator action: attempt a parked refund right now, ignoring the backoff and
   * the attempt cap.
   */
  async adminRetryRefund(refundId: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) {
      throw new NotFoundException({
        error: { code: 'refund_not_found', message: `No refund ${refundId}` },
      });
    }
    if (refund.status === 'succeeded') return refund;
    if (!refund.orderId) {
      // A VIN-history refund hangs off the payment, not an order, and its retry
      // path belongs to that module. Refusing is honest; guessing is not.
      throw new ConflictException({
        error: {
          code: 'refund_not_retryable',
          message: 'This refund is not attached to an order and must be settled in Stripe',
        },
      });
    }
    const order = await this.prisma.order.findUnique({
      where: { id: refund.orderId },
      select: { id: true, number: true },
    });
    if (!order) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'Order not found' },
      });
    }

    // Reset the counter so an operator retry is never refused by the cap, and so
    // the schedule restarts from the short end if it fails again.
    await this.prisma.refund.update({
      where: { id: refundId },
      data: { attempts: 0, nextRetryAt: new Date() },
    });
    await this.settleRefund(order, refund.amountCents, refund.reason);
    return this.prisma.refund.findUnique({ where: { id: refundId } });
  }

  /** Refund queue for the admin finance view. */
  async listRefunds(status?: string, page = 1, pageSize = 50) {
    const where = status ? { status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        orderBy: [{ nextRetryAt: 'asc' }, { createdAt: 'desc' }],
        skip: (Math.max(1, page) - 1) * pageSize,
        take: pageSize,
        include: { order: { select: { number: true, status: true } } },
      }),
      this.prisma.refund.count({ where }),
    ]);

    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.order?.number ?? null,
        orderStatus: r.order?.status ?? null,
        paymentId: r.paymentId,
        amountCents: r.amountCents,
        currency: 'EUR',
        reason: r.reason,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
        nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
        stripeRefundId: r.stripeRefundId,
        createdAt: r.createdAt.toISOString(),
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
  async attachReportByCode(
    orderId: string,
    inspectorId: string,
    code: string,
  ): Promise<{ orderId: string; status: OrderStatus; report: { id: string; code: string } }> {
    const order = await this.requireOrder(orderId);
    if (order.inspectorId !== inspectorId) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not the assigned inspector' },
      });
    }

    if (!ATTACHABLE_REPORT_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException({
        error: {
          code: 'order_not_attachable',
          message: `Cannot attach a report while order is ${order.status}`,
        },
      });
    }

    const existingOrderReport = await this.prisma.report.findUnique({
      where: { orderId },
      select: { id: true, code: true },
    });
    if (existingOrderReport) {
      throw new ConflictException({
        error: { code: 'order_report_exists', message: 'This order already has a report' },
      });
    }

    // `Report.code` is not `@unique` — only `@@index([code])`, with a PARTIAL
    // unique index covering the UUID-format codes. Legacy `CSP-######` codes
    // legitimately repeat across devices, so without an explicit order this
    // findFirst returned whichever row Postgres happened to hand back.
    // Newest-first, matching `PaymentsService.createPpvCheckout`.
    const report = await this.prisma.report.findFirst({
      where: { code, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        deviceId: true,
        userId: true,
        orderId: true,
        vin: true,
        make: true,
        model: true,
        qualityScore: true,
        // REQUIRED by the completeness gate below. Omit it and `reportData`
        // reads `undefined`, which the evaluator reports as "not evaluable" —
        // so the gate would refuse every report with "update your app" instead
        // of checking anything. A silent total bypass in the other direction is
        // one `if` away, which is why this comment exists.
        reportData: true,
      },
    });
    if (!report) {
      throw new NotFoundException({
        error: { code: 'report_not_found', message: 'Report not found' },
      });
    }
    if (report.orderId && report.orderId !== orderId) {
      throw new ConflictException({
        error: { code: 'report_already_used', message: 'This report is already linked to another order' },
      });
    }
    if (report.userId && report.userId !== inspectorId) {
      throw new ForbiddenException({
        error: { code: 'not_report_owner', message: 'This report belongs to another account' },
      });
    }
    if (!this.reportVehicleMatchesOrder(order, report)) {
      throw new ConflictException({
        error: {
          code: 'report_vehicle_mismatch',
          message: 'This report belongs to a different vehicle',
        },
      });
    }

    // The completeness gate runs AFTER the vehicle check on purpose: "this is
    // the wrong car" is the more useful thing to be told, and a right-car report
    // that is merely incomplete is the only one worth quoting a score at.
    await this.assertReportComplete(report.reportData, report.qualityScore);

    const deviceLink = await this.prisma.deviceLink.findUnique({
      where: { deviceId: report.deviceId },
      select: { userId: true },
    });
    if (deviceLink && deviceLink.userId !== inspectorId) {
      throw new ForbiddenException({
        error: { code: 'not_report_owner', message: 'This report belongs to another account' },
      });
    }

    const updatedReport = await this.prisma.report.update({
      where: { id: report.id },
      data: {
        orderId,
        userId: report.userId ?? inspectorId,
      },
      select: { id: true, code: true },
    });

    await this.submitReportForOrder(orderId);
    const updatedOrder = await this.requireOrder(orderId);

    return {
      orderId,
      status: updatedOrder.status,
      report: updatedReport,
    };
  }

  /**
   * The completeness gate: an order may only be closed with a report that
   * actually covers the vehicle. Throws, or returns silently.
   *
   * Since 2026-08-13 this checks WHICH elements are present, not a score. See
   * `src/reports/report-completeness.ts` for what "complete" means and why the
   * score stopped being the gate. The score is still stored and still shown; it
   * is simply no longer what decides.
   *
   * **`minReportQualityScore <= 0` still disables the gate entirely.** The
   * setting kept its name so no migration, seed, admin control or order DTO had
   * to change; its meaning is now a lever, not a threshold. That mismatch is
   * deliberate and is the reason for this paragraph: it is the only way to
   * unblock production without a release, and renaming it would cost that lever
   * a deploy at exactly the moment it is needed.
   *
   * The two refusals are separate codes on purpose. `report_quality_unknown`
   * means "your app is too old, update it" — a report with no structured
   * payload cannot be judged, and that is not the inspector's fault.
   * `report_incomplete` means "the inspection is missing these specific things,
   * go back to the car". Collapsing them into one accuses an inspector of poor
   * work when the real problem is a stale build, and they would keep
   * re-uploading the same perfectly good report.
   *
   * The details ride on the exception beside `error`, where
   * `AllExceptionsFilter` passes them through to the wire — a bare code the
   * client cannot turn into "3 exterior angles and 1 wheel" is a code the user
   * cannot act on.
   */
  async assertReportComplete(
    reportData: unknown,
    qualityScore: number | null | undefined,
  ): Promise<void> {
    const minQualityScore = await this.settings.getNumber('minReportQualityScore');
    if (minQualityScore <= 0) return;

    const result = evaluateCompleteness(reportData);

    if (!result.evaluable) {
      throw new ConflictException({
        error: {
          code: 'report_quality_unknown',
          message:
            'This report carries no structured inspection data. Update the CarSalePro app and re-sync the report.',
        },
        qualityScore: qualityScore ?? null,
        minQualityScore,
      });
    }

    if (!result.complete) {
      const count = countMissing(result.missing);
      throw new ConflictException({
        error: {
          code: 'report_incomplete',
          message: `This inspection is missing ${count} required element(s). Every exterior angle, paint panel, calibration reference and wheel needs its data and its photo.`,
        },
        missing: result.missing,
        exteriorAngleCount: result.exteriorAngleCount,
        qualityScore: qualityScore ?? null,
        minQualityScore,
      });
    }
  }

  private reportVehicleMatchesOrder(
    order: Pick<Order, 'vin' | 'make' | 'model'>,
    report: { vin: string | null; make: string | null; model: string | null },
  ): boolean {
    const normalize = (value: string | null | undefined) =>
      value?.trim().toUpperCase().replace(/\s+/g, ' ') ?? null;

    const orderVin = normalize(order.vin);
    const reportVin = normalize(report.vin);
    if (orderVin && reportVin) return orderVin === reportVin;

    const orderMake = normalize(order.make);
    const reportMake = normalize(report.make);
    const orderModel = normalize(order.model);
    const reportModel = normalize(report.model);

    if (orderMake && reportMake && orderMake !== reportMake) return false;
    if (orderModel && reportModel && orderModel !== reportModel) return false;
    return true;
  }

  async submitReportForOrder(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;

    if (!ATTACHABLE_REPORT_ORDER_STATUSES.includes(order.status)) return false;

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

  /** Close a dispute row. Never throws: bookkeeping must not reopen a decision. */
  private async closeDispute(
    orderId: string,
    status: 'RESOLVED_CUSTOMER' | 'RESOLVED_INSPECTOR',
    resolution: string,
    adminId: string,
    at: Date,
  ): Promise<void> {
    try {
      await this.prisma.dispute.update({
        where: { orderId },
        data: { status, resolution, resolvedBy: adminId, resolvedAt: at },
      });
    } catch (err) {
      this.logger.error(
        `Failed to close the dispute on order ${orderId}: ${(err as Error).message}`,
      );
    }
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
      // The split rides on the row because the inspector's list is the FIRST
      // place a job is priced for them, and `totalCents` there is the
      // customer's number — it overstates what they earn by the whole
      // commission. Sent to both sides; each renders the figure that is theirs.
      platformFeeCents: o.platformFeeCents,
      inspectorShareCents: o.inspectorShareCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    };
  }
}

/**
 * Map a {@link RefundOutcome} onto the word the client shows the customer.
 *
 * `error` reports 'none' rather than inventing a state: the customer is not
 * owed anything we know how to promise, and the order's own
 * `authorization_released` / `refund_failed` event carries what actually
 * happened for whoever has to fix it.
 */
function refundModeOf(status: RefundOutcome['status']): RefundMode {
  switch (status) {
    case 'refunded':
      return 'refunded';
    case 'parked':
      return 'refund_pending';
    case 'released':
      return 'authorization_released';
    default:
      return 'none';
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
    /** One direction, derived from the stored billed distance. */
    distanceKm: number;
    /** What the per-km rate was applied to. Optional so the website can lag. */
    billedDistanceKm?: number;
    /** One direction, after the free radius came off. */
    chargeableDistanceKm?: number;
    returnTripFactor?: number;
    freeRadiusKm?: number;
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
  /** The inspector's channels. Non-null only for the customer (or an admin), from ASSIGNED on. */
  inspectorContact: PartyContact | null;
  /**
   * The customer's channels. Non-null only for the ASSIGNED inspector (or an
   * admin) — optional in the type so the website can deploy in either order.
   */
  customerContact?: PartyContact | null;
  report: { id: string; code: string; qualityScore: number | null } | null;
  /**
   * Where the customer's money is. Optional in the type (never absent in
   * practice) so the website and the API can deploy in either order — neither
   * repo waits on the other.
   */
  payment?: {
    state: OrderPaymentState;
    amountCents: number;
    authorizedAt: string | null;
    capturedAt: string | null;
    releasedAt: string | null;
  } | null;
  /** The inspector search window. Null for pre-manual-capture orders. */
  search?: { deadlineAt: string; expiredAt: string | null } | null;
  /** The completeness gate. Present in EVERY status — see `getDetail`. */
  reportRequirement?: {
    minQualityScore: number;
    currentQualityScore: number | null;
    /**
     * The four counts below are OPTIONAL so the website can deploy before or
     * after the backend without either half breaking — the panel falls back to
     * its previous rendering when they are absent. That independence is a
     * tested property of this block, not an accident.
     */
    gateEnabled?: boolean;
    exteriorAngles?: number;
    thicknessPanels?: number;
    calibrationPhotos?: number;
    wheels?: number;
  } | null;
  autoApproveAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  /** Present when the current inspector has a pending/accepted offer. */
  offer?: { id: string; status: string } | null;
  offerId?: string | null;
  events: Array<{
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    actor: string;
    createdAt: string;
  }>;
}
