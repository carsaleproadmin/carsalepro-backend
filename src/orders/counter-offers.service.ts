import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GeoService } from '../geo/geo.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../payments/stripe.service';
import { OrdersService } from './orders.service';
import { CounterOfferQueueService } from './counter-offer-queue.service';
import {
  COUNTER_OFFER_PAYMENT_PURPOSE,
  counterOfferCeilingCents,
  counterOfferExpiry,
  counterOfferMaxPayoutCents,
  counterOfferPayoutFromTotal,
  counterOfferPriceError,
  counterOfferTotalFromPayout,
} from './counter-offer-rules';

/**
 * Counter-offers (DEN-344): an inspector names a price for an order the
 * automatic search could not give them, and the customer answers it.
 *
 * Why it is a separate service and not more of `OrdersService`: the money paths
 * that follow an ACCEPTED counter-offer belong with capture and release, and
 * they live there. What lives here is everything a person does — the inspector
 * listing and pricing, the customer accepting and refusing — and the rules that
 * keep the trade from turning into an auction.
 *
 * The single hardest rule, and the reason several methods look defensive:
 * **one PRESENTED counter-offer per order**. Any number of inspectors may name
 * a price - they queue, cheapest first (DEN-350) - but the customer answers one
 * question at a time, and the next price is shown only when the current one is
 * answered, withdrawn or expires. Two promotions that race both pass any check
 * written in TypeScript, so the refusal is a partial unique index and this code
 * reads its violation.
 *
 * Promotion happens in exactly one place, `CounterOfferQueueService.promote`,
 * and every path that can end the presented offer calls it. Spreading "show the
 * next one" over the call sites is how an order ends up with a queue nobody
 * drains.
 */
@Injectable()
export class CounterOffersService {
  private readonly logger = new Logger(CounterOffersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly queue: CounterOfferQueueService,
    private readonly settings: SettingsService,
    private readonly geo: GeoService,
    private readonly notifications: NotificationsService,
    private readonly stripe: StripeService,
  ) {}

  // ============================================================
  // Inspector side
  // ============================================================

