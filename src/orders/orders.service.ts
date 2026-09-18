import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Order, OrderStatus, Payment, Prisma, Role } from '@prisma/client';
import { ADMIN_ROLES, isAdminRole } from '../auth/roles';
import { COUNTER_OFFER_PAYMENT_PURPOSE } from './counter-offer-rules';
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
  OrderSort,
  OrderTab,
  QuoteOrderDto,
} from './dto/order.dto';
import { ATTACHABLE_REPORT_ORDER_STATUSES, canTransition } from './order-state-machine';
import {
  PriceBreakdown,
  PricingTariff,
  computePrice,
  describeStoredFare,
} from './order-pricing';
import { effectiveBaseFeeCents } from './inspector-base-fee';
import { RegionalOverrides, exceedsCap, resolveTariff } from './tariff-resolution';
import { ADMIN_DECISION_EVENT, AdminDecision } from './admin-decision';
import { MONEY_RETRY_MAX_ATTEMPTS, planRetry } from './retry-schedule';
import { CounterOfferQueueService } from './counter-offer-queue.service';
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

/**
 * What a transition knows about ITSELF that its from/to pair cannot say.
 *
 * Only the notification matrix reads it. `CANCELLED` is reached by several
 * different events — the customer cancelling, a capture failing, an inspector
 * handing the job back — and they owe the reader different letters.
 */
export interface TransitionContext {
  declinedByInspector?: { reason: string; refundCents: number };
}

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

/**
 * How many inspectors a quote looks at (DEN-352).
 *
 * It was three, which was the size the "who is near you" list needs. The quote
 * now takes the lowest base fee of the set, and the lowest of three neighbours
 * is still largely a lottery - a wider set makes the price describe the area
 * rather than one person. The query is a bounded PostGIS KNN scan on an index,
 * so the extra rows cost effectively nothing, and the customer-facing list is
 * sliced back to three where it is built.
 */
