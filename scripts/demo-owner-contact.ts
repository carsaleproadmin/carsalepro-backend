/**
 * Stage two ASSIGNED orders to see the owner-contact step (DEN-291).
 *
 *   npx ts-node scripts/demo-owner-contact.ts
 *
 * DEVELOPMENT DATA ONLY. It writes users, resets their passwords to a printed
 * literal and captures a payment in Stripe TEST mode. It refuses to run when
 * DATABASE_URL does not point at localhost.
 *
 * What it leaves you with: two orders in ASSIGNED, both assigned to the demo
 * inspector. One carries a seller phone number, one a listing link, so the
 * inspector order page shows both forms of the "Listing contact details" card
 * and the two answer buttons.
 *
 * The orders are assigned with `adminAssign`, not through an offer: a dev
 * database holds other eligible inspectors, and the dispatcher can send the
 * offer to any of them. `adminAssign` captures the money like an acceptance
 * does and expires the other pending offers.
 */
import { NestFactory } from '@nestjs/core';
import { hash } from '@node-rs/argon2';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { GeoService } from '../src/geo/geo.service';
import { StripeService } from '../src/payments/stripe.service';

/** The inspector's base: Berlin Mitte, the same point the other demos use. */
const INSPECTOR = { lat: 52.5244, lng: 13.4105 };

const CARS = [
  {
    make: 'Volkswagen',
    model: 'Golf',
    address: 'Alexanderplatz 1, 10178 Berlin',
    lat: 52.5219,
    lng: 13.4132,
    listingUrl: '+49 30 1234567',
  },
  {
    make: 'Audi',
    model: 'A4 Avant',
    address: 'Kastanienallee 1, 10435 Berlin',
    lat: 52.5388,
    lng: 13.4094,
    listingUrl: 'https://suchen.mobile.de/fahrzeuge/details.html?id=123456789',
  },
];

const CUSTOMER_EMAIL = 'demo.kunde@carsalepro.test';
const INSPECTOR_EMAIL = 'demo.pruefer@carsalepro.test';
const ADMIN_EMAIL = 'demo.admin@carsalepro.test';
const PASSWORD = 'DemoPass123!';
const WEB = 'http://localhost:3000/ru';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
    throw new Error('refusing to run: DATABASE_URL is not a localhost database');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const orders = app.get(OrdersService);
  const geo = app.get(GeoService);
  const stripe = app.get(StripeService);

  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin) throw new Error(`no admin ${ADMIN_EMAIL} in this database`);

  const passwordHash = await hash(PASSWORD);
  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    create: { email: CUSTOMER_EMAIL, passwordHash, name: 'Demo Kunde', emailVerified: new Date() },
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
  await prisma.inspectorProfile.upsert({
    where: { userId: inspectorUser.id },
    create: {
      userId: inspectorUser.id,
      companyName: 'Demo Gutachter GmbH',
      baseAddress: 'Torstraße 1, 10119 Berlin',
      searchRadiusKm: 300,
      available: true,
      stripeOnboarded: true,
    },
    update: { available: true, stripeOnboarded: true },
  });
  await geo.setInspectorLocation(inspectorUser.id, INSPECTOR.lat, INSPECTOR.lng);
  // The operational inspector pages require an APPROVED KYC application.
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

  console.log('');
  for (const car of CARS) {
    const created = await orders.createOrder(customer.id, car);
    const payment = await prisma.payment.findUnique({ where: { orderId: created.orderId } });
    if (!payment) throw new Error('the order was created without a payment row');

    // The website confirms the intent in the browser with Stripe Elements. An
    // unconfirmed intent cannot be captured, so the script confirms it here.
    if (stripe.configured && payment.stripePaymentIntentId) {
      const key = process.env.STRIPE_SECRET_KEY ?? '';
      if (!key.startsWith('sk_test')) {
        throw new Error('refusing to confirm a payment with a key that is not sk_test');
      }
      await new Stripe(key).paymentIntents.confirm(payment.stripePaymentIntentId, {
        payment_method: 'pm_card_visa',
        return_url: `${WEB}/account/orders`,
      });
    }
    // The webhook's work. Locally the webhook arrives only under `stripe listen`;
    // the call is idempotent when it does arrive.
    await orders.authorizeOrderPayment(payment.id, created.orderId);
    await orders.adminAssign(created.orderId, inspectorUser.id, admin.id);

    const order = await prisma.order.findUnique({ where: { id: created.orderId } });
    console.log(`${order?.number}  ${car.make} ${car.model}  ${order?.status}`);
    console.log(`  contact    ${car.listingUrl}`);
    console.log(`  inspector  ${WEB}/inspector/orders/${created.orderId}`);
    console.log(`  customer   ${WEB}/account/orders/${created.orderId}`);
    console.log('');
  }

  console.log(`Inspector  ${INSPECTOR_EMAIL} / ${PASSWORD}`);
  console.log(`Customer   ${CUSTOMER_EMAIL} / ${PASSWORD}`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
