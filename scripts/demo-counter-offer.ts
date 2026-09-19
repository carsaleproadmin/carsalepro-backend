/**
 * Stage and walk a COUNTER-OFFER end to end (DEN-344).
 *
 *   npx ts-node scripts/demo-counter-offer.ts
 *   npx ts-node scripts/demo-counter-offer.ts --setup-only   # accounts only
 *   npx ts-node scripts/demo-counter-offer.ts --browser      # stop where the
 *       trade opens, and leave the order there, so the rest is walked in the
 *       browser: the inspector names a price, the customer answers it.
 *   npx ts-node scripts/demo-counter-offer.ts --keep         # leave the data behind
 *
 * DEVELOPMENT DATA ONLY. It writes users, resets their passwords to a printed
 * literal, moves inspector base locations and places a paid order.
 *
 * What it demonstrates, in the order the code does it:
 *
 *   1. an order is quoted on the NEAREST inspector and the hold is that figure;
 *   2. the nearest one refuses, and every remaining candidate costs more than
 *      the hold - the dead end the whole ticket exists for;
 *   3. a far, dearer inspector names a price, bounded by the fair price of
 *      THEIR trip times `counterOfferMaxMultiplier`;
 *   4. a second inspector cannot name one while that offer waits;
 *   5. the customer accepts, a NEW authorization replaces the old one, and the
 *      order is assigned at the new price with both payment rows kept.
 *
 * Two things it has to do that a browser would not, for the same reasons
 * `demo-distant-order.ts` lists:
 *
 *  - CONFIRM THE PAYMENT INTENT with a Stripe test card, and run the webhook's
 *    work itself (`authorizeOrderPayment`), because locally that webhook only
 *    arrives under `stripe listen`.
 *  - PARK THE OTHER INSPECTORS. A dev database holds eligible inspectors from
 *    the e2e fixtures sitting at the same Berlin point, and one of them picking
 *    the job up at the tariff price is a correct outcome that demonstrates
 *    nothing about the trade.
 *
 * Without a Stripe key the service runs in mock mode and the whole walk still
 * works: the handover resolves in our own ledger, which is the same two-step
 * shape the webhook drives.
 */
import { NestFactory } from '@nestjs/core';
import { hash } from '@node-rs/argon2';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { CounterOffersService } from '../src/orders/counter-offers.service';
import { GeoService } from '../src/geo/geo.service';
import { SettingsService } from '../src/settings/settings.service';
import { StripeService } from '../src/payments/stripe.service';
import { OrderStatus } from '@prisma/client';

/** Berlin Mitte - the vehicle, and the cheap inspector who is standing on it. */
const VEHICLE = { lat: 52.5244, lng: 13.4105 };
/** Brandenburg an der Havel: far enough that the trip is worth real money. */
const FAR = { lat: 52.4125, lng: 12.5316 };
/** A second far inspector, to prove the slot is exclusive. */
const FAR_2 = { lat: 52.3906, lng: 12.4855 };

