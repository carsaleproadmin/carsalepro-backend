/**
 * Stage one order per deadline-badge state, so DEN-280 can be looked at.
 *
 *   npx ts-node scripts/demo-deadline-badges.ts           # stage, or restamp
 *   npx ts-node scripts/demo-deadline-badges.ts --clean   # remove them again
 *
 * Run it again whenever the badges have run down: the deadlines are relative to
 * the moment of the run, and a re-run moves them forward on the same six rows.
 *
 * DEVELOPMENT DATA ONLY. It writes users and resets their password to a printed
 * literal, exactly as `demo-distant-order.ts` does. Point it at production and
 * you have published a password for a real account.
 *
 * WHAT IT DOES NOT DO: money. Every other demo script confirms a Stripe test
 * card and calls `authorizeOrderPayment`, because the thing being demonstrated
 * is the payment path. The badge reads two timestamps and nothing else, so
 * these orders are written straight to the database with no Payment row - which
 * also means they can be staged without `stripe listen` running. Do not accept
 * or cancel one of them in the UI: those paths reach for a payment that is not
 * there. Look at them, and delete them with --clean.
 *
 * The six rows, all for one inspector (`demo.pruefer@carsalepro.test`):
 *
 *   Incoming offers      offer expires in 55 min   neutral
 *                        offer expires in 22 min   T1
 *                        offer expires in 6 min    T3
 *   Active orders        deadline in 5 days        no badge at all
 *                        deadline in 2 days        T1
 *                        deadline in 9 hours       T3
 *
 * The fourth row is not padding: "further out than three days shows nothing" is
 * a decision, and the only way to see a decision like that is beside the rows
 * where the badge does appear.
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GeoService } from '../src/geo/geo.service';

const CUSTOMER_EMAIL = 'demo.kunde@carsalepro.test';
const INSPECTOR_EMAIL = 'demo.pruefer@carsalepro.test';
const PASSWORD = 'DemoPass123!';

/** Berlin Mitte - the point the e2e fixture and the other demo scripts use. */
const INSPECTOR = { lat: 52.5244, lng: 13.4105 };

/** Every row this script writes carries the marker, so --clean can find them. */
const MARKER = 'DEN-280 demo';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Row {
  make: string;
  model: string;
  address: string;
  lat: number;
  lng: number;
  /** PAID + a PENDING offer, or an accepted order with a start deadline. */
  kind: 'offer' | 'assigned';
  status: 'PAID' | 'ASSIGNED' | 'EN_ROUTE';
  /** Milliseconds from now to the deadline. */
  inMs: number;
  note: string;
}

const ROWS: Row[] = [
  {
    make: 'BMW', model: '320d', address: 'Kastanienallee 12, 10435 Berlin',
    lat: 52.5379, lng: 13.4113, kind: 'offer', status: 'PAID',
    inMs: 55 * MIN, note: 'offer, 55 min left - neutral',
  },
  {
    make: 'Audi', model: 'A4 Avant', address: 'Warschauer Straße 8, 10243 Berlin',
    lat: 52.5075, lng: 13.4494, kind: 'offer', status: 'PAID',
    inMs: 22 * MIN, note: 'offer, 22 min left - T1',
  },
  {
    make: 'VW', model: 'Passat', address: 'Hauptstraße 30, 10827 Berlin',
    lat: 52.4841, lng: 13.3554, kind: 'offer', status: 'PAID',
    inMs: 6 * MIN, note: 'offer, 6 min left - T3',
  },
  {
    make: 'Mercedes-Benz', model: 'C 200', address: 'Frankfurter Allee 90, 10247 Berlin',
    lat: 52.5153, lng: 13.4692, kind: 'assigned', status: 'ASSIGNED',
    inMs: 5 * DAY, note: 'inspection, 5 days left - NO badge (too far out)',
  },
  {
    make: 'Skoda', model: 'Octavia', address: 'Bergmannstraße 5, 10961 Berlin',
    lat: 52.4885, lng: 13.3925, kind: 'assigned', status: 'ASSIGNED',
    inMs: 2 * DAY, note: 'inspection, 2 days left - T1',
  },
  {
    make: 'Opel', model: 'Astra', address: 'Müllerstraße 140, 13353 Berlin',
    lat: 52.5507, lng: 13.3556, kind: 'assigned', status: 'EN_ROUTE',
    inMs: 9 * HOUR, note: 'inspection, 9 hours left - T3',
  },
];