const QUOTE_CANDIDATE_LIMIT = 10;

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
    private readonly counterOfferQueue: CounterOfferQueueService,
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
  /**
   * The global tariff, without the routing settings the quote also reads.
   *
   * Dispatch needs the tariff and nothing else, and re-pricing a candidate has
   * to use the SAME numbers the quote used or the two would disagree about what
   * an order costs.
   */
  private async loadGlobalTariff(): Promise<PricingTariff> {
    const [
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      surgeMultiplier,
      returnTripFactor,
      freeRadiusKm,
    ] = await Promise.all([
      this.settings.getCents('orderBaseFeeEur'),
      this.settings.getCents('orderRatePerKmEur'),
      this.settings.getCents('orderRatePerMinuteEur'),
      this.settings.getCents('orderMinimumFareEur'),
      this.settings.getNumber('platformFeePercent'),
      this.settings.getNumber('orderSurgeMultiplier'),
      this.settings.getNumber('orderReturnTripFactor'),
      this.settings.getNumber('orderFreeRadiusKm'),
    ]);
    return {
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      surgeMultiplier,
      returnTripFactor,
      freeRadiusKm,
    };
  }

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
      this.settings.getNumber('orderDetourFactor'),
      this.settings.getNumber('orderReturnTripFactor'),
      this.settings.getNumber('orderFreeRadiusKm'),
      this.settings.getNumber('orderCapKm'),
      this.settings.getNumber('orderRoutingCacheHours'),
    ]);

    const globalTariff: PricingTariff = {
      baseFeeCents,
      ratePerKmCents,
      ratePerMinuteCents,
      minimumFareCents,
      platformFeePercent,
      surgeMultiplier,
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
      limit: QUOTE_CANDIDATE_LIMIT,
      excludeCustomerId: customerId ?? null,
    });

    if (candidates.length === 0) {
      return {
        available: false,
        refusal: 'no_coverage',
        countryCode,
        candidates: [],
        routingSource: 'haversine',
        price: computePrice({ distanceKm: 0, durationMin: 0, tariff }),
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
        price: computePrice({ distanceKm: 0, durationMin: 0, tariff }),
      };
    }

    return {
      available: true,
      countryCode,
      nearest,
      candidates,
      routingSource: route.source,
      /*
       * DEN-213. Priced on an inspector's own base fee - since DEN-352, on the
       * LOWEST base fee in the candidate set rather than the nearest one's.
       *
       * The customer is shown ONE price and is never charged more than it. The
       * order that follows authorises exactly this total, and dispatch will not
       * offer the job to anybody who costs more (`dispatch`), so the number on
       * the screen is a ceiling as well as a quote - which is why WHOSE base
       * fee it is matters so much. Taking the nearest inspector's let one
       * expensive neighbour set the price of the whole area: the quote was the
       * highest rate in reach, the customer left at the order form, and the
       * cheaper inspectors three streets further away were never offered the
       * work at all.
       *
       * The route stays the nearest inspector's. Pricing each candidate would
       * cost a routing request each to change a figure the base fee dominates,
       * and the distance of the person who actually takes the job is not known
       * at quote time anyway.
       *
       * The trade is deliberate: a quote can now land below what the inspector
       * offering that base fee would accept for this drive. Then nobody takes
       * it at the tariff and the order goes to the counter-offer queue
       * (DEN-350/DEN-351), where the customer is asked a real price WITH a
       * reason - which is the right place for that conversation, and a far
       * better one than an order form nobody fills in.
       */
      price: computePrice({
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        tariff: await this.cheapestCandidateTariff(tariff, candidates),
      }),
    };
  }

  /**
   * The tariff for a quote: the LOWEST base fee among the candidates (DEN-352).
   *
   * One query for the whole set rather than one per candidate, and a candidate
   * with no stated base fee counts as the platform base - the same fallback
   * {@link tariffForInspector} applies, so a pool that states nothing prices
   * exactly as it did before DEN-213.
   */
  private async cheapestCandidateTariff(
    tariff: PricingTariff,
    candidates: Array<{ userId: string }>,
  ): Promise<PricingTariff> {
    const profiles = await this.prisma.inspectorProfile.findMany({
      where: { userId: { in: candidates.map((c) => c.userId) } },
      select: { baseFeeCents: true },
    });
    // NOT seeded with the platform base: that would floor the answer at it, and
    // a pool where everybody charges more than the platform base would be
    // quoted a price none of them accepts.
    const stated = profiles.map((p) => effectiveBaseFeeCents(p.baseFeeCents, tariff.baseFeeCents));
    const baseFeeCents = stated.length ? Math.min(...stated) : tariff.baseFeeCents;
    return baseFeeCents === tariff.baseFeeCents ? tariff : { ...tariff, baseFeeCents };
  }

  /**
   * The tariff as this inspector prices it - their base fee, held inside the
   * platform's bounds, over the regional tariff for everything else.
   *
   * A profile that says nothing is priced on the platform base, which is what
   * every profile said before DEN-213.
   */
  private async tariffForInspector(
    tariff: PricingTariff,
    inspectorUserId: string,
  ): Promise<PricingTariff> {
    const profile = await this.prisma.inspectorProfile.findUnique({
      where: { userId: inspectorUserId },
      select: { baseFeeCents: true },
    });
    const baseFeeCents = effectiveBaseFeeCents(profile?.baseFeeCents, tariff.baseFeeCents);
    return baseFeeCents === tariff.baseFeeCents ? tariff : { ...tariff, baseFeeCents };
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
    const priced = await this.priceQuote(dto.lat, dto.lng, userId);

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
    // also re-reads the surge lever, so a stale quote cannot lock in
    // yesterday's multiplier.
    // `userId` is passed so the customer is excluded from their own candidate
    // set here too — otherwise a self-dealing account would pay for an order
    // that dispatch could never fill.
    const priced = await this.priceQuote(dto.lat, dto.lng, userId);
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
   * The order's LIVE payment — the one row that describes where its money is
   * now (DEN-344).
   *
   * `Payment.orderId` stopped being unique when counter-offers arrived:
   * accepting a price above the authorization replaces the PaymentIntent, and
   * the replaced row stays behind as the record of a hold that existed and was
   * released. Every reader of "the order's payment" wants the live one, so the
   * lookup lives here rather than being spelled out at six call sites — each of
   * which would otherwise be one forgotten `supersededAt` away from cancelling
   * or capturing an authorization that Stripe has already let go.
   *
   * A row that HOLDS money wins over a newer one that does not. During a
   * counter-offer payment the order carries both: the original authorization,
   * which is still the order's money, and a pending replacement the customer
   * has not confirmed. Answering with the pending one would have the expiry
   * sweep "release" a hold that does not exist and leave the real one standing.
   *
   * `payment_active_order_unique` guarantees there is at most one holding row,
   * so the ordering only decides between rows that hold nothing.
   */
  async activePaymentForOrder(orderId: string): Promise<Payment | null> {
    const holding = await this.prisma.payment.findFirst({
      where: { orderId, supersededAt: null, status: { in: ['authorized', 'succeeded'] } },
    });
    if (holding) return holding;
    return this.prisma.payment.findFirst({
      where: { orderId, supersededAt: null },
      orderBy: { createdAt: 'desc' },
    });
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
  async captureOrderPayment(orderId: string, amountCents?: number): Promise<CaptureOutcome> {
    const payment = await this.activePaymentForOrder(orderId);
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
      /*
       * `amountCents` is the offer's own price when the accepting inspector
       * charges less than the quote (DEN-213). Stripe can capture LESS than an
       * authorisation and never more, which is why dispatch refuses to offer a
       * job above the authorised total in the first place.
       *
       * Undefined captures the whole hold, which is every path except an
       * inspector priced below the quote.
       */
      await this.stripe.capturePaymentIntent(
        payment.stripePaymentIntentId,
        payment.id,
        amountCents,
      );
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
    // DEN-290: the customer no longer chooses a time, so a new order stores
    // NULL. A website deployed before that change still sends one, and it is
    // kept, so that website can still show the date it asked for.
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
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
        ${scheduledAt}, ${countryCode},
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
   * How far down the candidate list dispatch may look for somebody the order
   * can pay for (DEN-213).
   *
   * It used to ask for exactly one. With inspector-set base fees the nearest
   * candidate may cost more than the customer authorised, and stopping there
   * would mark the order UNASSIGNED while three affordable inspectors stood a
   * few kilometres further away. Five, not fifty: each one costs a profile read,
   * and an order that cannot be filled by the five nearest is an order the
   * search window should be allowed to expire rather than one to grind through
   * the whole country for.
   */
  private static readonly DISPATCH_CANDIDATE_LIMIT = 5;

  /**
   * True while a customer is paying for a counter-offer on this order
   * (DEN-344).
   *
   * The payment window is the one moment two people could buy the same order:
   * the customer is entering a card for a price ABOVE the hold, which takes a
   * 3DS round trip, and for those minutes the ordinary pool must not be able to
   * take the job underneath them. The alternative — letting dispatch run and
   * sorting out the loser afterwards — means either two holds on one order or a
   * customer told "accepted" and then "taken", after they paid.
   *
   * Read from the counter-offer row rather than from a flag on the order, so a
   * process that dies mid-payment cannot leave a lock nothing clears: the
   * deadline is in the row, and a stale ACCEPTING is simply not a lock any more.
   */
  private async counterOfferPaymentLock(orderId: string): Promise<boolean> {
    const active = await this.prisma.orderCounterOffer.findFirst({
      where: { orderId, status: 'ACCEPTING', acceptingUntil: { gt: new Date() } },
      select: { id: true },
    });
    return active !== null;
  }

  /**
   * Offer the order to the nearest eligible inspector not already offered or
   * declined for it. Creates a PENDING OrderOffer (expiresAt = now +
   * offerTimeoutMinutes). If nobody is left → UNASSIGNED.
   */
  async dispatch(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.UNASSIGNED) {
      // Only dispatch when waiting for assignment.
      return false;
    }
    // Somebody is paying for this order right now (DEN-344). Answering `false`
    // rather than waiting is correct: the sweep re-dispatches when the payment
    // window closes, and an offer sent now would be an offer the winner of the
    // payment immediately invalidates.
    if (await this.counterOfferPaymentLock(orderId)) return false;

    const { lat, lng } = await this.readOrderLatLng(orderId);
    const radiusKm = await this.settings.getNumber('expertSearchRadiusKm');

    /*
     * Who is out, and for how long (DEN-326).
     *
     * It used to be "everybody ever offered this order", which is what made
     * UNASSIGNED a dead end: once the pool was exhausted there was nobody left
     * to ask, for ever. The exclusion is now read per status.
     *
     *  - DECLINED — out for ever, in every round. The inspector said no with
     *    their hands. Sending the same job again makes the platform a nuisance,
     *    and the end of that is a person who turns push messages off.
     *  - PENDING / ACCEPTED — out, as before. Somebody is holding it.
     *  - EXPIRED — out for THIS round only. Silence is not a refusal: the
     *    inspector was driving, or asleep, or the offer arrived at 03:00.
     *
     * Reading the round rather than deleting the rows keeps the history: every
     * offer ever made is still on the order, and `round` says which pass it
     * belonged to.
     */
    const prior = await this.prisma.orderOffer.findMany({
      where: {
        orderId,
        OR: [
          { status: { in: ['DECLINED', 'PENDING', 'ACCEPTED'] } },
          { status: 'EXPIRED', round: order.dispatchRound },
        ],
      },
      select: { inspectorId: true },
    });
    const excluded = prior.map((o) => o.inspectorId);

    /*
     * DEN-213. More than one candidate, because some of them may now be
     * unaffordable.
     *
     * Dispatch still offers the job to ONE inspector at a time, but an
     * inspector whose base fee prices the job above what the customer
     * authorised cannot be that one - the money is already held, and there is
     * no second card to ask. So the search returns several and this walks down
     * them until one fits.
     */
    const candidates = await this.geo.findNearestInspectors({
      lat,
      lng,
      radiusKm,
      limit: OrdersService.DISPATCH_CANDIDATE_LIMIT,
      excludeUserIds: excluded,
      // F-13: never offer the order to the account that placed it.
      excludeCustomerId: order.customerId,
    });

    const affordable = await this.firstAffordableCandidate(order, candidates);

    if (!affordable) {
      if (order.status !== OrderStatus.UNASSIGNED) {
        await this.transition(orderId, OrderStatus.UNASSIGNED, 'system');
      }
      return false;
    }

    const { candidate: nearest, price } = affordable;
    const timeoutMinutes = await this.settings.getNumber('offerTimeoutMinutes');
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60_000);
    await this.prisma.orderOffer.create({
      data: {
        orderId,
        inspectorId: nearest.userId,
        status: 'PENDING',
        expiresAt,
        round: order.dispatchRound,
        // How far THIS inspector is, which is not what the order was priced on
        // once dispatch has walked past the first candidate.
        straightLineKm: new Prisma.Decimal(nearest.distanceKm.toFixed(2)),
        /*
         * The price is frozen HERE, when the offer is sent - the client's
         * decision, and the right one: an inspector who could raise their base
         * while looking at a live offer would be pricing a job they have
         * already seen.
         */
        priceCents: price.totalCents,
        platformFeeCents: price.platformFeeCents,
        inspectorShareCents: price.inspectorShareCents,
      },
    });
    await this.writeEvent(orderId, 'system', 'offer_sent', null, null, {
      inspectorId: nearest.userId,
      expiresAt: expiresAt.toISOString(),
      round: order.dispatchRound,
    });
    // E11: notify the inspector an offer was sent to them (non-throwing).
    await this.notifications.notify(nearest.userId, 'offer.received', {
      orderId,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      // What THIS offer pays, which is not the order's figure once an
      // inspector prices themselves below the quote.
      inspectorShareCents: price.inspectorShareCents,
      expiresAt: expiresAt.toISOString(),
    });
    return true;
  }

  /**
   * The first candidate this order can actually pay for, with the price it
   * would be offered at.
   *
   * The ceiling is the order's own total: that is the sum authorised on the
   * customer's card, and Stripe can capture LESS than an authorisation but
   * never more. An inspector who costs more is skipped rather than offered a
   * job that could not be paid for - and rather than quietly paid the lower
   * figure, which would be the platform pocketing the difference.
   *
   * A candidate priced BELOW the quote is offered at their own lower price and
   * the customer is charged that, so the quote is a ceiling and not a target.
   */
  private async firstAffordableCandidate(
    order: Order,
    candidates: Array<{ userId: string; distanceKm: number }>,
  ): Promise<{ candidate: { userId: string; distanceKm: number }; price: PriceBreakdown } | null> {
    if (candidates.length === 0) return null;

    const base = await this.tariffForStoredOrder(order);

    for (const candidate of candidates) {
      const tariff = await this.tariffForInspector(base.tariff, candidate.userId);
      const price = computePrice({
        distanceKm: base.distanceKm,
        durationMin: base.durationMin,
        tariff,
      });
      if (price.totalCents <= order.totalCents) return { candidate, price };
    }
    return null;
  }

  /**
   * What this order would have cost if THIS inspector had been the nearest one
   * (DEN-344) — the fair price a counter-offer ceiling is built on.
   *
   * The order's own total is priced on the distance to the nearest candidate
   * and is the same figure for all five; the whole reason a counter-offer
   * exists is that the inspector who is willing to go may be much further away
   * and is currently asked to drive it for somebody else's kilometres. So this
   * re-prices the order on their distance and their own base fee.
   *
   * Two deliberate approximations, both in the direction of costing nothing:
   *
   *  - The distance is the STRAIGHT LINE times `orderDetourFactor`, the same
   *    fallback the quote uses when routing is unavailable. Routing here would
   *    cost a provider request every time an inspector opens the form.
   *  - The minutes are the order's own, scaled by how much further this
   *    inspector is. There is no measured duration for a trip nobody routed,
   *    and holding the minutes fixed would price a 40 km drive with the time of
   *    a 12 km one.
   */
  async fairPriceForInspector(
    order: Order,
    inspectorUserId: string,
    straightLineKm: number,
  ): Promise<PriceBreakdown> {
    const base = await this.tariffForStoredOrder(order);
    const tariff = await this.tariffForInspector(base.tariff, inspectorUserId);
    const detourFactor = await this.settings.getNumber('orderDetourFactor');
    const distanceKm = Math.max(0, straightLineKm) * Math.max(1, detourFactor);
    const durationMin =
      base.distanceKm > 0
        ? Math.round(base.durationMin * (distanceKm / base.distanceKm))
        : base.durationMin;
    return computePrice({ distanceKm, durationMin, tariff });
  }

  /**
   * The tariff and the trip an order was priced on, recovered from the order
   * row itself.
   *
   * Recovered rather than re-measured: routing the trip again would cost a
   * provider request per dispatch attempt and could answer differently from the
   * number the customer was charged on. `describeStoredFare` inverts the
   * return-trip factor and the free radius that the stored columns already
   * carry, and the region comes from the order's own `countryCode`, so
   * re-pricing an unchanged inspector reproduces the order's own total exactly
   * - which is what the e2e suite asserts.
   */
  private async tariffForStoredOrder(order: {
    countryCode: string;
    baseFeeCents: number;
    distanceKm: Prisma.Decimal;
    returnTripFactor: Prisma.Decimal;
    freeRadiusKm: Prisma.Decimal;
    durationMin: number | null;
  }): Promise<{ tariff: PricingTariff; distanceKm: number; durationMin: number }> {
    const globalTariff = await this.loadGlobalTariff();
    const region = await this.loadRegionalOverrides(order.countryCode);
    const resolved = resolveTariff(
      globalTariff,
      Number(order.freeRadiusKm),
      region.zone,
      region.country,
    );

    const fare = describeStoredFare({
      billedDistanceKm: Number(order.distanceKm),
      billedDurationMin: order.durationMin,
      returnTripFactor: Number(order.returnTripFactor),
      freeRadiusKm: Number(order.freeRadiusKm),
    });

    return {
      tariff: resolved.tariff,
      distanceKm: fare.distanceKm ?? 0,
      durationMin: fare.durationMin ?? 0,
    };
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

    // DEN-344: a customer is paying for a counter-offer on this order. Their
    // money is in flight at a price this offer knows nothing about, so the pool
    // waits. The inspector keeps their PENDING offer and can accept the moment
    // the payment window closes without a winner.
    if (await this.counterOfferPaymentLock(order.id)) {
      throw new ConflictException({
        error: {
          code: 'order_locked_by_counter_offer',
          message: 'The customer is paying for another expert\u2019s price. Try again in a few minutes.',
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

    /*
     * DEN-213. The customer is charged what THIS offer was made at.
     *
     * The offer's price is frozen when it is sent and can only be lower than
     * the order's total, because dispatch never offers a job above what was
     * authorised. So the customer pays the quote or less, and the difference on
     * a cheaper inspector goes back to the customer rather than to the
     * platform - keeping it would be the platform quietly pocketing a spread
     * the customer was never told about.
     */
    const chargeCents = Math.min(offer.priceCents ?? order.totalCents, order.totalCents);
    const capture = await this.captureOrderPayment(
      order.id,
      chargeCents === order.totalCents ? undefined : chargeCents,
    );

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

    /*
     * The order's money now describes what was actually taken, not what was
     * quoted. Left alone, the invoice, the payout and the admin finance pages
     * would all report the higher figure while the customer's statement showed
     * the lower one.
     */
    if (chargeCents !== order.totalCents) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          totalCents: chargeCents,
          platformFeeCents: offer.platformFeeCents ?? order.platformFeeCents,
          inspectorShareCents: offer.inspectorShareCents ?? order.inspectorShareCents,
        },
      });
      await this.writeEvent(order.id, userId, 'price_lowered_by_inspector', null, null, {
        offerId,
        quotedCents: order.totalCents,
        chargedCents: chargeCents,
      });
    }

    await this.settleCounterOffersOnAssignment(order.id, userId);
    await this.transition(order.id, OrderStatus.ASSIGNED, userId);
    return { orderId: order.id, status: OrderStatus.ASSIGNED };
  }

  /**
   * The customer's replacement hold is in place: finish the counter-offer
   * (DEN-344).
   *
   * This is the second half of a two-authorization handover, and the ORDER of
   * what it does is the whole safety argument. The new hold already exists when
   * this runs - it is what the `amount_capturable_updated` webhook reports - so
   * the old one is released only now, when its release can no longer leave the
   * order with no money at all. The reverse order reads tidier and loses a
   * customer's order to any declined card.
   *
   * Idempotent in every half: Stripe redelivers, and the reconciler calls the
   * same path when the webhook was lost.
   */
  async finalizeCounterOfferPayment(paymentId: string, orderId: string): Promise<void> {
    const counter = await this.prisma.orderCounterOffer.findFirst({
      where: { orderId, status: 'ACCEPTING' },
    });
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!counter || !order) return;
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.UNASSIGNED) {
      // Somebody reached ASSIGNED another way. The payment lock is supposed to
      // make this impossible, so the hold is given back rather than kept.
      await this.releaseSupersededHold(paymentId, orderId, 'counter_offer_lost');
      return;
    }

    const now = new Date();

    // Claim the order for the inspector who named the price, on the same
    // conditional update `acceptOffer` uses. The payment lock already keeps the
    // pool out; this is the guard for everything that does not consult it.
    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: [OrderStatus.PAID, OrderStatus.UNASSIGNED] },
        inspectorId: null,
      },
      data: { inspectorId: counter.inspectorId },
    });
    if (claim.count === 0) {
      await this.releaseSupersededHold(paymentId, orderId, 'counter_offer_lost');
      return;
    }

    // The OLD authorization goes back now, and only now. It is a release and
    // never a refund: nothing was ever taken from it, so a Refund row here would
    // double-count the hold in the finance ledger.
    //
    // This runs BEFORE the replacement row is marked authorized, and the order
    // matters twice over. At Stripe the new hold already exists - the webhook
    // reporting it is what called this method - so the customer is never
    // without cover. In our ledger `payment_active_order_unique` allows exactly
    // one row that holds money, so the old row has to stop holding before the
    // new one starts.
    await this.releaseReplacedHold(orderId, paymentId);

    await this.prisma.payment
      .updateMany({
        where: { id: paymentId, status: { in: ['pending', 'failed'] } },
        data: { status: 'authorized', authorizedAt: now },
      })
      .catch(() => undefined);

    const capture = await this.captureOrderPayment(orderId);
    if (capture.status !== 'captured' && capture.status !== 'already_captured') {
      // The replacement hold cannot be taken. Undo the claim and leave the
      // counter-offer for the sweep, which returns it to the customer's screen
      // if its window still has time. The old hold is already gone, so the
      // order carries no money - `searchExpiresAt` still ends it.
      await this.releaseOrderClaim(orderId, counter.inspectorId);
      await this.writeEvent(orderId, counter.inspectorId, 'counter_offer_capture_failed', null, null, {
        counterOfferId: counter.id,
        detail: capture.detail ?? null,
      });
      return;
    }

    await this.prisma.$transaction([
      this.prisma.orderCounterOffer.updateMany({
        where: { id: counter.id, status: 'ACCEPTING' },
        data: { status: 'ACCEPTED', acceptingUntil: null, respondedAt: now },
      }),
      // The order's money must describe the sale that happened. The contract,
      // the invoice and the payout all read these columns, and the customer's
      // statement now shows the counter-offer's figure.
      this.prisma.order.update({
        where: { id: orderId },
        data: {
          totalCents: counter.priceCents,
          platformFeeCents: counter.platformFeeCents,
          inspectorShareCents: counter.inspectorShareCents,
        },
      }),
      // Every ordinary offer still waiting is dead: the order is sold.
      this.prisma.orderOffer.updateMany({
        where: { orderId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      }),
    ]);

    await this.writeEvent(orderId, counter.inspectorId, 'counter_offer_accepted', null, null, {
      counterOfferId: counter.id,
      quotedCents: order.totalCents,
      chargedCents: counter.priceCents,
    });

    await this.settleCounterOffersOnAssignment(orderId, counter.inspectorId);
    await this.transition(orderId, OrderStatus.ASSIGNED, counter.inspectorId);

    await this.notifications.notify(counter.inspectorId, 'counter_offer.accepted', {
      orderId,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      priceCents: counter.priceCents,
      inspectorShareCents: counter.inspectorShareCents,
    });
  }

  /**
   * The customer did not pay for the counter-offer they accepted (DEN-344):
   * the card was refused, they closed the page, or the payment window ran out.
   *
   * Everything goes back to where it was. The original hold was never touched -
   * it is released only once the replacement holds money - so the order still
   * has its money and its place in the search. The counter-offer returns to the
   * customer's screen for whatever is left of its own window, because a
   * mistyped card is not a refusal.
   */
  async abandonCounterOfferPayment(orderId: string, detail: string): Promise<void> {
    const counter = await this.prisma.orderCounterOffer.findFirst({
      where: { orderId, status: 'ACCEPTING' },
    });
    if (!counter) return;

    const now = new Date();
    const stillOpen = counter.expiresAt > now;
    await this.prisma.orderCounterOffer.updateMany({
      where: { id: counter.id, status: 'ACCEPTING' },
      data: {
        status: stillOpen ? 'PENDING' : 'EXPIRED',
        acceptingUntil: null,
        // It keeps `presentedAt` when it goes back to PENDING: the customer is
        // still looking at this price, and re-queueing it would put a dearer
        // one in front of the one they just tried to pay for. When it expires,
        // the screen is free and the queue moves on below.
        ...(stillOpen ? {} : { respondedAt: now }),
      },
    });

    // The half-made payment row must stop being the order's live one, or every
    // later reader - capture, release, the admin finance page - would find a
    // PaymentIntent that holds nothing.
    await this.prisma.payment.updateMany({
      where: { orderId, purpose: COUNTER_OFFER_PAYMENT_PURPOSE, supersededAt: null },
      data: { status: 'failed', supersededAt: now },
    });

    await this.writeEvent(orderId, counter.inspectorId, 'counter_offer_payment_abandoned', null, null, {
      counterOfferId: counter.id,
      detail,
      returnedToCustomer: stillOpen,
    });

    if (!stillOpen) {
      await this.notifyCounterOfferExpired(counter.id);
      // The screen this offer held is free, so the next-cheapest price in the
      // queue takes it (DEN-350). Only on the expired branch: a returned offer
      // is still the one the customer is looking at.
      await this.counterOfferQueue.promoteQuietly(orderId);
    }
    // The pool was held out while the customer paid. Ask again at once rather
    // than waiting for the next round: those minutes came out of the search.
    await this.dispatch(orderId);
  }

  /**
   * Release the hold the counter-offer replaced, once the replacement is live.
   *
   * The replaced row keeps its history and stops being the order's live payment
   * in the same write, because the partial unique index allows exactly one row
   * with a null `supersededAt` - so the new payment and the old one cannot both
   * be live for even one statement.
   */
  private async releaseReplacedHold(orderId: string, keepPaymentId: string): Promise<void> {
    const replaced = await this.prisma.payment.findMany({
      where: { orderId, supersededAt: null, id: { not: keepPaymentId } },
    });
    for (const payment of replaced) {
      let released = !this.stripe.configured;
      if (this.stripe.configured && payment.stripePaymentIntentId) {
        try {
          await this.stripe.cancelPaymentIntent(
            payment.stripePaymentIntentId,
            payment.id,
            'counter_offer_replaced',
          );
          released = true;
        } catch (e) {
          // A hold we could not release is real money sitting on a customer's
          // card. It must be loud, and it must not stop the handover: the new
          // authorization is already in place and the order has to proceed.
          this.logger.error(
            `releaseReplacedHold: order ${orderId} payment ${payment.id} not released: ${String(e)}`,
          );
        }
      }
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          supersededAt: new Date(),
          ...(released ? { status: 'cancelled', canceledAt: new Date() } : {}),
        },
      });
      await this.writeEvent(orderId, 'system', 'authorization_released', null, null, {
        reason: 'counter_offer_replaced',
        released,
        paymentId: payment.id,
      });
    }
  }

  /**
   * Give back a replacement hold that arrived too late to be used, and leave no
   * live payment behind it.
   */
  private async releaseSupersededHold(
    paymentId: string,
    orderId: string,
    reason: string,
  ): Promise<void> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;
    if (this.stripe.configured && payment.stripePaymentIntentId) {
      await this.stripe
        .cancelPaymentIntent(payment.stripePaymentIntentId, payment.id, reason)
        .catch((e) =>
          this.logger.error(`releaseSupersededHold: ${payment.id} not released: ${String(e)}`),
        );
    }
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'cancelled', canceledAt: new Date(), supersededAt: new Date() },
    });
    await this.writeEvent(orderId, 'system', 'authorization_released', null, null, {
      reason,
      released: true,
      paymentId,
    });
  }

  /** Tell an inspector their counter-offer ran out of time. */
  private async notifyCounterOfferExpired(counterOfferId: string): Promise<void> {
    const counter = await this.prisma.orderCounterOffer.findUnique({
      where: { id: counterOfferId },
      include: { order: { select: { number: true, make: true, model: true } } },
    });
    if (!counter) return;
    await this.notifications.notify(counter.inspectorId, 'counter_offer.expired', {
      orderId: counter.orderId,
      orderNumber: counter.order.number,
      make: counter.order.make,
      model: counter.order.model,
      priceCents: counter.priceCents,
    });
  }

  /**
   * Close the counter-offers an assignment has just made pointless (DEN-344).
   *
   * Two different things end here, and they are told apart because they read
   * differently to the person who gets the message:
   *
   *  - **On this order** — somebody else got the job, usually at the tariff
   *    price. The waiting inspector refused nothing and was refused nothing;
   *    the ordinary search simply won, which is the outcome the platform wants.
   *    `SUPERSEDED`.
   *  - **On every OTHER order** — the inspector who has just been assigned is
   *    now busy, and a price they named while free must stop waiting on a
   *    customer's screen. `WITHDRAWN`, and the customer's card is untouched:
   *    nothing was ever authorized for it.
   *
   * An ACCEPTING row is deliberately left alone. A customer is mid-payment
   * there, the payment lock means this assignment cannot be on that order, and
   * cancelling a counter-offer whose money is in flight would strand the
   * PaymentIntent it is creating.
   */
  private async settleCounterOffersOnAssignment(
    orderId: string,
    inspectorId: string,
  ): Promise<void> {
    const superseded = await this.prisma.orderCounterOffer.findMany({
      where: { orderId, status: 'PENDING' },
      include: { order: { select: { number: true, make: true, model: true } } },
    });
    const withdrawn = await this.prisma.orderCounterOffer.findMany({
      where: { inspectorId, status: 'PENDING', orderId: { not: orderId } },
      include: { order: { select: { number: true, make: true, model: true } } },
    });

    if (superseded.length) {
      await this.prisma.orderCounterOffer.updateMany({
        where: { id: { in: superseded.map((c) => c.id) }, status: 'PENDING' },
        data: { status: 'SUPERSEDED', respondedAt: new Date() },
      });
      for (const counter of superseded) {
        await this.notifications.notify(counter.inspectorId, 'counter_offer.superseded', {
          orderId: counter.orderId,
          orderNumber: counter.order.number,
          make: counter.order.make,
          model: counter.order.model,
          priceCents: counter.priceCents,
        });
      }
    }

    if (withdrawn.length) {
      await this.prisma.orderCounterOffer.updateMany({
        where: { id: { in: withdrawn.map((c) => c.id) }, status: 'PENDING' },
        data: { status: 'WITHDRAWN', respondedAt: new Date() },
      });
      for (const counter of withdrawn) {
        await this.writeEvent(counter.orderId, inspectorId, 'counter_offer_withdrawn', null, null, {
          counterOfferId: counter.id,
          reason: 'inspector took another order',
        });
      }
      // Some of those withdrawals were the price a customer was looking at on
      // another order. Each of those screens gets the next price in its own
      // queue (DEN-350) - otherwise one inspector taking a job silently stalls
      // every other order they had bid on.
      for (const orderId of new Set(withdrawn.map((c) => c.orderId))) {
        await this.counterOfferQueue.promoteQuietly(orderId);
      }
    }
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
    // DEN-291: no trip before the inspector has reached the car owner.
    if (
      target === OrderStatus.EN_ROUTE &&
      order.status === OrderStatus.ASSIGNED &&
      !order.ownerContactConfirmedAt
    ) {
      throw new ConflictException({
        error: {
          code: 'owner_contact_required',
          message: 'Confirm contact with the car owner before the trip',
        },
      });
    }
    await this.transition(orderId, target, userId);
    return { orderId, status: target };
  }

  /**
   * The assigned inspector hands the job back, with a reason.
   *
   * Deliberately NOT `cancel`'s percentage: the money was CAPTURED the moment
   * this inspector accepted, and the customer did nothing wrong, so the refund
   * is the whole `totalCents` under its own reason key. The inspector's share is
   * still in escrow — `releasePayout` runs on approve — so there is nothing to
   * claw back from them.
   *
   * `ASSIGNED`, `EN_ROUTE` and `IN_PROGRESS` may be declined (DEN-274). A
   * blocker can show itself only after the start — no car at the address, no
   * access from the seller, a car that is not safe to drive — and that is a
   * hand-back with a reason, not an argument. The refund is the same 100% in
   * all three statuses: the customer receives no report, so the customer pays
   * nothing. `DISPUTED` stays available for the arguments that need it.
   *
   * The order does NOT go back to the search pool — see the
   * `ASSIGNED -> UNASSIGNED` note in `order-state-machine.ts`. The customer
   * makes a new order instead.
   */
  async declineByInspector(
    orderId: string,
    userId: string,
    reason: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    refundCents: number;
    refundMode: RefundMode;
  }> {
    const order = await this.requireOrder(orderId);
    if (order.inspectorId !== userId) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not the assigned inspector' },
      });
    }

    const declinable: OrderStatus[] = [
      OrderStatus.ASSIGNED,
      OrderStatus.EN_ROUTE,
      OrderStatus.IN_PROGRESS,
    ];
    if (!declinable.includes(order.status)) {
      throw new ConflictException({
        error: {
          code: 'not_declinable',
          message: 'The order can no longer be declined; open a dispute instead',
        },
      });
    }

    // The DTO trims and length-checks this, but the guard is repeated here
    // because the reason is the whole point of the endpoint: an empty one puts
    // "cancelled, no reason given" in front of the customer.
    const trimmed = reason.trim();
    if (!trimmed) {
      throw new BadRequestException({
        error: { code: 'reason_required', message: 'A reason is required to decline an order' },
      });
    }

    /*
     * The status change is a CLAIM, taken BEFORE the money moves, exactly as
     * `sweepAbandonedInspections` takes it.
     *
     * The two racers are this endpoint and that sweep, and both refund the
     * whole amount. Nothing downstream separates them: they pass different
     * reasons — `inspector_declined` and `inspector_no_show` — so the unique
     * key on (orderId, reason) accepts both rows, and the Stripe idempotency
     * key `refund_<id>_<reason>` differs too, so Stripe pays out twice. An
     * inspector pressing "hand back" in the same seconds the hourly sweep
     * reaches his overdue order would be refunded twice, and the `transition`
     * that followed would return idempotently and report nothing.
     *
     * Claiming first makes the loser visible: `count === 0` means the sweep
     * already took the order, and the inspector is told it is gone rather than
     * being the second person to refund it.
     */
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: declinable } },
      data: { status: OrderStatus.CANCELLED },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        error: {
          code: 'not_declinable',
          message: 'The order can no longer be declined; open a dispute instead',
        },
      });
    }

    // `settleRefund` never throws: a refund failure must not be why the order
    // stays open. It cannot leave the order uncancelled now in any case — the
    // claim above already wrote that.
    const outcome = await this.settleRefund(order, order.totalCents, 'inspector_declined');
    await this.writeEvent(orderId, userId, 'inspector_declined', order.status, OrderStatus.CANCELLED, {
      reason: trimmed,
      refundCents: outcome.amountCents,
    });
    /*
     * The claim wrote the status, so `transition` would find CANCELLED and
     * return early — taking the `status_change` event and the customer's
     * letter with it. Both are written here instead, the way the sweep does
     * it. `notifyStatusChange` is reused rather than copied so the hand-back
     * letter stays one mapping.
     */
    await this.writeEvent(orderId, userId, 'status_change', order.status, OrderStatus.CANCELLED, null);
    try {
      await this.notifyStatusChange({ ...order, status: OrderStatus.CANCELLED }, order.status, {
        declinedByInspector: { reason: trimmed, refundCents: outcome.amountCents },
      });
    } catch (err) {
      this.logger.warn(
        `Hand-back notification failed for order ${orderId}: ${(err as Error).message}`,
      );
    }
    await this.countInspectorCancellation(userId);

    return {
      orderId,
      status: OrderStatus.CANCELLED,
      refundCents: outcome.amountCents,
      refundMode: refundModeOf(outcome.status),
    };
  }

  /**
   * DEN-291. The assigned inspector reports the call to the car owner.
   *
   * Only in `ASSIGNED`, and only once: both answers claim the row with a
   * conditional `updateMany` on `ownerContactConfirmedAt: null`, so a double
   * click, or the sweep in the same second, makes the loser a 409 instead of a
   * second refund.
   *
   * - `reached: true` stamps `ownerContactConfirmedAt`, which unlocks
   *   `ASSIGNED -> EN_ROUTE`, and tells the customer.
   * - `reached: false` cancels the order with a FULL refund under its own
   *   reason, `owner_unreachable`. It is deliberately NOT counted against the
   *   inspector (owner's decision): an owner who does not answer is not the
   *   inspector's fault. The event in the timeline keeps any abuse visible.
   */
  async recordOwnerContact(
    orderId: string,
    userId: string,
    reached: boolean,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    ownerContactConfirmedAt: string | null;
    refundCents: number;
    refundMode: RefundMode;
  }> {
    const order = await this.requireOrder(orderId);
    if (order.inspectorId !== userId) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not the assigned inspector' },
      });
    }
    const notPending = () =>
      new ConflictException({
        error: {
          code: 'owner_contact_not_pending',
          message: 'The owner contact can be reported only once, while the order is ASSIGNED',
        },
      });
    const pendingWhere = {
      id: orderId,
      inspectorId: userId,
      status: OrderStatus.ASSIGNED,
      ownerContactConfirmedAt: null,
    };
    const payload = {
      orderId: order.id,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
    };

    if (reached) {
      const now = new Date();
      const claimed = await this.prisma.order.updateMany({
        where: pendingWhere,
        data: { ownerContactConfirmedAt: now },
      });
      if (claimed.count === 0) throw notPending();
      await this.writeEvent(orderId, userId, 'owner_contacted', null, null, null);
      try {
        await this.notifications.notify(order.customerId, 'order.owner_contacted', payload);
      } catch (err) {
        this.logger.warn(
          `Owner-contact notification failed for order ${orderId}: ${(err as Error).message}`,
        );
      }
      return {
        orderId,
        status: OrderStatus.ASSIGNED,
        ownerContactConfirmedAt: now.toISOString(),
        refundCents: 0,
        refundMode: 'none',
      };
    }

    // The same claim-before-money rule as `declineByInspector`: the status is
    // taken first, so the hourly sweep and this call cannot both refund.
    const claimed = await this.prisma.order.updateMany({
      where: pendingWhere,
      data: { status: OrderStatus.CANCELLED },
    });
    if (claimed.count === 0) throw notPending();

    const outcome = await this.settleRefund(order, order.totalCents, 'owner_unreachable');
    await this.writeEvent(orderId, userId, 'owner_unreachable', order.status, OrderStatus.CANCELLED, {
      refundCents: outcome.amountCents,
    });
    // The claim wrote the status, so `transition` is not called and its
    // `status_change` event is written here, as the hand-back does it.
    await this.writeEvent(orderId, userId, 'status_change', order.status, OrderStatus.CANCELLED, null);
    try {
      await this.notifications.notify(order.customerId, 'order.owner_unreachable', {
        ...payload,
        refundCents: outcome.amountCents,
      });
    } catch (err) {
      this.logger.warn(
        `Owner-unreachable notification failed for order ${orderId}: ${(err as Error).message}`,
      );
    }

    return {
      orderId,
      status: OrderStatus.CANCELLED,
      ownerContactConfirmedAt: null,
      refundCents: outcome.amountCents,
      refundMode: refundModeOf(outcome.status),
    };
  }

  /**
   * Record the hand-back against the inspector. Never throws: the order is
   * already cancelled and the customer already refunded, and a bookkeeping
   * failure must not turn that into a 500 for the inspector.
   */
  private async countInspectorCancellation(userId: string): Promise<void> {
    try {
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { cancelCount: { increment: 1 } },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to count the cancellation for inspector ${userId}: ${(err as Error).message}`,
      );
    }
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
    await this.expirePendingOffers(orderId, order, inspectorId);
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

    await this.settleCounterOffersOnAssignment(orderId, inspectorId);
    return this.transition(orderId, OrderStatus.ASSIGNED, `admin:${adminId}`);
  }

  /**
   * Admin cancels an order with an explicit refund percent (0–100). If a
   * succeeded order Payment exists and the percent is > 0, a Refund of
   * round(totalCents * percent/100) is issued via the shared refund path with
   * reason 'admin'. The admin's `reason` is recorded as an admin decision.
   */
  async adminCancel(
    orderId: string,
    refundPercent: number,
    adminId: string,
    reason: string,
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
    await this.recordAdminDecision(orderId, adminId, {
      action: 'cancel',
      reason,
      refundPercent: pct,
      resolution: null,
    });
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
    reason: string,
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
      // Recorded whatever the transition did, like the dispute row: the
      // decision was made, and the admin who retries must see why.
      await this.recordAdminDecision(orderId, adminId, {
        action: 'resolve_dispute',
        reason,
        refundPercent: pct,
        resolution: 'customer',
      });
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
    await this.recordAdminDecision(orderId, adminId, {
      action: 'resolve_dispute',
      reason,
      refundPercent: null,
      resolution: 'inspector',
    });
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

  /**
   * Record why an admin cancelled an order or resolved a dispute (DEN-294).
   *
   * Never throws. When this runs, the money has already moved; a failed note
   * must not turn a completed decision into an error that the admin retries.
   */
  private async recordAdminDecision(
    orderId: string,
    adminId: string,
    decision: AdminDecision,
  ): Promise<void> {
    try {
      await this.writeEvent(orderId, `admin:${adminId}`, ADMIN_DECISION_EVENT, null, null, {
        action: decision.action,
        reason: decision.reason,
        refundPercent: decision.refundPercent,
        resolution: decision.resolution,
      });
    } catch (err) {
      this.logger.error(
        `Failed to record the admin decision on order ${orderId}: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // Queries
  // ============================================================

  /** The statuses each inspector tab stands for (DEN-328). */
  private static readonly ACTIVE_STATUSES = [
    OrderStatus.ASSIGNED,
    OrderStatus.EN_ROUTE,
    OrderStatus.IN_PROGRESS,
  ];
  private static readonly COMPLETED_STATUSES = [
    OrderStatus.SUBMITTED,
    OrderStatus.APPROVED,
    OrderStatus.DISPUTED,
    OrderStatus.CANCELLED,
    OrderStatus.COMPLETED,
    OrderStatus.REFUNDED,
  ];

  async listMine(
    userId: string,
    role: OrderRole,
    status?: string,
    opts: { tab?: OrderTab; sort?: OrderSort; page?: number; pageSize?: number } = {},
  ): Promise<{
    items: Array<ReturnType<OrdersService['toListItem']>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const statusFilter = status ? { status: status as OrderStatus } : {};
    const desc = (opts.sort ?? OrderSort.newest) === OrderSort.newest;
    /*
     * Paging is OPT-IN (DEN-328). A caller that sends neither field gets its
     * whole list, exactly as before the tabs — the customer cabinet and the
     * mobile-era callers among them. `total` is answered either way, so a
     * client can show a count without asking to be paged.
     */
    const paged = opts.page !== undefined || opts.pageSize !== undefined;
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const skip = paged ? (page - 1) * pageSize : undefined;
    const take = paged ? pageSize : undefined;

    if (role !== OrderRole.inspector) {
      const where = { customerId: userId, ...statusFilter };
      const [orders, total] = await this.prisma.$transaction([
        this.prisma.order.findMany({
          where,
          orderBy: { createdAt: desc ? 'desc' : 'asc' },
          skip,
          take,
        }),
        this.prisma.order.count({ where }),
      ]);
      return { items: orders.map((o) => this.toListItem(o)), total, page, pageSize };
    }

    const now = new Date();
    // Orders assigned to me OR for which I have an active offer.
    const offered = await this.prisma.orderOffer.findMany({
      where: { inspectorId: userId, status: 'PENDING', expiresAt: { gt: now } },
      select: { orderId: true, expiresAt: true },
    });
    const offeredIds = offered.map((o) => o.orderId);
    // Keep the deadline of the offer made to THIS inspector, so the row can
    // count down to it. One order holds at most one PENDING offer per
    // inspector; the last write wins if that ever changes.
    const offerDeadlines = new Map<string, Date>();
    for (const o of offered) offerDeadlines.set(o.orderId, o.expiresAt);

    /*
     * Each tab is a different question, so each carries its own filter AND its
     * own sort field. Sorting all three by `createdAt` would put the wrong row
     * at the top of the active list: what matters there is which job burns
     * first, not which was ordered last.
     *
     * Ordering happens in the QUERY, never after the slice — a page sorted
     * after it was cut is not the page the reader asked for.
     */
    const mine = { inspectorId: userId };
    /*
     * A tab and an explicit `status` INTERSECT, they do not override.
     *
     * The tab list used to be spread after `statusFilter`, so the later key won
     * and `?tab=active&status=ASSIGNED` answered all three active statuses —
     * a filter the caller can see it applied and the answer does not honour.
     * A status the tab does not hold asks for nothing, and an empty `in` is the
     * honest answer rather than a silently widened one.
     */
    const tabStatuses = (list: OrderStatus[]) => ({
      status: { in: status ? list.filter((s) => s === (status as OrderStatus)) : list },
    });
    const where =
      opts.tab === OrderTab.offers
        ? { ...statusFilter, id: { in: offeredIds } }
        : opts.tab === OrderTab.active
          ? { ...mine, ...tabStatuses(OrdersService.ACTIVE_STATUSES) }
          : opts.tab === OrderTab.completed
            ? { ...mine, ...tabStatuses(OrdersService.COMPLETED_STATUSES) }
            : { ...statusFilter, OR: [{ inspectorId: userId }, { id: { in: offeredIds } }] };

    const orderBy: Prisma.OrderOrderByWithRelationInput =
      opts.tab === OrderTab.active
        ? // The clock that can take the job away. Nulls are orders assigned
          // before the deadline existed, and they are asked for LAST in both
          // directions: Postgres puts them first on a DESC sort, which would
          // open the newest-first page with the rows that have no clock at all.
          { inspectionDeadlineAt: { sort: desc ? 'desc' : 'asc', nulls: 'last' } }
        : { createdAt: desc ? 'desc' : 'asc' };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({ where, orderBy, skip, take }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: orders.map((o) => this.toListItem(o, offerDeadlines.get(o.id) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * The jobs this inspector was offered and never answered (DEN-327).
   *
   * `listMine` cannot show them: it holds the orders the inspector is assigned
   * to plus those with a LIVE `PENDING` offer, so the hour runs out and the
   * order leaves the cabinet with nothing left behind. DEN-324 tells the
   * inspector once, in the bell; this is the list.
   *
   * Three rules, each a decision:
   *
   *  - **EXPIRED only.** A `DECLINED` offer was a deliberate answer, and a list
   *    that reminds somebody of work they refused is noise.
   *  - **A window, not a purge.** Rows older than `days` fall out of this
   *    answer and stay in the database. Deleting them would re-admit a declined
   *    inspector to the same order (DEN-326) and tear events out of the order's
   *    own history.
   *  - **One entry per order.** After DEN-326 the same order can expire on this
   *    inspector once per round, so the rounds collapse into one entry carrying
   *    the latest expiry and how many times the job was offered.
   *
   * The money is the OFFER's own share and never the order's: dispatch walks
   * down the candidates and prices each on their own base fee, so the order
   * total belongs to whoever it was quoted for. An offer minted before that
   * column existed falls back to the order, which is what it was worth then.
   */
  async listMissedOffers(
    userId: string,
    opts: { days?: number; sort?: OrderSort; page?: number; pageSize?: number } = {},
  ): Promise<{
    items: Array<ReturnType<OrdersService['toMissedItem']>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const days = opts.days ?? 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const expired = await this.prisma.orderOffer.findMany({
      where: {
        inspectorId: userId,
        status: 'EXPIRED',
        expiresAt: { gte: since },
        // An order this inspector holds NOW is not a missed one, whatever an
        // earlier round says. After DEN-326 the same order can expire in round
        // 0 and be accepted by the same person in round 1, and it would then
        // stand in the missed list and in the active list at the same time.
        //
        // The null branch is not decoration: `not` compiles to `<> $1`, which
        // is UNKNOWN for a NULL column, so an order still looking for anybody
        // would be dropped from the list this endpoint exists for.
        OR: [
          { order: { inspectorId: null } },
          { order: { inspectorId: { not: userId } } },
        ],
      },
      orderBy: { expiresAt: 'desc' },
      include: { order: true },
    });

    // Newest first, so the first row seen for an order is the latest one.
    const latest = new Map<string, (typeof expired)[number]>();
    const times = new Map<string, number>();
    for (const offer of expired) {
      if (!latest.has(offer.orderId)) latest.set(offer.orderId, offer);
      times.set(offer.orderId, (times.get(offer.orderId) ?? 0) + 1);
    }

    /*
     * Collapse first, THEN count and cut (DEN-328). This is the one list whose
     * paging cannot be done by the database: a row here is an ORDER, and the
     * rounds behind it are several offers, so `LIMIT` over the offers would
     * hand back a page of the wrong length and a `total` that disagrees with
     * what the reader sees.
     *
     * It is safe to do in memory precisely because of the seven-day window:
     * the set is one inspector's expired offers of one week, not a history.
     */
    const collapsed = [...latest.values()];
    if ((opts.sort ?? OrderSort.newest) === OrderSort.oldest) collapsed.reverse();

    const paged = opts.page !== undefined || opts.pageSize !== undefined;
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const window = paged
      ? collapsed.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
      : collapsed;

    return {
      items: window.map((offer) =>
        this.toMissedItem(offer, offer.order, times.get(offer.orderId) ?? 1),
      ),
      total: collapsed.length,
      page,
      pageSize,
    };
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
    const isAdmin = isAdminRole(role);
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
      this.activePaymentForOrder(orderId),
      this.settings.getNumber('minReportQualityScore'),
    ]);

    const money = describeStoredFare({
      billedDistanceKm: Number(order.distanceKm),
      returnTripFactor: Number(order.returnTripFactor),
      freeRadiusKm: Number(order.freeRadiusKm),
      billedDurationMin: order.durationMin,
    });

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      vehicle: { vin: order.vin, make: order.make, model: order.model },
      address: order.address,
      /*
       * The seller's contact (a phone number or a listing link), typed by the
       * customer at checkout. DEN-291: the inspector must reach the car owner
       * before the trip. `isInspector` is true only AFTER acceptance, so an
       * inspector who holds a pending offer does not see it. It is the SELLER's
       * channel, not the customer's, so the rule above (the customer's channels
       * go to an admin only) is unchanged.
       */
      listingUrl: isCustomer || isInspector || isAdmin ? order.listingUrl : null,
      // DEN-291: null until the inspector reports "contacted"; the trip is
      // locked while it is null and the order is ASSIGNED.
      ownerContactConfirmedAt: order.ownerContactConfirmedAt?.toISOString() ?? null,
      scheduledAt: order.scheduledAt?.toISOString() ?? null,
      money: {
        baseFeeCents: order.baseFeeCents,
        distanceKm: money.distanceKm,
        chargeableDistanceKm: money.chargeableDistanceKm,
        billedDistanceKm: money.billedDistanceKm,
        returnTripFactor: money.returnTripFactor,
        freeRadiusKm: money.freeRadiusKm,
        distanceFeeCents: order.distanceFeeCents,
        durationMin: money.durationMin,
        billedDurationMin: money.billedDurationMin,
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
      /*
       * Why the order was handed back, when it was.
       *
       * Derived from the `inspector_declined` event rather than a column, the
       * same way `search.expiredAt` is: the timeline already holds the fact.
       * The reason is the ONLY part of any event payload this endpoint
       * discloses — payloads elsewhere carry operational detail — and it is
       * disclosed because it was typed FOR the customer to read.
       */
      declined: (() => {
        const event = events.find(
          (e) =>
            e.type === 'inspector_declined' ||
            e.type === 'inspector_no_show' ||
            e.type === 'owner_unreachable',
        );
        if (!event) return null;
        const payload = (event.payload ?? {}) as { reason?: unknown; refundCents?: unknown };
        return {
          // The two are one panel with two headings, not two panels: the money
          // fact and the "order it again" action are identical, and only the
          // sentence about the inspector differs. A no-show carries no reason —
          // nobody typed one — and the website must say so rather than print an
          // empty quotation.
          kind:
            event.type === 'inspector_no_show'
              ? ('no_show' as const)
              : event.type === 'owner_unreachable'
                ? ('owner_unreachable' as const)
                : ('declined' as const),
          reason: typeof payload.reason === 'string' ? payload.reason : '',
          refundCents: typeof payload.refundCents === 'number' ? payload.refundCents : null,
          at: event.createdAt.toISOString(),
        };
      })(),
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
      // An admin decision carries the admin's own reason, which only admins may
      // read (DEN-294). The admin detail gets it as a separate `decisions` list.
      events: events
        .filter((e) => e.type !== ADMIN_DECISION_EVENT)
        .map((e) => ({
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

  /**
   * Every PENDING offer for an order → EXPIRED, and the holder of each one is
   * told (DEN-324/325).
   *
   * The bulk `updateMany` alone leaves the inspector with two invisible
   * changes: the order leaves `listMine`, because that shows only what they
   * hold or have a live offer for, and the `offer.received` card in their bell
   * keeps standing as live work. `expireStaleOffers` explains both for the
   * one-offer case; this does the same where the order ends around a live
   * offer — the search window closes, or an admin gives the job to somebody
   * else.
   *
   * `notify` and `markSupersededRead` are non-throwing by contract, so a broken
   * bell cannot keep an offer alive.
   *
   * @param exceptInspectorId the inspector who is KEEPING the order, whose own
   *   offer is handled by the caller and must not be expired here.
   */
  private async expirePendingOffers(
    orderId: string,
    order: { number: string; make: string; model: string },
    exceptInspectorId?: string,
  ): Promise<void> {
    const pending = await this.prisma.orderOffer.findMany({
      where: {
        orderId,
        status: 'PENDING',
        ...(exceptInspectorId ? { inspectorId: { not: exceptInspectorId } } : {}),
      },
    });
    if (pending.length === 0) return;
    await this.prisma.orderOffer.updateMany({
      where: { id: { in: pending.map((o) => o.id) } },
      data: { status: 'EXPIRED' },
    });
    for (const offer of pending) {
      await this.notifications.notify(offer.inspectorId, 'offer.expired', {
        orderId,
        orderNumber: order.number,
        make: order.make,
        model: order.model,
      });
      await this.notifications.markSupersededRead(
        offer.inspectorId,
        'offer.received',
        orderId,
      );
    }
  }

  /** PENDING offers past expiresAt → EXPIRED, then cascade dispatch. */
  async expireStaleOffers(): Promise<{ expired: number }> {
    const stale = await this.prisma.orderOffer.findMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    });
    for (const offer of stale) {
      await this.prisma.orderOffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED' } });
      /*
       * Tell the inspector BEFORE the cascade (DEN-324). Two things happen to
       * them at once and neither is visible: the order leaves their cabinet,
       * because `listMine` shows an inspector only what they hold or what they
       * have a live offer for, and the `offer.received` card in their bell
       * keeps standing. So one message explains the empty cabinet, and the old
       * card stops counting as unread (DEN-325).
       *
       * Before the cascade because `dispatch` offers the job onward and
       * notifies the NEXT inspector; the reader of this message should not be
       * told second. Neither call throws — `notify` and `markSupersededRead`
       * are non-throwing by contract — so an offer still expires if the bell
       * is broken.
       */
      const order = await this.prisma.order.findUnique({ where: { id: offer.orderId } });
      if (order) {
        await this.notifications.notify(offer.inspectorId, 'offer.expired', {
          orderId: offer.orderId,
          orderNumber: order.number,
          make: order.make,
          model: order.model,
        });
        await this.notifications.markSupersededRead(
          offer.inspectorId,
          'offer.received',
          offer.orderId,
        );
      }
      await this.dispatch(offer.orderId);
    }
    return { expired: stale.length };
  }

  /**
   * An order nobody could be found for, offered again (DEN-326).
   *
   * `dispatch` walks the candidate pool one inspector at a time and parks the
   * order in UNASSIGNED when it runs out. That was the end of the order's life:
   * `dispatch` is called by the payment webhook, by `declineOffer` and by
   * `expireStaleOffers`, and an UNASSIGNED order holds no PENDING offer, so no
   * offer can expire and nothing calls `dispatch` again. No inspector can find
   * it either — `listMine` shows an inspector only what they hold or have a
   * live offer for. The order simply waited to be cancelled, while the answer
   * changed underneath it: an inspector registers in the area, lowers their
   * base fee, or finishes the job that kept them busy.
   *
   * So each pass here is one more ROUND. Raising `dispatchRound` is what makes
   * an inspector who never answered available again, and `dispatch` reads the
   * number to decide who is still excluded.
   *
   * There is deliberately NO pause between rounds and no cap on how many times
   * one inspector may be asked. The offer timeout IS the pause: an offer stands
   * for `offerTimeoutMinutes`, so a round over five candidates already takes
   * hours. The consequence, stated plainly because it was chosen rather than
   * overlooked: in a region with one inspector, that inspector is asked again
   * every hour until the window closes.
   *
   * The round is raised by a CONDITIONAL write, which is also how this job
   * stays out of `expireUnfilledSearches`'s way. That job claims an order by
   * setting CANCELLED; if it got there first, `count === 0` here and this order
   * is left alone. `dispatch` re-reads the order and refuses anything that is
   * not PAID or UNASSIGNED, so the narrow window between the two is closed
   * there as well.
   *
   * An order whose region holds nobody at all raises its round on every pass
   * and offers nothing. That is a counter moving with no work behind it, which
   * is cheap and honest; the geo query is the only cost, and the search window
   * bounds how long it repeats.
   */
  async redispatchUnfilledOrders(limit = 50): Promise<{ rounds: number }> {
    const now = new Date();
    const due = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.UNASSIGNED,
        inspectorId: null,
        searchExpiresAt: { not: null, gt: now },
      },
      orderBy: { searchExpiresAt: 'asc' },
      take: limit,
    });

    let rounds = 0;
    for (const order of due) {
      try {
        const claimed = await this.prisma.order.updateMany({
          where: {
            id: order.id,
            status: OrderStatus.UNASSIGNED,
            inspectorId: null,
            searchExpiresAt: { not: null, gt: now },
          },
          data: { dispatchRound: { increment: 1 } },
        });
        if (claimed.count === 0) continue;
        // The event is written only when the round reached somebody. A round
        // that found nobody is the normal state of an order in a thin region,
        // and this job runs every 5 minutes against a search window of up to 24
        // hours: writing unconditionally puts ~288 `dispatch_round` rows in a
        // timeline the CUSTOMER reads, where each one renders as the raw type
        // name because the message catalogues do not describe it.
        const offered = await this.dispatch(order.id);
        if (offered) {
          await this.writeEvent(order.id, 'system', 'dispatch_round', null, null, {
            round: order.dispatchRound + 1,
          });
        }
        rounds += 1;
      } catch (err) {
        this.logger.error(
          `redispatchUnfilledOrders(${order.id}) failed: ${(err as Error).message}`,
        );
      }
    }
    return { rounds };
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

        await this.expirePendingOffers(order.id, order);
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
   * An inspector accepted and then nothing happened (DEN-269).
   *
   * `ASSIGNED` and `EN_ROUTE` are the states with no timer of their own: the
   * offer timeout is spent, the search window is closed, and the report gate is
   * a long way off. Until this existed such an order lived for ever on money
   * that was CAPTURED the moment it was accepted.
   *
   * `IN_PROGRESS` is never swept. The inspection has started, the inspector may
   * be standing at the car, and taking the job away from them mid-inspection is
   * a dispute's job, not a cron's.
   *
   * **A null deadline is skipped, and that is load-bearing** — the same rule
   * `expireUnfilledSearches` follows for `searchExpiresAt`. Null means the order
   * was assigned before this shipped: it was never given the rule, and
   * cancelling live work under it would be the sweep's worst possible failure.
   *
   * The status change is a CLAIM, not a conclusion, for the same reason as the
   * search sweep: an inspector pressing "start inspection" or handing the job
   * back at the same moment must win, and `count === 0` says they did.
   */
  async sweepAbandonedInspections(): Promise<{ cancelled: number }> {
    const now = new Date();
    /*
     * Only for the letter to the inspector. The deadline itself is the stamped
     * `inspectionDeadlineAt`, so a setting changed mid-week moves no order that
     * is already running; reading it here can therefore name a number one day
     * out on that one order, which is a far smaller fault than a letter that
     * says "in time" and names nothing.
     */
    const deadlineDays = await this.settings
      .getNumber('inspectionStartDeadlineDays')
      .catch(() => 7);
    const stale = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.ASSIGNED, OrderStatus.EN_ROUTE] },
        inspectionDeadlineAt: { not: null, lt: now },
      },
    });

    let cancelled = 0;
    for (const order of stale) {
      try {
        const claimed = await this.prisma.order.updateMany({
          where: {
            id: order.id,
            status: { in: [OrderStatus.ASSIGNED, OrderStatus.EN_ROUTE] },
            inspectionDeadlineAt: { not: null, lt: now },
          },
          data: { status: OrderStatus.CANCELLED },
        });
        if (claimed.count === 0) continue;

        // The whole amount, exactly as in a hand-back: the customer waited a
        // week for an inspection that never started, and none of that is theirs
        // to pay for. `settleRefund` never throws.
        const outcome = await this.settleRefund(order, order.totalCents, 'inspector_no_show');
        await this.writeEvent(order.id, 'system', 'inspector_no_show', null, null, {
          deadlineAt: order.inspectionDeadlineAt?.toISOString() ?? null,
          refundCents: outcome.amountCents,
          refund: outcome.status,
          detail: outcome.detail,
        });
        // The claim already wrote the status, so the `status_change` event that
        // `transition` would have written is recorded here.
        await this.writeEvent(
          order.id,
          'system',
          'status_change',
          order.status,
          OrderStatus.CANCELLED,
          null,
        );
        if (order.inspectorId) await this.countInspectorCancellation(order.inspectorId);
        /*
         * Not the DEN-268 letter. That one quotes the reason the inspector
         * typed, and there is nobody to quote here — the whole event is that
         * they said nothing. And not `order.cancelled` either, whose copy tells
         * the reader they cancelled.
         */
        await this.notifications.notify(order.customerId, 'order.inspector_no_show', {
          orderId: order.id,
          orderNumber: order.number,
          refundCents: outcome.amountCents,
        });
        /*
         * And the inspector, who until now lost the job, the fee and a mark on
         * his record in silence. He was shown the deadline in the accept
         * dialog, so this letter states the outcome rather than apologising for
         * it. Best-effort like every other notify here: the order is already
         * cancelled and the customer already refunded.
         */
        if (order.inspectorId) {
          await this.notifications.notify(order.inspectorId, 'order.inspector_no_show_self', {
            orderId: order.id,
            orderNumber: order.number,
            days: deadlineDays,
          });
        }
        cancelled += 1;
      } catch (err) {
        this.logger.error(
          `sweepAbandonedInspections: order ${order.id} threw: ${(err as Error).message}`,
        );
      }
    }
    return { cancelled };
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
      const payment = await this.activePaymentForOrder(orderId);
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
      where: { role: { in: [...ADMIN_ROLES] }, deletedAt: null, bannedAt: null },
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

    const payment = await this.activePaymentForOrder(order.id);
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
      where: { role: { in: [...ADMIN_ROLES] }, deletedAt: null, bannedAt: null },
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
      where: { role: { in: [...ADMIN_ROLES] }, deletedAt: null, bannedAt: null },
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
  async transition(
    orderId: string,
    to: OrderStatus,
    actor: string,
    context?: TransitionContext,
  ): Promise<Order> {
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
      /*
       * DEN-269: the clock the inspector has to actually start the inspection.
       * Set here rather than in `acceptOffer` so that EVERY route into ASSIGNED
       * carries one — an admin assignment included; an order assigned by hand
       * with no deadline would be exactly the order that goes quiet.
       *
       * Best-effort like the contract below: an order without a deadline lives
       * on as orders did before this shipped, which is the same thing a null
       * means everywhere else.
       */
      try {
        const days = await this.settings.getNumber('inspectionStartDeadlineDays');
        await this.prisma.order.update({
          where: { id: orderId },
          data: { inspectionDeadlineAt: new Date(Date.now() + days * 86_400_000) },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to set the inspection deadline for order ${orderId}: ${(err as Error).message}`,
        );
      }
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
      await this.notifyStatusChange(updated, from, context);
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
  private async notifyStatusChange(
    order: Order,
    _from: OrderStatus,
    context?: TransitionContext,
  ): Promise<void> {
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
        // An inspector hand-back is its own event. `order.cancelled` tells the
        // reader they cancelled, which is the opposite of what happened, and it
        // carries neither the reason nor the refund the customer is owed. The
        // inspector who declined is not told anything: they just did it.
        if (context?.declinedByInspector) {
          await this.notifications.notify(customer, 'order.declined_by_inspector', {
            ...payload,
            reason: context.declinedByInspector.reason,
            refundCents: context.declinedByInspector.refundCents,
          });
          break;
        }
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

  /**
   * Public since DEN-344: `CounterOffersService` writes to the same timeline.
   * A second copy of this in another service would be a second definition of
   * what an order's history looks like.
   */
  async writeEvent(
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

  private toListItem(o: Order, offerExpiresAt?: Date | null) {
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      make: o.make,
      model: o.model,
      address: o.address,
      scheduledAt: o.scheduledAt?.toISOString() ?? null,
      totalCents: o.totalCents,
      // The split rides on the row because the inspector's list is the FIRST
      // place a job is priced for them, and `totalCents` there is the
      // customer's number — it overstates what they earn by the whole
      // commission. Sent to both sides; each renders the figure that is theirs.
      platformFeeCents: o.platformFeeCents,
      inspectorShareCents: o.inspectorShareCents,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
      /*
       * The two clocks that can take the job away, so the row can show how much
       * time is left. Neither is a new rule: `offerExpiresAt` is the PENDING
       * offer that `expireStaleOffers` passes on each minute, and
       * `inspectionDeadlineAt` is the stamp `sweepAbandonedInspections` reads
       * before it cancels the order and refunds the customer in full.
       *
       * `offerExpiresAt` is per-VIEWER, not per-order: it is the deadline of the
       * offer made to the inspector who asked, and it is therefore null for the
       * customer's list and for an order this inspector already holds.
       */
      offerExpiresAt: offerExpiresAt ? offerExpiresAt.toISOString() : null,
      inspectionDeadlineAt: o.inspectionDeadlineAt ? o.inspectionDeadlineAt.toISOString() : null,
    };
  }

  /**
   * One row of the missed-offers list (DEN-327).
   *
   * Deliberately NOT `toListItem`. That row is built for work the reader can
   * act on — it carries live deadlines and drives accept and decline buttons —
   * and none of that is true here. This row answers one question instead: what
   * was the job, what would it have paid, when did it run out, and what became
   * of it.
   *
   * `outcome` is read from the order as it stands now, so the inspector learns
   * whether somebody else took the work or whether nobody did. `taken` covers
   * every state past assignment: to this reader they are one fact, that the
   * order is not theirs and is not coming back.
   */
  private toMissedItem(
    offer: { id: string; expiresAt: Date; inspectorShareCents: number | null },
    o: Order,
    timesOffered: number,
  ) {
    const outcome =
      o.status === OrderStatus.CANCELLED
        ? 'cancelled'
        : o.status === OrderStatus.PAID || o.status === OrderStatus.UNASSIGNED
          ? 'searching'
          : 'taken';
    return {
      offerId: offer.id,
      orderId: o.id,
      number: o.number,
      make: o.make,
      model: o.model,
      address: o.address,
      // What THIS offer would have paid. Null only for an offer minted before
      // the column existed, where the order's own figure is what it was worth.
      inspectorShareCents: offer.inspectorShareCents ?? o.inspectorShareCents,
      currency: o.currency,
      expiredAt: offer.expiresAt.toISOString(),
      timesOffered,
      outcome,
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
  /**
   * The seller's phone number or listing link. Null for an inspector with only
   * a pending offer, and for orders created before DEN-291 made it required.
   */
  listingUrl: string | null;
  /** DEN-291: when the inspector confirmed contact with the car owner. */
  ownerContactConfirmedAt: string | null;
  /**
   * Null for every order created after DEN-290: the customer no longer
   * chooses a time. Kept on the wire so a website that still reads it sees
   * null rather than a missing key.
   */
  scheduledAt: string | null;
  money: {
    baseFeeCents: number;
    /**
     * The measured one-direction trip.
     *
     * **Null when the row cannot answer** — a vehicle inside the free radius
     * bills 0 kilometres whatever its distance, so the measurement is not in
     * the row and `describeStoredFare` refuses to invent one. Render nothing
     * for null; the fee rows should read the billed quantities anyway.
     */
    distanceKm: number | null;
    /** What the per-km rate was applied to. Optional so the website can lag. */
    billedDistanceKm?: number;
    /** One direction, after the free radius came off. */
    chargeableDistanceKm?: number;
    returnTripFactor?: number;
    freeRadiusKm?: number;
    distanceFeeCents: number;
    /**
     * The measured one-direction travel time. Null for orders placed before the
     * ride-hailing tariff.
     */
    durationMin: number | null;
    /**
     * What the per-minute rate was applied to — both directions, the figure the
     * column actually stores. Optional so the website can lag.
     *
     * It exists because `durationMin` and `distanceKm` must describe the same
     * trip: the detail used to report the distance one-way and the minutes
     * both ways, and a page showing "38 km" beside "114 min" reads as a
     * traffic jam rather than a return trip.
     */
    billedDurationMin?: number | null;
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
  /**
   * The inspector's channels. Non-null for the customer only once the order is
   * COMPLETED, and for an admin in every status — see the disclosure rule in
   * `getDetail`, which is where the reasoning lives.
   */
  inspectorContact: PartyContact | null;
  /**
   * The customer's channels. Non-null for an **admin and nobody else** — not
   * for the assigned inspector, at any status. Optional in the type so the
   * website can deploy in either order.
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
  /**
   * Set when the assigned inspector handed the order back (DEN-268). Null on
   * every other order, including one the CUSTOMER cancelled — the two look the
   * same in `status` and read very differently to the person who paid.
   */
  declined?: {
    /**
     * `declined` — the inspector handed it back. `no_show` — they went quiet.
     * `owner_unreachable` — the inspector could not reach the car owner (DEN-291).
     */
    kind: 'declined' | 'no_show' | 'owner_unreachable';
    reason: string;
    refundCents: number | null;
    at: string;
  } | null;
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
