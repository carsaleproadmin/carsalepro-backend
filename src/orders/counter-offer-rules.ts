/**
 * Counter-offer rules (DEN-344) — a pure module, free of Nest and Prisma, so
 * the arithmetic and the refusals can be tested exhaustively.
 *
 * A counter-offer is the ONE way an order's total can go up. Dispatch prices
 * every candidate on the distance the order was quoted on, so an inspector
 * further away than the priced one is paid for a drive they did not make; and a
 * candidate whose price exceeds the authorized sum is skipped in silence,
 * which is how an order with willing inspectors dies as "no experts available".
 * This module decides how much such an inspector may ask.
 */

/**
 * `Payment.purpose` for the authorization a counter-offer creates.
 *
 * A separate value from 'order' and not a flag, because the webhook routes on
 * it: an `amount_capturable_updated` for an ordinary order means "the search
 * may start", and for this one it means "release the old hold and assign the
 * inspector". Routing both through one purpose would have the ordinary handler
 * run against an order that is long past CREATED and do nothing at all,
 * silently.
 */
export const COUNTER_OFFER_PAYMENT_PURPOSE = 'order_counter_offer';

/** The counter-offer states that are still in play on an order. */
export const ACTIVE_COUNTER_OFFER_STATUSES = ['PENDING', 'ACCEPTING'] as const;

/**
 * The queue order (DEN-350): cheapest first, and the earlier price wins a tie.
 *
 * The customer is shown one price at a time, and which one is the whole
 * question. Showing the first to arrive gave the order to the fastest hand: an
 * inspector asking 90 beat one willing to work for 55, and nothing ever told
 * the customer the cheaper price had existed. Sorting by price makes the answer
 * the customer gets the best one available, and makes "next" mean "the next
 * best", not "the next one to have pressed a button".
 *
 * `createdAt` breaks the tie rather than the id, because two identical prices
 * are genuinely equal on the only axis that matters and the earlier inspector
 * has waited longer.
 */
