import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { collectionHoldUntil, counterOfferExpiry } from './counter-offer-rules';

/**
 * The queue read, in one place: cheapest first, earliest wins a tie (DEN-350).
 * `compareQueuedOffers` is the same rule for rows already in memory.
 */
const QUEUE_ORDER: Prisma.OrderCounterOfferOrderByWithRelationInput[] = [
  { priceCents: 'asc' },
  { createdAt: 'asc' },
];

/**
 * Who gets shown to the customer next (DEN-350).
 *
 * Its own service, and a deliberately small one, because BOTH sides call it:
 * `CounterOffersService` when a price is named, declined or withdrawn, and
 * `OrdersService` when a payment is abandoned or an assignment closes the
 * prices an order was carrying. `CounterOffersService` depends on
 * `OrdersService` and must keep doing so, so a method living in either of them
 * would have made the dependency a cycle.
 *
 * It therefore depends on nothing but storage, settings and notifications.
 */
@Injectable()
export class CounterOfferQueueService {
  private readonly logger = new Logger(CounterOfferQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Put the best waiting price in front of the customer, if the screen is free.
   *
   * "Best" is the cheapest, and "the screen is free" means no ACCEPTING row and
   * no PENDING row that has already been presented. Both conditions are read
   * and then re-asserted in the write, because this is called from every path
   * that ends an offer and two of those can run at once - a sweep and a
   * decline, most obviously.
   *
   * Idempotent by design: calling it when nothing needs promoting is the normal
   * case and costs one indexed read.
   */
  async promote(orderId: string): Promise<{ promotedId: string | null }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    // An assigned or cancelled order has no screen to put a price on. Its rows
    // are closed by `settleCounterOffersOnAssignment`, not here.
    if (!order || order.status !== OrderStatus.UNASSIGNED || order.inspectorId !== null) {
      return { promotedId: null };
    }

    const now = new Date();
    const occupied = await this.prisma.orderCounterOffer.findFirst({
      where: {
        orderId,
        OR: [
          { status: 'ACCEPTING' },
          { status: 'PENDING', presentedAt: { not: null }, expiresAt: { gt: now } },
        ],
      },
      select: { id: true },
    });
    if (occupied) return { promotedId: null };

    /*
     * The collection window (DEN-351). It applies to the FIRST price an order
     * ever shows and to nothing else, so the test is "has this order ever had a
     * price on the screen" - `presentedAt` survives a decline or an expiry, so
     * one row with it set is proof that the window is over for good.
     */
    const everPresented = await this.prisma.orderCounterOffer.findFirst({
      where: { orderId, presentedAt: { not: null } },
      select: { id: true },
    });
    if (!everPresented) {
      const first = await this.prisma.orderCounterOffer.aggregate({
        where: { orderId, status: 'PENDING' },
        _min: { createdAt: true },
      });
      const firstOfferAt = first._min.createdAt;
      if (firstOfferAt) {
        const collectMinutes = await this.settings.getNumber('counterOfferCollectMinutes');
        const heldUntil = collectionHoldUntil(
          now,
          firstOfferAt,
          collectMinutes,
          order.searchExpiresAt,
        );
        // Nobody re-calls this when the window ends, so `sweepCollected` does.
        if (heldUntil) return { promotedId: null };
      }
    }

    const windowMinutes = await this.settings.getNumber('counterOfferWindowMinutes');

    // Cheapest first. A queued row whose creation-time deadline has passed is
    // NOT skipped: that deadline was only the search-end backstop, and the
    // answer window is computed fresh below, when the price is actually asked.
    const next = await this.prisma.orderCounterOffer.findFirst({
      where: { orderId, status: 'PENDING', presentedAt: null },
      orderBy: QUEUE_ORDER,
    });
    if (!next) return { promotedId: null };

    const expiresAt = counterOfferExpiry(now, windowMinutes, order.searchExpiresAt);
    if (!expiresAt) {
      // No time left in the search: nothing in the queue can be answered, so
      // close it rather than presenting a price that dies on arrival.
      await this.prisma.orderCounterOffer.updateMany({
        where: { orderId, status: 'PENDING', presentedAt: null },
        data: { status: 'EXPIRED', respondedAt: now },
      });
      return { promotedId: null };
    }

    try {
      const claimed = await this.prisma.orderCounterOffer.updateMany({
        where: { id: next.id, status: 'PENDING', presentedAt: null },
        data: { presentedAt: now, expiresAt },
      });
      if (claimed.count === 0) return { promotedId: null };
    } catch (e) {
      // P2002 on `order_counter_offer_presented_unique`: another promotion won
      // the screen between the read above and this write. Nothing is wrong -
      // the customer has a price, which is the whole point - and this offer
      // stays queued for its turn.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { promotedId: null };
      }
      throw e;
    }

    /*
     * The one order event written outside `OrdersService.writeEvent`, and the
     * reason is the dependency direction above: reaching that method from here
     * is the cycle this service exists to avoid. The shape is identical, and it
     * is a single call rather than a second timeline.
     */
    await this.prisma.orderEvent.create({
      data: {
        orderId,
        actor: next.inspectorId,
        type: 'counter_offer_presented',
        payload: {
          counterOfferId: next.id,
          priceCents: next.priceCents,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });

    await this.notifications.notify(order.customerId, 'counter_offer.received', {
      orderId,
      orderNumber: order.number,
      make: order.make,
      model: order.model,
      priceCents: next.priceCents,
      orderTotalCents: order.totalCents,
      distanceKm: Number(next.straightLineKm),
      reason: next.reason,
      windowMinutes,
      expiresAt: expiresAt.toISOString(),
    });

    return { promotedId: next.id };
  }

  /**
   * Present the orders whose collection window has just ended (DEN-351).
   *
   * The window ends by the clock and not by an event, so nothing would call
   * `promote` again on its own: the last price may have arrived nine minutes
   * before the window closed, and the customer would wait for a refusal that
   * can never come. This runs on the same sweep as the expiries.
   *
   * It re-reads the window rather than trusting the query, because `promote` is
   * the one place that decides: this only narrows the candidates to orders that
   * have a queue and nothing on the screen.
   */
  async sweepCollected(): Promise<{ presented: number }> {
    const collectMinutes = await this.settings.getNumber('counterOfferCollectMinutes');
    const cutoff = new Date(Date.now() - Math.max(0, collectMinutes) * 60_000);

    const waiting = await this.prisma.orderCounterOffer.groupBy({
      by: ['orderId'],
      where: { status: 'PENDING', presentedAt: null, createdAt: { lte: cutoff } },
    });

    let presented = 0;
    for (const { orderId } of waiting) {
      const { promotedId } = await this.promote(orderId).catch((e) => {
        this.logger.error(`sweepCollected: order ${orderId}: ${String(e)}`);
        return { promotedId: null };
      });
      if (promotedId) presented += 1;
    }
    return { presented };
  }

  /** Promote and swallow: for callers whose own work must not fail on this. */
  async promoteQuietly(orderId: string): Promise<void> {
    await this.promote(orderId).catch((e) =>
      this.logger.error(`promote: order ${orderId}: ${String(e)}`),
    );
  }
}
