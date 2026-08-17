/**
 * Stage a LONG-DISTANCE order you can accept by hand, to see DEN-118/DEN-113.
 *
 *   npx ts-node scripts/demo-distant-order.ts
 *   npx ts-node scripts/demo-distant-order.ts --km=140      # 100 | 110 | 140
 *   npx ts-node scripts/demo-distant-order.ts --inspector-radius=50 --solo
 *   npx ts-node scripts/demo-distant-order.ts --setup-only   # you place the order
 *
 * DEVELOPMENT DATA ONLY. It writes users, resets their passwords to a printed
 * literal, moves an inspector's base location and places a paid order. Point it
 * at production and you have published a password for a real account.
 *
 * What it leaves you with: an order roughly 100-140 km from the inspector,
 * PAID, with the hold in place and a PENDING offer sitting in the inspector's
 * cabinet. You sign in as the inspector and press Accept — which captures the
 * money for real (in Stripe TEST mode) and moves the order to ASSIGNED. That
 * last step is deliberately left to you: the point of the exercise is seeing
 * the acceptance work at a distance the platform refused outright yesterday.
 *
 * Three things it has to do that a browser would not:
 *
 * 1. CONFIRM THE PAYMENT INTENT with a Stripe test card. The website confirms
 *    it in the browser with Stripe Elements. An unconfirmed intent cannot be
 *    captured, so pressing Accept would fail on a card that was never presented.
 * 2. RUN THE WEBHOOK'S WORK ITSELF. `payment_intent.amount_capturable_updated`
 *    is what takes the order to PAID, starts the search window and dispatches.
 *    Locally that webhook only arrives under `stripe listen`, so the script
 *    calls `authorizeOrderPayment` — the same entry point the reconciler uses
 *    when the webhook is lost. If you ARE running `stripe listen`, the call is
 *    idempotent and costs nothing.
 * 3. PARK THE OTHER INSPECTORS, with `--solo`. A dev database holds more than
 *    one eligible inspector — the e2e fixture sits at the same Berlin point
 *    with a 300 km radius — so narrowing the demo inspector's radius proves
 *    nothing while somebody else picks the job up. `--solo` sets every other
 *    profile `available = false` and prints how to put them back.
 * 4. MOVE THE INSPECTOR. The demo inspector was left in Kyiv by an earlier
 *    tariff experiment, so the script pins the base location every run.
 *
 * Walked end to end on 2026-08-14 at 139 km of road: the offer arrived, Accept
 * captured the money in Stripe test mode (payment `succeeded`) and the order
 * reached ASSIGNED. Before DEN-118 that quote was refused `too_far`.
 */
import { NestFactory } from '@nestjs/core';
import { hash } from '@node-rs/argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { GeoService } from '../src/geo/geo.service';
import { SettingsService } from '../src/settings/settings.service';
import { StripeService } from '../src/payments/stripe.service';
import Stripe from 'stripe';

/** The inspector's base: Berlin Mitte, the same point the e2e fixture uses. */
const INSPECTOR = { lat: 52.5244, lng: 13.4105 };

/**
 * Where the vehicle is. Fixed coordinates rather than an address string, so the
 * demonstration does not depend on the geocoder answering the same way twice.
 *
 * The keys are ROAD kilometres from the inspector's base, measured against the
 * dev routing provider on 2026-08-14 — the cap is a road number, so a demo
 * keyed on straight-line distance would be showing the wrong quantity. All
 * three were refused outright before DEN-118: the cap was 100 km.
 */
const PLACES: Record<string, { lat: number; lng: number; label: string }> = {
  // 103 km road / 74 km straight
  '100': { lat: 53.0758, lng: 12.8, label: 'Wittstock' },
  // 112 km road / 90 km straight
  '110': { lat: 51.8662, lng: 12.6501, label: 'Lutherstadt Wittenberg' },
  // 139 km road / 112 km straight
  '140': { lat: 51.7189, lng: 12.4256, label: 'Bitterfeld' },
};