async function main(): Promise<void> {
  const clean = process.argv.includes('--clean');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const geo = app.get(GeoService);

  if (clean) {
    const orders = await prisma.order.findMany({
      where: { listingUrl: MARKER },
      select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    await prisma.orderOffer.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
    console.log(`Removed ${ids.length} demo order(s).`);
    await app.close();
    return;
  }

  const passwordHash = await hash(PASSWORD);
  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    create: { email: CUSTOMER_EMAIL, passwordHash, name: 'Demo Kunde', emailVerified: new Date() },
    update: { passwordHash, emailVerified: new Date() },
  });
  const inspectorUser = await prisma.user.upsert({
    where: { email: INSPECTOR_EMAIL },
    create: {
      email: INSPECTOR_EMAIL, passwordHash, name: 'Demo Pruefer',
      emailVerified: new Date(), kycVerified: true,
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

  /*
   * The APPROVED KYC application, for the same reason `demo-distant-order.ts`
   * writes one: the six operational inspector pages are gated on it, so without
   * this row the orders list is a redirect to the onboarding wizard and the
   * badges cannot be seen at all.
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

  const now = Date.now();
  console.log('');
  for (const [i, row] of ROWS.entries()) {
    const id = randomUUID();
    const number = `ORD-D28${i}`;
    const deadline = new Date(now + row.inMs);
    // Flat money. The split has to add up because the row prints the
    // inspector's share, but nothing here is a priced quote.
    const total = 12_900;
    const share = Math.round(total * 0.8);
    await prisma.$executeRaw`
      INSERT INTO "order" (
        id, number, customer_id, inspector_id, status, make, model, listing_url, address,
        location, scheduled_at, country_code,
        base_fee_cents, distance_km, distance_fee_cents, total_cents,
        platform_fee_cents, inspector_share_cents, currency,
        inspection_deadline_at, "createdAt"
      ) VALUES (
        ${id}, ${number}, ${customer.id},
        ${row.kind === 'assigned' ? inspectorUser.id : null},
        ${row.status}::"OrderStatus",
        ${row.make}, ${row.model}, ${MARKER}, ${row.address},
        ST_SetSRID(ST_MakePoint(${row.lng}, ${row.lat}), 4326)::geography,
        ${new Date(now + 2 * DAY)}, 'DE',
        3900, 25, 1500, ${total}, ${total - share}, ${share}, 'EUR',
        ${row.kind === 'assigned' ? deadline : null}, ${new Date()}
      )
      ON CONFLICT (number) DO NOTHING
    `;
    /*
     * A re-run RESTAMPS the clocks rather than leaving the row alone. A six
     * minute offer is dead six minutes after it is staged, so a script that
     * only inserted would show its most interesting badge exactly once and
     * then stop. Every run makes the same six rows live again.
     */
    const written = await prisma.order.findUnique({ where: { number }, select: { id: true } });
    if (!written) throw new Error(`Could not write ${number}`);
    await prisma.order.update({
      where: { id: written.id },
      data: {
        status: row.status,
        scheduledAt: new Date(now + 2 * DAY),
        inspectionDeadlineAt: row.kind === 'assigned' ? deadline : null,
      },
    });
    if (row.kind === 'offer') {
      await prisma.orderOffer.deleteMany({ where: { orderId: written.id } });
      await prisma.orderOffer.create({
        data: {
          orderId: written.id,
          inspectorId: inspectorUser.id,
          status: 'PENDING',
          expiresAt: deadline,
        },
      });
    }
    console.log(`  ${number}  ${row.make} ${row.model.padEnd(12)} ${row.note}`);
  }

  console.log('');
  console.log(`Sign in as  ${INSPECTOR_EMAIL} / ${PASSWORD}`);
  console.log('Then open   /de/inspector/orders');
  console.log('Remove with npx ts-node scripts/demo-deadline-badges.ts --clean');
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