export function compareQueuedOffers(
  a: { priceCents: number; createdAt: Date },
  b: { priceCents: number; createdAt: Date },
): number {
  if (a.priceCents !== b.priceCents) return a.priceCents - b.priceCents;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * When the collection window over an order's first prices ends (DEN-351).
 *
 * The queue sorts what it HAS, and at the start it has one price: the first
 * inspector to answer. That inspector is usually the nearest one, and the
 * nearest one is not the cheapest - a high price from next door reached the
 * customer minutes before a low price from the next town, and became the whole
 * of the customer's impression of what the inspection now costs.
 *
 * So the first price is held rather than shown, and the queue is given time to
 * fill. When the window ends the cheapest of what arrived goes on the screen.
 * It costs the customer some minutes and it saves them the worst first
 * question.
 *
 * Only the FIRST presentation waits. After a refusal the other prices are
 * already in hand, and holding them again would only add silence.
 *
 * Returns null when nothing should be held: no window configured, the window
 * has passed, or the search ends first - a hold that outlived the order would
 * throw away every price to save the customer from one of them.
 */
export function collectionHoldUntil(
  now: Date,
  firstOfferAt: Date,
  collectMinutes: number,
  searchExpiresAt: Date | null,
): Date | null {
  if (!Number.isFinite(collectMinutes) || collectMinutes <= 0) return null;
  const until = new Date(firstOfferAt.getTime() + collectMinutes * 60_000);
  if (until.getTime() <= now.getTime()) return null;
  if (searchExpiresAt && searchExpiresAt.getTime() <= until.getTime()) return null;
  return until;
}

export type CounterOfferStatus =
  | 'PENDING'
  | 'ACCEPTING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'WITHDRAWN'
  | 'SUPERSEDED';

/**
 * The ceiling: the fair price of THIS inspector's trip, times the platform
 * multiplier.
 *
 * The fair price is the order re-priced on the inspector's own distance and
 * base fee — what the customer would have been quoted if this inspector had
 * been the nearest one. The multiplier is the room on top of it, and it exists
 * because the fair price is measured on a straight line: the road is longer,
 * and an awkward address costs more than its kilometres say.
 *
 * Rounded rather than floored so the ceiling never lands a cent below a figure
 * the inspector can see us display.
 */
export function counterOfferCeilingCents(fairPriceCents: number, multiplier: number): number {
  const safeMultiplier = Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : 1;
  return Math.round(Math.max(0, fairPriceCents) * safeMultiplier);
}

/**
 * The customer's total that pays an inspector exactly `payoutCents` (DEN-344).
 *
 * The inspector names what they will BE PAID, not what the customer pays: a
 * price the platform then takes a cut of is a price that means nothing to the
 * person typing it, and it was being typed against a ceiling expressed in the
 * other unit. So the arithmetic is inverted here, and the promise on the form
 * - "you receive exactly this" - is exact.
 *
 * The platform fee is the REMAINDER, `total - payout`, and not a second
 * rounding of the percentage. Rounding both ends independently loses or invents
 * a cent, and the cent it loses would come out of the number the inspector was
 * promised. The effective percentage therefore moves by up to a cent on a
 * single order, which is the correct thing to give up.
 *
 * A percentage at or above 100 is refused by returning the payout unchanged
 * (a zero fee): it is a misconfiguration, and dividing by zero or a negative
 * would answer with an infinite or inverted price.
 */
export function counterOfferTotalFromPayout(
  payoutCents: number,
  platformFeePercent: number,
): number {
  const payout = Math.max(0, Math.round(payoutCents));
  const pct =
    Number.isFinite(platformFeePercent) && platformFeePercent > 0 && platformFeePercent < 100
      ? platformFeePercent
      : 0;
  if (pct === 0) return payout;
  return Math.round(payout / (1 - pct / 100));
}

/**
 * The inverse, for showing a bound the inspector types against: the payout that
 * a given customer total leaves.
 *
 * Deliberately NOT the exact inverse of {@link counterOfferTotalFromPayout} to
 * the cent - rounding twice cannot be. It is used for the ceiling and the
 * floor, where a cent either way is invisible, and never to compute money that
 * is stored.
 */
export function counterOfferPayoutFromTotal(
  totalCents: number,
  platformFeePercent: number,
): number {
  const total = Math.max(0, Math.round(totalCents));
  const pct =
    Number.isFinite(platformFeePercent) && platformFeePercent > 0 && platformFeePercent < 100
      ? platformFeePercent
      : 0;
  return total - Math.round((total * pct) / 100);
}

/**
 * The largest payout that still fits under a ceiling expressed as a customer
 * total.
 *
 * This is NOT `counterOfferPayoutFromTotal` of the ceiling, and the difference
 * matters: rounding twice can land a cent high, so the figure the form shows as
 * "you may receive up to X" would be refused the moment it was typed back. The
 * bound is therefore checked against the same conversion the service uses, and
 * lowered until it holds - at most a cent or two, so the loop is bounded by its
 * own arithmetic rather than by a guard.
 */
export function counterOfferMaxPayoutCents(
  ceilingTotalCents: number,
  platformFeePercent: number,
): number {
  let payout = counterOfferPayoutFromTotal(ceilingTotalCents, platformFeePercent);
  while (payout > 0 && counterOfferTotalFromPayout(payout, platformFeePercent) > ceilingTotalCents) {
    payout -= 1;
  }
  return Math.max(0, payout);
}

export interface CounterOfferPriceInput {
  /** What the inspector asks. */
  priceCents: number;
  /** The order's own total — the sum currently authorized on the card. */
  orderTotalCents: number;
  /** The ceiling from {@link counterOfferCeilingCents}. */
  maxPriceCents: number;
}

/**
 * Why this price cannot be asked, or null when it can.
 *
 * Both bounds are refusals with a reason the inspector can act on, because the
 * alternative — clamping — would quietly change the number a person typed and
 * then charge a customer for it.
 *
 * The LOWER bound is not a rounding guard. A price at or below the order's own
 * total is a price dispatch could have offered on its own: the inspector fits
 * the hold, so they will be asked in the ordinary way, and letting them jump
 * the queue by "offering" the price they were going to be given anyway turns
 * the trade into a bidding war over orders that never needed one.
 */
export function counterOfferPriceError(input: CounterOfferPriceInput): string | null {
  const { priceCents, orderTotalCents, maxPriceCents } = input;
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    return 'The price must be a positive amount in cents';
  }
  if (priceCents <= orderTotalCents) {
    return 'The price is not more than the order pays, so the order can be offered to you in the usual way';
  }
  if (priceCents > maxPriceCents) {
    return `The price is more than the maximum of ${maxPriceCents} cents for this order`;
  }
  return null;
}

/**
 * How long a counter-offer may wait for the customer, held inside the order's
 * own search deadline.
 *
 * The search window is the whole of the order's life: past it the hold is
 * released and the order is cancelled. A counter-offer that outlived it would
 * let a customer accept a price for an order that no longer exists — and, worse,
 * would keep the customer's screen shut against the rest of the queue for the
 * last minutes of a search that could still have found somebody at the tariff.
 *
 * Called TWICE per offer since DEN-350: once at creation, where it is only the
 * search-end backstop for a price nobody is looking at yet, and again at
 * promotion, where it starts the answer window. A queued price must not spend
 * its minutes waiting its turn.
 *
 * Returns null when there is no time left at all, which is the caller's signal
 * to refuse the counter-offer rather than to write one that expires at once.
 */
export function counterOfferExpiry(
  now: Date,
  windowMinutes: number,
  searchExpiresAt: Date | null,
): Date | null {
  const wanted = new Date(now.getTime() + windowMinutes * 60_000);
  if (!searchExpiresAt) return wanted;
  if (searchExpiresAt.getTime() <= now.getTime()) return null;
  return searchExpiresAt < wanted ? searchExpiresAt : wanted;
}