const CUSTOMER_EMAIL = 'demo.kunde@carsalepro.test';
const INSPECTOR_EMAIL = 'demo.pruefer@carsalepro.test';
const PASSWORD = 'DemoPass123!';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} EUR`;
}

async function main(): Promise<void> {
  const km = arg('km', '110');
  const place = PLACES[km];
  if (!place) {
    throw new Error(`--km must be one of ${Object.keys(PLACES).join(', ')} (road kilometres)`);
  }
  const inspectorRadiusKm = Number(arg('inspector-radius', '300'));
  const solo = process.argv.includes('--solo');
  /*
   * Prepare the two accounts and the inspector, and stop.
   *
   * For the version of this test where YOU place the order in the browser: the
   * accounts, the base location, the radius and the APPROVED KYC application
   * are the parts a person cannot reasonably set up by hand, and the order is
   * the part worth doing by hand.
   */
  const setupOnly = process.argv.includes('--setup-only');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const orders = app.get(OrdersService);
  const geo = app.get(GeoService);
  const settings = app.get(SettingsService);
  const stripe = app.get(StripeService);

  const passwordHash = await hash(PASSWORD);

  // ------------------------------------------------------------ the two users
  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    create: {
      email: CUSTOMER_EMAIL,
      passwordHash,
      name: 'Demo Kunde',
      emailVerified: new Date(),
    },
    update: { passwordHash, emailVerified: new Date() },
  });

  const inspectorUser = await prisma.user.upsert({
    where: { email: INSPECTOR_EMAIL },
    create: {
      email: INSPECTOR_EMAIL,
      passwordHash,
      name: 'Demo Pruefer',
      emailVerified: new Date(),
      kycVerified: true,
    },
    update: { passwordHash, emailVerified: new Date(), kycVerified: true },
  });

  // Eligibility is four separate facts and dispatch checks all of them; a demo
  // that sets three and forgets `available` looks like the radius is broken.
  await prisma.inspectorProfile.upsert({
    where: { userId: inspectorUser.id },
    create: {
      userId: inspectorUser.id,
      companyName: 'Demo Gutachter GmbH',
      baseAddress: 'Torstraße 1, 10119 Berlin',
      searchRadiusKm: inspectorRadiusKm,
      available: true,
      stripeOnboarded: true,
    },
    update: { searchRadiusKm: inspectorRadiusKm, available: true, stripeOnboarded: true },
  });
  await geo.setInspectorLocation(inspectorUser.id, INSPECTOR.lat, INSPECTOR.lng);

  /*
   * An APPROVED KYC application, separately from `user.kycVerified`.
   *
   * Dispatch reads the user flag, but the WEBSITE gates all six operational
   * inspector pages on `requireVerifiedInspector`, which wants the application.
   * Without this the demo works perfectly at the API and bounces you to the
   * onboarding wizard the moment you try to click Accept — which reads as the
   * offer never having arrived. No documents are attached: the row is what the
   * gate reads, and inventing identity documents for a demo would be worse.
   */
  const kyc = await prisma.kycApplication.findFirst({ where: { userId: inspectorUser.id } });
  if (kyc) {
    await prisma.kycApplication.update({
      where: { id: kyc.id },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });
  } else {
    await prisma.kycApplication.create({
      data: {
        userId: inspectorUser.id,
        status: 'APPROVED',
        submittedAt: new Date(),
        reviewedAt: new Date(),
      },
    });
  }

  if (solo) {
    const parked = await prisma.inspectorProfile.updateMany({
      where: { userId: { not: inspectorUser.id }, available: true },
      data: { available: false },
    });
    console.log(
      `--solo: parked ${parked.count} other inspector(s). Put them back with:\n` +
        `  psql "$DATABASE_URL" -c 'update inspector_profile set available = true;'`,
    );
  }

  const ceiling = await settings.getNumber('expertSearchRadiusKm');
  const cap = await settings.getNumber('orderCapKm');

  if (setupOnly) {
    console.log('');
    console.log(`Platform ceiling ${await settings.getNumber('expertSearchRadiusKm')} km straight-line, cap ${await settings.getNumber('orderCapKm')} km road.`);
    console.log(`Inspector radius ${inspectorRadiusKm} km, base Berlin Mitte (Torstraße 1).`);
    console.log('');
    console.log(`Customer   ${CUSTOMER_EMAIL} / ${PASSWORD}`);
    console.log(`Inspector  ${INSPECTOR_EMAIL} / ${PASSWORD}`);
    console.log('');
    console.log('Order an inspection at one of these, all beyond the old 100 km cap:');
    for (const [road, p] of Object.entries(PLACES)) {
      console.log(`  ${p.label} — about ${road} km of road`);
    }
    await app.close();
    return;
  }

  // ------------------------------------------------------------------ a quote
  const scheduledAt = new Date(Date.now() + 48 * 3600_000).toISOString();
  const quote = await orders.quote(customer.id, {
    lat: place.lat,
    lng: place.lng,
    scheduledAt,
  });

  console.log('');
  console.log(`Platform ceiling ${ceiling} km straight-line, cap ${cap} km road.`);
  console.log(`Inspector radius ${inspectorRadiusKm} km, base Berlin Mitte.`);
  console.log(`Vehicle at ${place.label}.`);
  console.log('');

  if (!quote.available) {
    // The refusal is the interesting outcome for `--inspector-radius=50`, so it
    // is reported as a result rather than as a failure.
    console.log(`REFUSED: ${quote.refusal}`);
    console.log(
      quote.refusal === 'too_far'
        ? 'Beyond the cap: the platform does not serve this distance.'
        : 'No candidate: the distance is served, but nobody has agreed to drive it.',
    );
    await app.close();
    return;
  }

  console.log(`Road distance  ${quote.breakdown?.distanceKm} km one direction`);
  console.log(`Billed         ${quote.breakdown?.billedDistanceKm} km, both ways, minus the free radius`);
  console.log(`Total          ${eur(quote.totalCents ?? 0)}`);
  console.log(`  travel       ${eur(quote.breakdown?.distanceFeeCents ?? 0)}`);
  console.log(`  time         ${eur(quote.breakdown?.timeFeeCents ?? 0)}`);
  console.log(`  base         ${eur(quote.breakdown?.baseFeeCents ?? 0)}`);
  console.log('');

  // ------------------------------------------------------------- the order
  const created = await orders.createOrder(customer.id, {
    make: 'BMW',
    model: '320d',
    address: `${place.label}, Deutschland`,
    lat: place.lat,
    lng: place.lng,
    scheduledAt,
  });

  const payment = await prisma.payment.findUnique({ where: { orderId: created.orderId } });
  if (!payment) throw new Error('the order was created without a payment row');

  if (stripe.configured && payment.stripePaymentIntentId) {
    // A real test-mode intent with `capture_method: manual`. Confirming it with
    // a test card puts it in `requires_capture`, which is what Accept needs.
    //
    // The SDK is used directly rather than through `StripeService`: a
    // confirm-with-a-test-card helper on the production service is a method
    // nothing but a demo may ever call, and the safest place for it is outside
    // the service entirely.
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    if (!key.startsWith('sk_test')) {
      throw new Error('refusing to confirm a payment with a key that is not sk_test');
    }
    const sdk = new Stripe(key);
    await sdk.paymentIntents.confirm(payment.stripePaymentIntentId, {
      payment_method: 'pm_card_visa',
      // The intent is created with the Dashboard's method set, which includes
      // redirect-based ones, and Stripe refuses a server-side confirm without
      // somewhere to send the customer back to. Nothing redirects here — a test
      // card confirms in one call — but the parameter is still mandatory.
      return_url: 'http://localhost:3002/ru/account/orders',
    });
  }
  // Idempotent: does nothing if `stripe listen` already delivered the webhook.
  await orders.authorizeOrderPayment(payment.id, created.orderId);

  const order = await prisma.order.findUnique({ where: { id: created.orderId } });
  const offer = await prisma.orderOffer.findFirst({
    where: { orderId: created.orderId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  // WHO holds the offer is the point of the exercise, and on a dev database it
  // is not necessarily the demo account: dispatch offers the nearest eligible
  // inspector, and there are others. Printing the email is what turns "an offer
  // exists" into "this person may accept it".
  const holder = offer
    ? await prisma.user.findUnique({ where: { id: offer.inspectorId }, select: { email: true } })
    : null;

  console.log(`Order ${order?.number}  status ${order?.status}  payment ${payment.purpose}`);
  console.log(
    offer
      ? `Offer PENDING with ${holder?.email ?? offer.inspectorId}, ${offer.straightLineKm ?? '?'} km straight-line, expires ${offer.expiresAt.toISOString()}`
      : 'NO OFFER — dispatch found no candidate. Check the radii printed above.',
  );
  console.log('');
  console.log('Now do the last step yourself:');
  console.log(`  1. open  http://localhost:3002/ru/signin`);
  console.log(`  2. sign in as  ${INSPECTOR_EMAIL} / ${PASSWORD}`);
  console.log(`  3. open  http://localhost:3002/ru/inspector/orders  and press Accept`);
  console.log('');
  console.log(`The customer side is  ${CUSTOMER_EMAIL} / ${PASSWORD}`);
  console.log(`  http://localhost:3002/ru/account/orders/${created.orderId}`);
  console.log('');
  console.log('Accepting CAPTURES the hold (Stripe test mode) and moves the order to ASSIGNED.');

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