const CUSTOMER_EMAIL = 'demo.gegen.kunde@carsalepro.test';
const NEAR_EMAIL = 'demo.gegen.nah@carsalepro.test';
const FAR_EMAIL = 'demo.gegen.fern@carsalepro.test';
const FAR_2_EMAIL = 'demo.gegen.fern2@carsalepro.test';
const PASSWORD = 'DemoPass123!';

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} EUR`;
}

function step(n: number, title: string): void {
  console.log('');
  console.log(`── ${n}. ${title}`);
}

async function main(): Promise<void> {
  const setupOnly = process.argv.includes('--setup-only');
  const browser = process.argv.includes('--browser');
  // A browser walk always leaves the order behind - it IS the thing to walk.
  const keep = process.argv.includes('--keep') || browser;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const orders = app.get(OrdersService);
  const counterOffers = app.get(CounterOffersService);
  const geo = app.get(GeoService);
  const settings = app.get(SettingsService);
  const stripe = app.get(StripeService);

  const passwordHash = await hash(PASSWORD);

  async function makeUser(email: string, name: string) {
    return prisma.user.upsert({
      where: { email },
      create: { email, passwordHash, name, emailVerified: new Date(), kycVerified: true },
      update: { passwordHash, emailVerified: new Date(), kycVerified: true },
    });
  }

  async function makeInspector(
    email: string,
    name: string,
    at: { lat: number; lng: number },
    baseFeeCents: number | null,
  ) {
    const user = await makeUser(email, name);
    await prisma.inspectorProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        companyName: name,
        baseAddress: 'Demo, Deutschland',
        searchRadiusKm: 300,
        available: true,
        stripeOnboarded: true,
        baseFeeCents,
      },
      update: { available: true, stripeOnboarded: true, baseFeeCents, searchRadiusKm: 300 },
    });
    await geo.setInspectorLocation(user.id, at.lat, at.lng);
    return user;
  }

  const customer = await makeUser(CUSTOMER_EMAIL, 'Demo Kunde');
  // The platform base is the default; leaving the fee null is what "has not
  // said" means, and it is what makes this one the cheapest candidate.
  const near = await makeInspector(NEAR_EMAIL, 'Demo Nah GmbH', VEHICLE, null);
  const far = await makeInspector(FAR_EMAIL, 'Demo Fern GmbH', FAR, 18_000);
  const far2 = await makeInspector(FAR_2_EMAIL, 'Demo Fern Zwei GmbH', FAR_2, 20_000);

  const parked = await prisma.inspectorProfile.updateMany({
    where: { userId: { notIn: [near.id, far.id, far2.id] }, available: true },
    data: { available: false },
  });

  const [multiplier, windowMinutes] = await Promise.all([
    settings.getNumber('counterOfferMaxMultiplier'),
    settings.getNumber('counterOfferWindowMinutes'),
  ]);

  console.log('');
  console.log(`Stripe        ${stripe.configured ? 'configured (test mode)' : 'MOCK mode'}`);
  console.log(`Ceiling       fair price x ${multiplier}`);
  console.log(`Answer window ${windowMinutes} minutes`);
  console.log(`Parked        ${parked.count} other inspector(s)`);
  console.log(`Customer      ${CUSTOMER_EMAIL} / ${PASSWORD}`);
  console.log(`Far inspector ${FAR_EMAIL} / ${PASSWORD}`);

  if (setupOnly) {
    console.log('');
    console.log('Setup only. Place an inspection at Berlin Mitte in the browser.');
    await app.close();
    return;
  }

  // ------------------------------------------------------------------ 1. quote
  step(1, 'The quote, and the hold');
  const created = await orders.createOrder(customer.id, {
    make: 'BMW',
    model: '320d',
    listingUrl: '+49 30 1234567',
    address: 'Torstraße 1, 10119 Berlin',
    lat: VEHICLE.lat,
    lng: VEHICLE.lng,
  });
  const orderId = created.orderId;

  const payment = await prisma.payment.findFirstOrThrow({
    where: { orderId, supersededAt: null },
  });
  if (stripe.configured && payment.stripePaymentIntentId) {
    const client = new Stripe(process.env.STRIPE_SECRET_KEY as string);
    await client.paymentIntents.confirm(payment.stripePaymentIntentId, {
      payment_method: 'pm_card_visa',
      return_url: 'https://carsalepro.net/demo',
    });
    // The webhook's own work, for a machine that is not running `stripe listen`.
    await orders.authorizeOrderPayment(payment.id, orderId);
  }

  const quoted = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  console.log(`Order         ${quoted.number}`);
  console.log(`Priced on     the nearest inspector (Demo Nah, 0 km)`);
  console.log(`Hold          ${eur(quoted.totalCents)}`);

  // -------------------------------------------------------------- 2. dead end
  step(2, 'The nearest inspector refuses, and nobody else fits the hold');
  const offer = await prisma.orderOffer.findFirst({
    where: { orderId, status: 'PENDING' },
  });
  if (offer) {
    await orders.declineOffer(offer.id, offer.inspectorId);
  }
  // One round is what opens the trade, and dispatch has just walked the pool.
  await prisma.order.update({
    where: { id: orderId },
    data: { dispatchRound: { increment: 1 } },
  });
  const stalled = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  console.log(`Status        ${stalled.status} (round ${stalled.dispatchRound})`);
  console.log(
    stalled.status === OrderStatus.UNASSIGNED
      ? 'Nobody left: every other candidate costs more than the authorized sum.'
      : 'Somebody else took it - park more inspectors and run again.',
  );
  if (stalled.status !== OrderStatus.UNASSIGNED) {
    await app.close();
    return;
  }

  if (browser) {
    // Everything from here on is what the two cabinets do. Print the numbers
    // the inspector's card will show, so the screen can be checked against
    // them rather than believed.
    const forInspector = await counterOffers.listOpenForInspector(far.id);
    const card = forInspector.items.find((i) => i.orderId === orderId);
    console.log('');
    console.log('Walk the rest in the browser:');
    console.log(`  Inspector  ${FAR_EMAIL} / ${PASSWORD}`);
    console.log('             Orders -> "Below my rate" -> name a price');
    console.log(`  Customer   ${CUSTOMER_EMAIL} / ${PASSWORD}`);
    console.log(`             Orders -> ${quoted.number} -> accept or refuse`);
    console.log('');
    console.log(`  Pays them     ${eur(card?.orderPayoutCents ?? 0)}  (customer ${eur(card?.orderTotalCents ?? 0)})`);
    console.log(`  Fair for them ${eur(card?.fairPayoutCents ?? 0)}`);
    console.log(`  May be paid   ${eur(card?.maxPayoutCents ?? 0)}  (customer pays ${eur(card?.maxPriceCents ?? 0)})`);
    console.log('');
    console.log('  Card 4242 4242 4242 4242, any future date, any CVC.');
    console.log(
      `  \`stripe listen --forward-to localhost:${process.env.PORT ?? 3000}/webhooks/stripe\``,
    );
    console.log('  must be running, or the new hold never reaches us and the');
    console.log('  order stays where it is.');
    await app.close();
    return;
  }

  // ------------------------------------------------------- 3. the trade opens
  step(3, 'The far inspector sees it, and what they may ask');
  const list = await counterOffers.listOpenForInspector(far.id);
  const row = list.items.find((i) => i.orderId === orderId);
  if (!row) throw new Error('the order is not in the far inspector’s list');
  console.log(`Distance      ${row.distanceKm} km straight line`);
  // Every figure the inspector sees is what THEY are paid (DEN-344); the
  // customer's sums are printed beside them because the trade changes both.
  console.log(`Pays them     ${eur(row.orderPayoutCents)}  (customer ${eur(row.orderTotalCents)})`);
  console.log(`Fair for them ${eur(row.fairPayoutCents)}  (customer ${eur(row.fairPriceCents)})`);
  console.log(`May ask up to ${eur(row.maxPayoutCents)}  (customer ${eur(row.maxPriceCents)})`);

  const payout = Math.round((row.orderPayoutCents + row.fairPayoutCents) / 2);
  const counter = await counterOffers.create(orderId, far.id, {
    payoutCents: payout,
    reason: `The car is ${row.distanceKm} km from me, the order is priced for 0 km.`,
  });
  const price = counter.priceCents;
  console.log(
    `Named         ${eur(payout)} for themselves; the customer is asked ${eur(price)} ` +
      `(platform ${eur(counter.platformFeeCents)})`,
  );
  console.log(`Waiting until ${counter.expiresAt}`);

  // ------------------------------------------------------- 4. the slot is one
  step(4, 'A second inspector cannot name a price while that one waits');
  try {
    await counterOffers.create(orderId, far2.id, {
      payoutCents: payout + 100,
      reason: 'I can go as well.',
    });
    console.log('REFUSED NOTHING - the exclusivity rule is broken');
  } catch (e) {
    const code = (e as { response?: { error?: { code?: string } } })?.response?.error?.code;
    console.log(`Refused       ${code ?? 'unknown'}`);
  }

  // ------------------------------------------------------ 5. the customer pays
  step(5, 'The customer accepts, and the authorization is replaced');
  const current = await counterOffers.currentForCustomer(orderId, customer.id);
  console.log(`Customer sees ${eur(current.counterOffer?.priceCents ?? 0)} instead of ${eur(quoted.totalCents)}`);
  console.log(`Reason        ${current.counterOffer?.reason}`);

  const accept = await counterOffers.accept(orderId, counter.id, customer.id);
  if (accept.paymentClientSecret && stripe.configured) {
    const client = new Stripe(process.env.STRIPE_SECRET_KEY as string);
    const replacement = await prisma.payment.findFirstOrThrow({
      where: { orderId, purpose: 'order_counter_offer', supersededAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await client.paymentIntents.confirm(replacement.stripePaymentIntentId as string, {
      payment_method: 'pm_card_visa',
      return_url: 'https://carsalepro.net/demo',
    });
    // Again the webhook's work: this is the entry point that releases the old
    // hold, captures the new one and assigns the inspector.
    await orders.finalizeCounterOfferPayment(replacement.id, orderId);
  }

  const done = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const payments = await prisma.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });

  console.log('');
  console.log(`Status        ${done.status}`);
  console.log(`Assigned to   ${done.inspectorId === far.id ? 'the far inspector' : done.inspectorId}`);
  console.log(`Order total   ${eur(done.totalCents)} (was ${eur(quoted.totalCents)})`);
  console.log(`  platform    ${eur(done.platformFeeCents)}`);
  console.log(`  inspector   ${eur(done.inspectorShareCents)}`);
  console.log('');
  console.log('Payments on the order, oldest first:');
  for (const p of payments) {
    console.log(
      `  ${eur(p.amountCents).padStart(10)}  ${p.status.padEnd(10)}  ` +
        `${p.supersededAt ? 'superseded' : 'LIVE'}  ${p.purpose}`,
    );
  }

  const events = await prisma.orderEvent.findMany({
    where: { orderId, type: { startsWith: 'counter_offer' } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('');
  console.log('Counter-offer events:');
  for (const e of events) console.log(`  ${e.type}`);

  if (!keep) {
    await prisma.orderEvent.deleteMany({ where: { orderId } });
    await prisma.orderCounterOffer.deleteMany({ where: { orderId } });
    await prisma.orderOffer.deleteMany({ where: { orderId } });
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.orderContract.deleteMany({ where: { order: { id: orderId } } });
    await prisma.order.deleteMany({ where: { id: orderId } });
    console.log('');
    console.log('Demo order removed. Pass --keep to leave it in the cabinet.');
  }
  await prisma.inspectorProfile.updateMany({
    where: { userId: { notIn: [near.id, far.id, far2.id] } },
    data: { available: true },
  });

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