  /**
   * The orders this inspector can reach but cannot be offered, because the
   * order pays less than they charge — the "below your rate" tab.
   *
   * Only orders whose trade is OPEN are listed: UNASSIGNED, and past the first
   * dispatch round. Showing the rest would be worse than showing nothing, since
   * the inspector could do nothing about any of them and would learn to ignore
   * the tab.
   *
   * An order already carrying prices from other inspectors stays in the list
   * and says how many are queued ahead (DEN-350). Naming a price is never
   * refused for it: a cheaper price entering the queue goes in FRONT of the
   * dearer ones, which is the whole reason the queue is sorted on price.
   */
  async listOpenForInspector(userId: string) {
    const profile = await this.prisma.inspectorProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not an inspector' },
      });
    }

    const open = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.UNASSIGNED,
        inspectorId: null,
        dispatchRound: { gte: 1 },
        // Never the inspector's own order (F-13), and never one they refused by
        // hand: a declined order is out for good, and a trade must not be a way
        // back into a job somebody already said no to.
        customerId: { not: userId },
        offers: { none: { inspectorId: userId, status: 'DECLINED' } },
      },
      // The whole row, because `fairPriceForInspector` prices from the order it
      // is given. A narrower `select` here cost one `findUnique` per candidate
      // in the loop below - up to 100 extra queries to build one tab.
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (open.length === 0) return { items: [] };

    const radiusKm = await this.settings.getNumber('expertSearchRadiusKm');
    const reachable = await this.geo.ordersNearInspector({
      inspectorUserId: userId,
      orderIds: open.map((o) => o.id),
      radiusKm,
    });
    if (reachable.length === 0) return { items: [] };

    const [active, mine, multiplier] = await Promise.all([
      this.prisma.orderCounterOffer.findMany({
        where: { orderId: { in: reachable.map((r) => r.orderId) }, status: { in: ['PENDING', 'ACCEPTING'] } },
        select: {
          orderId: true,
          inspectorId: true,
          status: true,
          priceCents: true,
          createdAt: true,
          presentedAt: true,
          expiresAt: true,
          acceptingUntil: true,
        },
      }),
      this.prisma.orderCounterOffer.findMany({
        where: { inspectorId: userId, orderId: { in: reachable.map((r) => r.orderId) } },
        select: {
          orderId: true,
          status: true,
          priceCents: true,
          createdAt: true,
          presentedAt: true,
          inspectorShareCents: true,
        },
      }),
      this.settings.getNumber('counterOfferMaxMultiplier'),
    ]);
    // The inspector names what they will BE PAID (DEN-344), so every bound on
    // the card is given in that unit as well as the customer's.
    const platformFeePercent = await this.settings.getNumber('platformFeePercent');
    const activeByOrder = new Map<string, typeof active>();
    for (const row of active) {
      const bucket = activeByOrder.get(row.orderId);
      if (bucket) bucket.push(row);
      else activeByOrder.set(row.orderId, [row]);
    }
    const mineByOrder = new Map(mine.map((m) => [m.orderId, m]));
    const orderById = new Map(open.map((o) => [o.id, o]));

    const items = [];
    for (const { orderId, distanceKm } of reachable) {
      const order = orderById.get(orderId);
      if (!order) continue;

      // What the order would pay THIS inspector, and the most they may ask.
      // Computed per order rather than once, because both depend on how far
      // away they are from this particular car.
      const fair = await this.orders.fairPriceForInspector(order, userId, distanceKm);
      // The tab answers one question: "which orders pay less than I charge?".
      // An order whose own total already covers this inspector is one dispatch
      // will offer them in the ordinary way, so it does not belong here.
      if (fair.totalCents <= order.totalCents) continue;

      const queue = activeByOrder.get(orderId) ?? [];
      const presented = queue.find((c) => c.presentedAt !== null) ?? null;
      const own = mineByOrder.get(orderId);
      // What the inspector needs in order to decide: how many prices are in
      // front of theirs, and by when the customer must answer the one on the
      // screen. Never the prices themselves - that would let an inspector
      // undercut a colleague by a cent and turn the queue into a bidding war.
      const ahead =
        own && own.status === 'PENDING'
          ? queue.filter(
              (c) =>
                c.inspectorId !== userId &&
                (c.presentedAt !== null ||
                  c.priceCents < own.priceCents ||
                  (c.priceCents === own.priceCents && c.createdAt < own.createdAt)),
            ).length
          : queue.length;
      items.push({
        orderId,
        number: order.number,
        make: order.make,
        model: order.model,
        address: order.address,
        distanceKm,
        /** What the order pays today — the sum held on the customer's card. */
        orderTotalCents: order.totalCents,
        /** What the order pays this inspector today, before they name a price. */
        orderPayoutCents: counterOfferPayoutFromTotal(order.totalCents, platformFeePercent),
        /** What it would pay this inspector if it had been priced on them. */
        fairPriceCents: fair.totalCents,
        fairPayoutCents: counterOfferPayoutFromTotal(fair.totalCents, platformFeePercent),
        maxPriceCents: counterOfferCeilingCents(fair.totalCents, multiplier),
        /**
         * The ceiling in the unit the form asks for, and the largest payout
         * that is actually accepted - not merely the fee taken off the
         * ceiling, which can round a cent high and be refused when typed back.
         */
        maxPayoutCents: counterOfferMaxPayoutCents(
          counterOfferCeilingCents(fair.totalCents, multiplier),
          platformFeePercent,
        ),
        platformFeePercent,
        currency: order.currency,
        searchExpiresAt: order.searchExpiresAt?.toISOString() ?? null,
        /**
         * How many prices are ahead of this inspector's in the queue - or, when
         * they have not named one, how many are waiting in total. Zero means
         * naming a price now puts it straight in front of the customer.
         */
        queuedAhead: ahead,
        /** When the price on the customer's screen stops waiting, if there is one. */
        answerDueAt: presented
          ? (presented.acceptingUntil ?? presented.expiresAt).toISOString()
          : null,
        myCounterOffer: own
          ? {
              status: own.status,
              priceCents: own.priceCents,
              payoutCents: own.inspectorShareCents,
              /** True while this is the price the customer is looking at. */
              presented: own.presentedAt !== null && own.status === 'PENDING',
              queuePosition: own.status === 'PENDING' ? ahead + 1 : 0,
            }
          : null,
      });
    }
    return { items };
  }

  /**
   * An inspector names their price, and it joins the order's queue.
   *
   * The row is written UNPRESENTED (`presentedAt: null`) whatever else is going
   * on, and the queue decides afterwards whether it is the one the
   * customer sees. That split is what lets a cheaper price arrive while a dearer
   * one is already on the screen without either write having to know about the
   * other.
   */
  async create(
    orderId: string,
    userId: string,
    input: { payoutCents: number; reason: string },
  ): Promise<{
    id: string;
    payoutCents: number;
    priceCents: number;
    platformFeeCents: number;
    expiresAt: string;
    /** 1 when this price is the one the customer is being shown (DEN-350). */
    queuePosition: number;
    presented: boolean;
  }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    await this.assertInspectorMayOffer(order, userId);

    const distanceKm = await this.geo.distanceKmToOrder(userId, orderId);
    if (distanceKm === null) {
      throw new ConflictException({
        error: {
          code: 'inspector_location_missing',
          message: 'Set your base location before you name a price',
        },
      });
    }
    const radiusKm = await this.settings.getNumber('expertSearchRadiusKm');
    const profile = await this.prisma.inspectorProfile.findUnique({ where: { userId } });
    const reach = Math.min(radiusKm, profile?.searchRadiusKm ?? radiusKm);
    if (distanceKm > reach) {
      throw new ConflictException({
        error: { code: 'order_out_of_range', message: 'This order is outside the distance you accept' },
      });
    }

    const [multiplier, windowMinutes] = await Promise.all([
      this.settings.getNumber('counterOfferMaxMultiplier'),
      this.settings.getNumber('counterOfferWindowMinutes'),
    ]);
    const fair = await this.orders.fairPriceForInspector(order, userId, distanceKm);
    const maxPriceCents = counterOfferCeilingCents(fair.totalCents, multiplier);

    /*
     * The inspector typed what they will BE PAID (DEN-344). Everything that
     * follows - the bounds, the hold, the order's own total - is the CUSTOMER's
     * sum, so the first thing done with the figure is to convert it, once.
     * The fee is then the remainder, which is what makes the promise on the
     * form exact.
     */
    const platformFeePercent = await this.settings.getNumber('platformFeePercent');
    const priceCents = counterOfferTotalFromPayout(input.payoutCents, platformFeePercent);
    const platformFeeCents = priceCents - input.payoutCents;

    const priceError = counterOfferPriceError({
      priceCents,
      orderTotalCents: order.totalCents,
      maxPriceCents,
    });
    if (priceError) {
      throw new BadRequestException({
        error: {
          code: 'counter_offer_price_invalid',
          message: priceError,
          maxPriceCents,
          // Both units, because the form asks in one and the rule bounds the
          // other: an error naming only the customer's sum cannot be acted on.
          maxPayoutCents: counterOfferMaxPayoutCents(maxPriceCents, platformFeePercent),
        },
      });
    }

    const expiresAt = counterOfferExpiry(new Date(), windowMinutes, order.searchExpiresAt);
    if (!expiresAt) {
      throw new ConflictException({
        error: { code: 'order_search_expired', message: 'The search for this order has ended' },
      });
    }

    // Only the WRITE is guarded: a P2002 from anything after it means something
    // else entirely, and reporting it as "your price is already in" hides it.
    let created;
    try {
      created = await this.prisma.orderCounterOffer.upsert({
        // The unique key is (order, inspector): a second attempt after a failed
        // payment reuses the row rather than writing a second one.
        where: { orderId_inspectorId: { orderId, inspectorId: userId } },
        create: {
          orderId,
          inspectorId: userId,
          status: 'PENDING',
          priceCents,
          platformFeeCents,
          inspectorShareCents: input.payoutCents,
          maxPriceCents,
          reason: input.reason,
          straightLineKm: new Prisma.Decimal(distanceKm.toFixed(2)),
          round: order.dispatchRound,
          expiresAt,
          // Unpresented: the queue decides, not the order of arrival.
          presentedAt: null,
        },
        update: {
          status: 'PENDING',
          priceCents,
          platformFeeCents,
          inspectorShareCents: input.payoutCents,
          maxPriceCents,
          reason: input.reason,
          straightLineKm: new Prisma.Decimal(distanceKm.toFixed(2)),
          round: order.dispatchRound,
          expiresAt,
          acceptingUntil: null,
          respondedAt: null,
          // A re-priced offer re-enters the queue at its new price. Keeping the
          // old `presentedAt` would let an inspector whose payment failed hold
          // the screen at a price nobody has answered.
          presentedAt: null,
        },
      });
    } catch (e) {
      // P2002 here is the inspector's OWN row being written twice at once - a
      // double submit. Since DEN-350 it is no longer another expert winning a
      // slot: prices queue, so a second inspector is never a refusal.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          error: {
            code: 'counter_offer_already_sent',
            message: 'Your price for this order is already in.',
          },
        });
      }
      throw e;
    }

    await this.orders.writeEvent(orderId, userId, 'counter_offer_created', null, null, {
      counterOfferId: created.id,
      priceCents: created.priceCents,
      maxPriceCents,
      distanceKm,
    });

    // The customer is told by the queue, and only about the price they
    // are actually being shown. Notifying here would announce every queued
    // price - the auction the one-question rule exists to prevent.
    await this.queue.promote(orderId);

    // Re-read once: `promote` may have put this very price on the screen, which
    // rewrites `presentedAt` and `expiresAt` on the row written above.
    const current = await this.prisma.orderCounterOffer.findUnique({
      where: { id: created.id },
    });
    const queuePosition = await this.queuePositionOf(created.id);

    // All three figures, because the confirmation has to be able to repeat
    // the breakdown the inspector was shown before they sent it.
    return {
      id: created.id,
      payoutCents: created.inspectorShareCents,
      priceCents: created.priceCents,
      platformFeeCents: created.platformFeeCents,
      // The promoted deadline when this price went straight to the customer,
      // and the search-end backstop while it waits its turn.
      expiresAt: (current ?? created).expiresAt.toISOString(),
      queuePosition,
      presented: (current ?? created).presentedAt !== null,
    };
  }

  /**
   * Why this inspector may not name a price for this order.
   *
   * The eligibility rules are the dispatch rules, deliberately: a counter-offer
   * is a way into a job, so anybody who could not be offered the job by the
   * ordinary route must not be able to buy their way in.
   */
  private async assertInspectorMayOffer(order: Order, userId: string): Promise<void> {
    if (order.customerId === userId) {
      throw new ForbiddenException({
        error: {
          code: 'self_assignment_forbidden',
          message: 'You cannot offer a price for an inspection you ordered yourself',
        },
      });
    }
    // The trade opens only after the automatic search has failed a full round.
    // Without this an inspector could sit out the tariff and wait to be paid
    // more for every order, which is the failure mode the whole design avoids.
    //
    // Checked BEFORE the status, because a PAID order is the commonest way to
    // arrive here early and "this order is not waiting for an expert" is the
    // wrong thing to tell somebody watching a search that is still running.
    if (order.status === OrderStatus.PAID || order.dispatchRound < 1) {
      throw new ConflictException({
        error: {
          code: 'counter_offer_closed',
          message: 'The search is still running. You can name a price if it finds nobody.',
        },
      });
    }
    if (order.status !== OrderStatus.UNASSIGNED || order.inspectorId !== null) {
      throw new ConflictException({
        error: { code: 'order_not_open', message: 'This order is not waiting for an expert' },
      });
    }

    const [profile, user, declined, own] = await Promise.all([
      this.prisma.inspectorProfile.findUnique({ where: { userId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { kycVerified: true, bannedAt: true, deletedAt: true } }),
      this.prisma.orderOffer.findFirst({
        where: { orderId: order.id, inspectorId: userId, status: 'DECLINED' },
        select: { id: true },
      }),
      this.prisma.orderCounterOffer.findUnique({
        where: { orderId_inspectorId: { orderId: order.id, inspectorId: userId } },
        select: { status: true },
      }),
    ]);
    if (!profile || !user || user.bannedAt || user.deletedAt) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'You are not an inspector' },
      });
    }
    if (!user.kycVerified || !profile.stripeOnboarded) {
      throw new ForbiddenException({
        error: {
          code: 'inspector_not_verified',
          message: 'Finish verification and payout setup before you take orders',
        },
      });
    }
    if (!profile.available) {
      throw new ConflictException({
        error: { code: 'inspector_unavailable', message: 'Switch yourself to available first' },
      });
    }
    /*
     * ONE price per inspector per order, unless the money failed.
     *
     * The row is keyed `(order, inspector)` and `create` upserts it, which is
     * what lets a retry follow a failed payment: `abandonCounterOfferPayment`
     * puts the offer back to PENDING, so the second attempt writes over a live
     * row rather than opening a second negotiation.
     *
     * Every other ending is the CUSTOMER's answer, and it is final. Without
     * this an inspector refused at 190 could come back at 185, and again at
     * 180, and the customer who pressed "continue the search" would spend the
     * rest of the search answering the same expert. That is the auction the
     * whole design exists to prevent, arrived at one offer at a time.
     *
     * WITHDRAWN is not in the list, and deliberately: the inspector pulled that
     * offer themselves, or it was pulled for them when they took other work.
     * Nobody has answered it, so nobody is being asked twice.
     *
     * ACCEPTING is in the list, and it is not an "answer" at all - it is the
     * payment window. Without it the upsert in `create` rewrites the row the
     * customer is paying for: it goes back to PENDING and loses
     * `acceptingUntil`, which drops `counterOfferPaymentLock` and leaves the
     * PaymentIntent with nothing pointing at it. The pool then takes the order
     * underneath a customer who is entering a card.
     */
    const answered: Record<string, string> = {
      ACCEPTING: 'The customer is paying for your price. Wait for the answer.',
      DECLINED: 'You named a price for this order and the customer continued the search.',
      EXPIRED: 'Your price for this order expired without an answer.',
      SUPERSEDED: 'This order went to another expert at the tariff price.',
      ACCEPTED: 'Your price for this order was already accepted.',
    };
    if (own && answered[own.status]) {
      throw new ConflictException({
        error: { code: 'counter_offer_already_answered', message: answered[own.status] },
      });
    }
    if (declined) {
      throw new ConflictException({
        error: { code: 'order_declined', message: 'You refused this order already' },
      });
    }
  }

  /** The inspector takes their price back while it is still waiting. */
  async withdraw(counterOfferId: string, userId: string): Promise<{ orderId: string }> {
    const counter = await this.prisma.orderCounterOffer.findUnique({ where: { id: counterOfferId } });
    if (!counter) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Offer not found' } });
    }
    if (counter.inspectorId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your offer' } });
    }
    // ACCEPTING is out of reach on purpose: the customer is entering a card for
    // this price right now, and a withdrawal at that moment would either strand
    // their payment or take a job away from them after they paid for it.
    const done = await this.prisma.orderCounterOffer.updateMany({
      where: { id: counterOfferId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', respondedAt: new Date() },
    });
    if (done.count === 0) {
      throw new ConflictException({
        error: {
          code: 'counter_offer_not_pending',
          message: 'The customer is answering this offer already',
        },
      });
    }
    await this.orders.writeEvent(counter.orderId, userId, 'counter_offer_withdrawn', null, null, {
      counterOfferId,
      reason: 'withdrawn by inspector',
    });
    // The withdrawal may have been the price on the customer's screen. Show the
    // next one at once: the queue behind it is unaffected by this inspector
    // changing their mind.
    await this.queue.promote(counter.orderId);
    return { orderId: counter.orderId };
  }

  // ============================================================
  // The queue
  // ============================================================

  /**
   * Where this price stands in its order's queue, counting from 1.
   *
   * The presented offer is always 1, so an inspector is never told they are
   * "second" while the customer is looking at their price. Beyond that the
   * number is what the queue order says, and it is honest about being a
   * forecast: a cheaper price arriving later pushes everybody down.
   */
  private async queuePositionOf(counterOfferId: string): Promise<number> {
    const row = await this.prisma.orderCounterOffer.findUnique({
      where: { id: counterOfferId },
      select: { orderId: true, status: true, priceCents: true, createdAt: true, presentedAt: true },
    });
    if (!row || row.status !== 'PENDING') return 0;
    if (row.presentedAt) return 1;

    const ahead = await this.prisma.orderCounterOffer.count({
      where: {
        orderId: row.orderId,
        status: { in: ['PENDING', 'ACCEPTING'] },
        id: { not: counterOfferId },
        OR: [
          { presentedAt: { not: null } },
          { priceCents: { lt: row.priceCents } },
          { priceCents: row.priceCents, createdAt: { lt: row.createdAt } },
        ],
      },
    });
    return ahead + 1;
  }

  // ============================================================
  // Customer side
  // ============================================================

  /**
   * Every price waiting for an answer across ALL of this customer's orders
   * (DEN-346), for the card that sits above the list of orders.
   *
   * `PENDING` only, unlike `currentForCustomer`. An `ACCEPTING` offer is one
   * the customer has already answered and is paying for, and a summary card
   * that keeps calling for an answer is exactly the defect this closes.
   *
   * One query rather than one per order: a customer with a dozen orders would
   * otherwise cost the list page a dozen round trips to show, usually, nothing.
   */
  async pendingForCustomer(userId: string) {
    const rows = await this.prisma.orderCounterOffer.findMany({
      where: {
        status: 'PENDING',
        // Presented only (DEN-350). A queued price is not a question anybody
        // has been asked, and a card calling for an answer to one would put the
        // customer back in the auction this design refuses.
        presentedAt: { not: null },
        expiresAt: { gt: new Date() },
        order: { customerId: userId },
      },
      include: {
        order: { select: { id: true, number: true, make: true, model: true, totalCents: true, currency: true } },
        inspector: { select: { companyName: true, user: { select: { name: true } } } },
      },
      // Soonest to expire first: the card at the top is the one whose time is
      // shortest, not the one that happened to arrive first.
      orderBy: { expiresAt: 'asc' },
    });

    return {
      items: rows.map((counter) => ({
        id: counter.id,
        orderId: counter.order.id,
        orderNumber: counter.order.number,
        make: counter.order.make,
        model: counter.order.model,
        priceCents: counter.priceCents,
        orderTotalCents: counter.order.totalCents,
        currency: counter.order.currency,
        distanceKm: Number(counter.straightLineKm),
        expertName: counter.inspector.companyName ?? counter.inspector.user.name ?? null,
        expiresAt: counter.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * The one counter-offer waiting for this customer, or null.
   *
   * One, never a list: a customer answering an order should be answering a
   * question, not running an auction. Since DEN-350 there may be several prices
   * behind it, and the customer is told HOW MANY but never what they are -
   * a count is reassurance that saying no is safe, while a list of prices is the
   * auction again.
   */
  async currentForCustomer(orderId: string, userId: string) {
    const order = await this.requireCustomerOrder(orderId, userId);
    const counter = await this.prisma.orderCounterOffer.findFirst({
      where: {
        orderId: order.id,
        presentedAt: { not: null },
        status: { in: ['PENDING', 'ACCEPTING'] },
      },
      include: { inspector: { select: { companyName: true, user: { select: { name: true } } } } },
    });
    // An ACCEPTING row runs on `acceptingUntil`, not on `expiresAt`: the
    // customer already answered and is entering a card, and the answer window
    // stopped applying at that moment. Reading `expiresAt` here made the panel
    // go empty in the middle of a payment, with the money still in flight.
    const deadline = counter ? (counter.acceptingUntil ?? counter.expiresAt) : null;
    if (!counter || !deadline || deadline <= new Date()) return { counterOffer: null };

    const waiting = await this.prisma.orderCounterOffer.count({
      where: { orderId: order.id, status: 'PENDING', presentedAt: null },
    });

    return {
      counterOffer: {
        id: counter.id,
        priceCents: counter.priceCents,
        currency: order.currency,
        /** What the order pays now, so the customer can see the difference. */
        orderTotalCents: order.totalCents,
        distanceKm: Number(counter.straightLineKm),
        reason: counter.reason,
        // The inspector's name, never their contact details: those are
        // disclosed only when the order is COMPLETED.
        expertName: counter.inspector.companyName ?? counter.inspector.user.name ?? null,
        expiresAt: counter.expiresAt.toISOString(),
        status: counter.status,
        /**
         * How many more prices are queued behind this one, cheapest first. The
         * count, never the prices: it is there so "continue the search" reads
         * as a choice rather than as closing the last door.
         */
        queuedBehind: waiting,
      },
    };
  }

  /**
   * The customer accepts the price and starts paying it.
   *
   * This does NOT finish the handover — it opens a payment. The new hold has to
   * exist before the old one is released, so the last word belongs to
   * `OrdersService.finalizeCounterOfferPayment`, which the webhook calls when
   * the card answers.
   *
   * The order is locked against dispatch for `counterOfferPaymentMinutes` from
   * here. That is the one window where two parties could buy the same order.
   */
  async accept(
    orderId: string,
    counterOfferId: string,
    userId: string,
  ): Promise<{ paymentClientSecret: string | null; amountCents: number; mock?: true }> {
    const order = await this.requireCustomerOrder(orderId, userId);
    const counter = await this.prisma.orderCounterOffer.findUnique({ where: { id: counterOfferId } });
    if (!counter || counter.orderId !== order.id) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Offer not found' } });
    }
    if (order.status !== OrderStatus.UNASSIGNED || order.inspectorId !== null) {
      throw new ConflictException({
        error: {
          code: 'order_already_assigned',
          message: 'An expert has taken this order at its original price. Nothing was charged.',
        },
      });
    }

    // The inspector must still be free. They are allowed to take other work
    // while their price waits — refusing them that would make naming a price a
    // trap — so this is a real case and not a defensive check.
    const busy = await this.prisma.order.findFirst({
      where: {
        inspectorId: counter.inspectorId,
        status: { in: [OrderStatus.ASSIGNED, OrderStatus.EN_ROUTE, OrderStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
    if (busy) {
      await this.prisma.orderCounterOffer.updateMany({
        where: { id: counter.id, status: 'PENDING' },
        data: { status: 'WITHDRAWN', respondedAt: new Date() },
      });
      // The screen is free again, so the next price goes up before the customer
      // is told this one is gone.
      await this.queue.promote(order.id);
      throw new ConflictException({
        error: {
          code: 'counter_offer_inspector_busy',
          message: 'The expert is busy with another order. The offer is withdrawn and nothing was charged.',
        },
      });
    }

    const paymentMinutes = await this.settings.getNumber('counterOfferPaymentMinutes');
    const acceptingUntil = new Date(Date.now() + paymentMinutes * 60_000);

    // PENDING → ACCEPTING is the lock, and it is conditional so a double click
    // cannot open two payments. The loser joins the session the winner opened.
    // `presentedAt` is part of the guard: a customer must not be able to accept
    // a price still queued behind the one they were shown, whatever a stale
    // page or a hand-made request asks for.
    const claimed = await this.prisma.orderCounterOffer.updateMany({
      where: {
        id: counter.id,
        status: 'PENDING',
        presentedAt: { not: null },
        expiresAt: { gt: new Date() },
      },
      data: { status: 'ACCEPTING', acceptingUntil },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.orderCounterOffer.findUnique({ where: { id: counter.id } });
      if (current?.status === 'ACCEPTING') {
        const existing = await this.activeCounterPayment(order.id);
        if (existing) {
          return {
            paymentClientSecret: existing.clientSecret,
            amountCents: counter.priceCents,
            ...(existing.mock ? { mock: true as const } : {}),
          };
        }
      }
      throw new ConflictException({
        error: {
          code: 'counter_offer_unavailable',
          message: 'This offer is no longer waiting for an answer',
        },
      });
    }

    const payment = await this.prisma.payment.create({
      data: {
        purpose: COUNTER_OFFER_PAYMENT_PURPOSE,
        orderId: order.id,
        userId,
        amountCents: counter.priceCents,
        currency: order.currency,
        status: 'pending',
      },
    });

    await this.orders.writeEvent(order.id, userId, 'counter_offer_payment_started', null, null, {
      counterOfferId: counter.id,
      paymentId: payment.id,
      amountCents: counter.priceCents,
      acceptingUntil: acceptingUntil.toISOString(),
    });

    if (!this.stripe.configured) {
      // MOCK mode runs the same two-step shape: authorize, then let the
      // finalizer release the old hold and capture. A shortcut here would leave
      // the handover untested everywhere but the one suite with a fake Stripe.
      await this.orders.finalizeCounterOfferPayment(payment.id, order.id);
      return { paymentClientSecret: null, amountCents: counter.priceCents, mock: true };
    }

    const pi = await this.stripe.createOrderPaymentIntent({
      amountCents: counter.priceCents,
      orderId: order.id,
      paymentId: payment.id,
      userId,
      purpose: COUNTER_OFFER_PAYMENT_PURPOSE,
    });
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { stripePaymentIntentId: pi.id },
    });
    return { paymentClientSecret: pi.client_secret ?? null, amountCents: counter.priceCents };
  }

  /** The payment a customer already opened for this order, if it is still live. */
  private async activeCounterPayment(
    orderId: string,
  ): Promise<{ clientSecret: string | null; mock: boolean } | null> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        purpose: COUNTER_OFFER_PAYMENT_PURPOSE,
        supersededAt: null,
        status: { in: ['pending', 'failed'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;
    if (!this.stripe.configured) return { clientSecret: null, mock: true };
    if (!payment.stripePaymentIntentId) return null;
    const pi = await this.stripe.retrievePaymentIntent(payment.stripePaymentIntentId);
    return { clientSecret: pi.client_secret ?? null, mock: false };
  }

  /**
   * The customer says no. The search carries on and the hold is untouched — a
   * refusal costs the customer nothing and takes nothing away from the order.
   */
  async decline(orderId: string, counterOfferId: string, userId: string): Promise<{ orderId: string }> {
    const order = await this.requireCustomerOrder(orderId, userId);
    const counter = await this.prisma.orderCounterOffer.findUnique({ where: { id: counterOfferId } });
    if (!counter || counter.orderId !== order.id) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Offer not found' } });
    }
    const done = await this.prisma.orderCounterOffer.updateMany({
      where: { id: counter.id, status: 'PENDING', presentedAt: { not: null } },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    if (done.count === 0) {
      throw new ConflictException({
        error: {
          code: 'counter_offer_unavailable',
          message: 'This offer is no longer waiting for an answer',
        },
      });
    }

    await this.orders.writeEvent(order.id, userId, 'counter_offer_declined', null, null, {
      counterOfferId: counter.id,
      priceCents: counter.priceCents,
    });
    await this.notifications.notify(counter.inspectorId, 'counter_offer.declined', {
      orderId: order.id,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      priceCents: counter.priceCents,
    });
    // "Continue the search" is also "show me the next price" (DEN-350): the
    // next-cheapest queued offer goes up at once. Waiting for the sweep would
    // spend the search window on an empty screen, and the customer who just
    // said no is the one person certain to be looking at it.
    await this.queue.promote(order.id);
    return { orderId: order.id };
  }

  private async requireCustomerOrder(orderId: string, userId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    if (order.customerId !== userId) {
      throw new ForbiddenException({ error: { code: 'forbidden', message: 'Not your order' } });
    }
    return order;
  }

  // ============================================================
  // Sweeps
  // ============================================================

  /**
   * Close the counter-offers whose time ran out (DEN-344).
   *
   * Two deadlines, and they mean different things. An expired PENDING offer is
   * a customer who never answered: the offer ends and the slot frees. An
   * expired ACCEPTING is a customer who accepted and did not pay: the order is
   * still locked against the pool until this runs, so it also unlocks and
   * re-dispatches.
   */
  async sweepExpired(): Promise<{ expired: number; abandoned: number; presented: number }> {
    const now = new Date();

    const stalePayments = await this.prisma.orderCounterOffer.findMany({
      where: { status: 'ACCEPTING', acceptingUntil: { lte: now } },
      select: { orderId: true },
    });
    for (const { orderId } of stalePayments) {
      await this.orders
        .abandonCounterOfferPayment(orderId, 'payment window expired')
        .catch((e) => this.logger.error(`sweepExpired: order ${orderId}: ${String(e)}`));
    }

    // PRESENTED offers only. A queued price has not been asked of anybody, so
    // its creation-time deadline is a backstop and not an answer window - it is
    // rewritten when the offer reaches the screen, and expiring it here would
    // empty the queue of every price the customer has not got to yet.
    const expired = await this.prisma.orderCounterOffer.findMany({
      where: { status: 'PENDING', presentedAt: { not: null }, expiresAt: { lte: now } },
      include: { order: { select: { number: true, make: true, model: true } } },
    });
    if (expired.length) {
      await this.prisma.orderCounterOffer.updateMany({
        where: { id: { in: expired.map((c) => c.id) }, status: 'PENDING' },
        data: { status: 'EXPIRED', respondedAt: now },
      });
      for (const counter of expired) {
        await this.notifications.notify(counter.inspectorId, 'counter_offer.expired', {
          orderId: counter.orderId,
          orderNumber: counter.order.number,
          make: counter.order.make,
          model: counter.order.model,
          priceCents: counter.priceCents,
        });
      }
    }

    // Every order whose screen this sweep just cleared gets its next price.
    // `abandonCounterOfferPayment` promotes its own, so only the expiries are
    // collected here.
    for (const orderId of new Set(expired.map((c) => c.orderId))) {
      await this.queue.promote(orderId).catch((e) =>
        this.logger.error(`sweepExpired: promote ${orderId}: ${String(e)}`),
      );
    }

    // And the orders whose collection window ended with nothing to end it:
    // prices waiting on a screen that was free the whole time (DEN-351).
    const { presented } = await this.queue.sweepCollected().catch((e) => {
      this.logger.error(`sweepExpired: sweepCollected: ${String(e)}`);
      return { presented: 0 };
    });

    return { expired: expired.length, abandoned: stalePayments.length, presented };
  }
}
