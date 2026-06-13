/**
 * Seed: platform settings (doc 07 §4), an admin user, and legal-template stubs.
 * Idempotent — safe to run repeatedly (upserts by key/email).
 * The admin password is set by the auth module (E1); the row is created here so
 * the ADMIN role exists from the start.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLATFORM_SETTING_DEFAULTS: Record<string, number> = {
  orderBaseFeeEur: 50,
  orderRatePerKmEur: 1.5,
  platformFeePercent: 20,
  payPerViewPriceEur: 14.99,
  goldPackagePriceEur: 9.99,
  standardListingPriceEur: 0,
  listingDurationDays: 30,
  expertSearchRadiusKm: 50,
  offerTimeoutMinutes: 60,
  autoApproveAfterDays: 7,
  refundBeforeAssignPercent: 100,
  refundAfterAssignPercent: 80,
  signedUrlTtlMinutes: 15,
};

const LEGAL_STUBS = [
  { key: 'contract_de', locale: 'de', title: 'Vermittlungs- und Begutachtungsvertrag (DE)' },
  { key: 'contract_eu', locale: 'en', title: 'Inspection brokerage agreement (EU)' },
  { key: 'contract_en', locale: 'en', title: 'Inspection brokerage agreement (EN)' },
];

async function main(): Promise<void> {
  for (const [key, value] of Object.entries(PLATFORM_SETTING_DEFAULTS)) {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: {}, // do not overwrite admin-tuned values on reseed
    });
  }
  console.log(`Seeded ${Object.keys(PLATFORM_SETTING_DEFAULTS).length} platform settings`);

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@carsalepro.com';
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: 'Platform Admin',
      role: 'ADMIN',
      emailVerified: new Date(),
      locale: 'de',
      countryCode: 'DE',
    },
    update: { role: 'ADMIN' },
  });
  console.log(`Ensured admin user: ${adminEmail}`);

  for (const stub of LEGAL_STUBS) {
    await prisma.legalTemplate.upsert({
      where: { key_version: { key: stub.key, version: 1 } },
      create: {
        key: stub.key,
        version: 1,
        locale: stub.locale,
        title: stub.title,
        bodyMd: `# ${stub.title}\n\n_Draft — pending legal review (E10)._\n`,
        active: true,
      },
      update: {},
    });
  }
  console.log(`Ensured ${LEGAL_STUBS.length} legal template stubs`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
