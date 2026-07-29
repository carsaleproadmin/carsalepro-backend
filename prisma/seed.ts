/**
 * Seed: platform settings (doc 07 §4), an admin user, and legal-template stubs.
 * Idempotent — safe to run repeatedly (upserts by key/email).
 * The admin password is set by the auth module (E1); the row is created here so
 * the ADMIN role exists from the start.
 */
import { PrismaClient } from '@prisma/client';
import {
  CONTRACT_TEMPLATES,
  ContractKey,
  DRAFT_MARKER,
} from '../src/legal/legal-contracts.content';
import { PLATFORM_SETTING_DEFAULTS } from '../src/settings/platform-settings.constants';

const prisma = new PrismaClient();

// Imported, not re-declared: this map used to be a second copy of the defaults
// in src/settings/platform-settings.constants.ts, so every new key had to be
// added twice and silently failed to seed if it wasn't.

const CONTRACT_KEYS: ContractKey[] = ['contract_de', 'contract_eu', 'contract_en'];

/**
 * Self-healing, idempotent seed of the real contract content (E10).
 * For each key:
 *  - no version exists → create version 1 from CONTRACT_TEMPLATES (active);
 *  - the active version still carries the E10 DRAFT_MARKER → create a NEW version
 *    (max+1) with the real content, mark it active and deactivate the old stub;
 *  - the active version already has real content → leave it (don't clobber edits).
 */
async function seedContractTemplates(): Promise<void> {
  for (const key of CONTRACT_KEYS) {
    const tpl = CONTRACT_TEMPLATES[key];
    const active = await prisma.legalTemplate.findFirst({
      where: { key, active: true },
      orderBy: { version: 'desc' },
    });

    if (!active) {
      // No version at all → create version 1 with the real content.
      const existingAny = await prisma.legalTemplate.findFirst({
        where: { key },
        orderBy: { version: 'desc' },
      });
      const version = existingAny ? existingAny.version + 1 : 1;
      await prisma.legalTemplate.create({
        data: { key, version, locale: tpl.locale, title: tpl.title, bodyMd: tpl.bodyMd, active: true },
      });
      console.log(`  ${key}: created v${version} (real content)`);
      continue;
    }

    if (active.bodyMd.includes(DRAFT_MARKER)) {
      // Active version is still the E10 stub → publish a new real version.
      const max = await prisma.legalTemplate.findFirst({
        where: { key },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const newVersion = (max?.version ?? active.version) + 1;
      await prisma.legalTemplate.create({
        data: {
          key,
          version: newVersion,
          locale: tpl.locale,
          title: tpl.title,
          bodyMd: tpl.bodyMd,
          active: true,
        },
      });
      await prisma.legalTemplate.update({
        where: { key_version: { key, version: active.version } },
        data: { active: false },
      });
      console.log(`  ${key}: upgraded stub v${active.version} → real v${newVersion}`);
      continue;
    }

    console.log(`  ${key}: active v${active.version} already has real content — left as-is`);
  }
}

async function main(): Promise<void> {
  // NOTE: the one-time order-tariff reprice is NOT here. It lives in migration
  // 20260729070000_reprice_order_tariff, because Render's start command runs
  // `prisma migrate deploy` and never runs this seed — a reprice that only
  // happens when someone remembers to seed is not a reprice.
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

  console.log('Seeding contract templates (self-healing)...');
  await seedContractTemplates();
  console.log(`Ensured ${CONTRACT_KEYS.length} legal contract templates`);
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
