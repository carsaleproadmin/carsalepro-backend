/**
 * A local copy of one PRODUCTION listing page, for working on its layout.
 *
 * The showroom pages that local seed data produces are self-declared cars with
 * one photo, so the parts of the detail page that only a REPORT-backed listing
 * has — the verified badge, the quality score, the report code, the gallery —
 * could not be seen at all while editing them. This script writes one listing
 * that carries all of it, with the field values of
 * https://www.carsalepro.de/ru/cars/cmsloosjc0034vc1xbnd63zot.
 *
 * Idempotent: fixed ids, so a re-run rewrites the same rows and the URL of the
 * page never changes.
 *
 * NOTHING IS UPLOADED. The gallery manifest points at photo objects that
 * already exist in the bucket — the keys of other seeded listings — so the page
 * has real images and this script performs no write outside the local database.
 * That also means the two listings share the pictures; the seeded ones are
 * throwaway rows and keep their own copies.
 *
 * The report PDF is NOT real. `s3Key` names an object that does not exist, so
 * unlocking the full report will fail to download. Everything the DETAIL PAGE
 * renders is present; the paid artefact behind it is not.
 *
 *   npx tsx scripts/demo-showroom-listing.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const LISTING_ID = 'demo-prod-golf-vii';
const REPORT_ID = 'demo-prod-golf-vii-report';
const SELLER_EMAIL = 'demo-seller@carsalepro.local';
const DEMO_REPORT_CODE = 'CSP-11111111-2222-4333-8444-555555555555';
/** How many pictures the gallery gets. The detail page shows up to 40. */
const PHOTO_COUNT = 12;

async function main(): Promise<void> {
  const seller = await prisma.user.upsert({
    where: { email: SELLER_EMAIL },
    update: {},
    create: {
      email: SELLER_EMAIL,
      name: 'Demo Seller',
      locale: 'ru',
      countryCode: 'DE',
      emailVerified: new Date(),
    },
  });

  /*
   * Borrowed keys, oldest first so a re-run picks the same ones. Rows of the
   * demo listing itself are excluded — it has none, but a future edit that
   * gives it some must not feed them back into its own manifest.
   */
  const borrowed = await prisma.listingPhoto.findMany({
    where: { listingId: { not: LISTING_ID } },
    orderBy: { createdAt: 'asc' },
    take: PHOTO_COUNT,
    select: { r2Key: true },
  });
  if (borrowed.length === 0) {
    throw new Error(
      'No photo objects to point at. Seed the showroom first — without them the gallery would be empty.',
    );
  }

  /*
   * `kind` drives the ORDER of the gallery (`comparePhotoKinds`) and the angle
   * label under each picture, so the slots are named as the mobile app names
   * them rather than left blank.
   */
  const kinds = [
    'exterior-front',
    'exterior-front-left',
    'exterior-left',
    'exterior-rear-left',
    'exterior-rear',
    'exterior-rear-right',
    'exterior-right',
    'exterior-front-right',
    'interior-1',
    'interior-2',
    'odometer',
    'vin',
  ];
  const photosManifest = borrowed.map((row, i) => ({
    s3Key: row.r2Key,
    kind: kinds[i % kinds.length],
  }));

  const vehicle = {
    vin: 'WVWZZZAUZJW123456',
    make: 'Volkswagen',
    model: 'Golf VII 2.0 TDI',
    year: 2018,
    mileageKm: 86420,
    color: 'silver',
    bodyType: 'hatchback',
    driveType: 'fwd',
  };

  /*
   * Enough of a payload for the free half of the paywall to have something to
   * print: a damage count and a paint-thickness average. The numbers are
   * plausible for the car, and nothing here is shown as a FINDING — the free
   * block prints counts and an average, never which panel.
   */
  const reportData = {
    damages: [
      { partId: 'bumper_front', type: 'scratch', severity: 'minor' },
      { partId: 'door_rear_left', type: 'dent', severity: 'minor' },
      { partId: 'wheel_fl', type: 'kerb_rash', severity: 'minor' },
    ],
    thickness: {
      panels: [
        { panelId: 'hood', um: 118 },
        { panelId: 'roof', um: 124 },
        { panelId: 'door_front_left', um: 131 },
        { panelId: 'door_rear_left', um: 205 },
        { panelId: 'fender_rear_right', um: 127 },
        { panelId: 'trunk', um: 121 },
      ],
    },
  };

  await prisma.report.upsert({
    where: { id: REPORT_ID },
    update: { code: DEMO_REPORT_CODE, qualityScore: 100, photosManifest, reportData },
    create: {
      id: REPORT_ID,
      deviceId: 'demo-device',
      /*
       * A CSP code is `CSP-<uuid>` and the public preview endpoint validates
       * the shape, so a readable "demo" code answers 400 rather than a report.
       * Fixed, not generated: the URL of the demo page must not change.
       */
      code: DEMO_REPORT_CODE,
      tier: 'pro',
      // Names an object that does not exist: see the header.
      s3Key: `reports/${REPORT_ID}/report.pdf`,
      uploaded: true,
      qualityScore: 100,
      inspectedAt: new Date('2026-08-09T10:00:00Z'),
      finishedAt: new Date('2026-08-09T12:00:00Z'),
      userId: seller.id,
      photosManifest,
      reportData,
      ...vehicle,
    },
  });

  const listing = {
    sellerId: seller.id,
    reportId: REPORT_ID,
    source: 'report',
    status: 'ACTIVE' as const,
    package: 'standard',
    priceCents: 1_850_000,
    city: 'Berlin',
    countryCode: 'DE',
    plz: '10119',
    description: 'Mit unabhaengigem CarSalePro-Gutachten. Audit-Test 2026-08-09.',
    contactPhone: '+49307654321',
    contactEmail: 'demo-client@carsalepro.local',
    fuelType: 'diesel',
    transmission: 'manual',
    powerKw: 110,
    firstRegistration: new Date('2018-03-14T00:00:00Z'),
    huValidUntil: '2026-08',
    publishedAt: new Date(),
    ...vehicle,
  };

  await prisma.listing.upsert({
    where: { id: LISTING_ID },
    update: listing,
    create: { id: LISTING_ID, ...listing },
  });

  console.log(`Listing ready with ${photosManifest.length} photos:`);
  console.log(`  http://localhost:3000/ru/cars/${LISTING_ID}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
