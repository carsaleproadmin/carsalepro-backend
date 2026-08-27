/**
 * Give the seeded demo listings the country they obviously have - DEN-205.
 *
 * `listing.country_code` arrived after most of this data did, so 440 rows claim
 * no country. The showroom's country filter deliberately does not return them -
 * null means "nobody said", and answering a search for Germany with rows that
 * never claimed it is the same defect as guessing - so on a development
 * database the filter looks broken: `?country=DE` answered 2 out of 181.
 *
 * A SCRIPT and not a migration, on purpose. A migration runs everywhere,
 * including production, where these rows are somebody's real listing and the
 * country is theirs to state. This is a development-data convenience and it
 * should have to be asked for.
 *
 * The mapping is EXPLICIT. Nothing is inferred from a postcode or a language:
 * every city named below is written out with its country, and a row whose city
 * is not in the table - including the 201 drafts with no city at all - is left
 * exactly as it is. A guess that is right nine times out of ten is still a
 * column nobody can trust.
 *
 * Idempotent: only rows with a NULL country are touched.
 *
 *   npx ts-node -T -P tsconfig.json scripts/backfill-demo-listing-country.ts
 *   npx ts-node -T -P tsconfig.json scripts/backfill-demo-listing-country.ts --dry-run
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { normalizeSearchText } from '../src/common/search-text';

/** Normalized city name -> ISO 3166-1 alpha-2. Written out, never inferred. */
const CITY_COUNTRY: Record<string, string> = {
  berlin: 'DE',
  hamburg: 'DE',
  munchen: 'DE',
  koln: 'DE',
  leipzig: 'DE',
  'frankfurt am main': 'DE',
  dresden: 'DE',
  stuttgart: 'DE',
  dusseldorf: 'DE',
  'bad homburg': 'DE',
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const rows = await prisma.listing.findMany({
    where: { countryCode: null },
    select: { id: true, city: true, status: true },
  });

  const counts = new Map<string, number>();
  let skipped = 0;

  for (const row of rows) {
    const country = CITY_COUNTRY[normalizeSearchText(row.city)];
    if (!country) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await prisma.listing.update({ where: { id: row.id }, data: { countryCode: country } });
    }
    const key = `${row.city} -> ${country}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.log(dryRun ? 'DRY RUN - nothing written\n' : '');
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${key}`);
  }
  const written = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(`\n${rows.length} without a country: ${written} set, ${skipped} left alone`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
