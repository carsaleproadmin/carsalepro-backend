/**
 * Fill `listing.city_search`, `make_search` and `model_search` for every row -
 * DEN-205.
 *
 * The migration did the part SQL can do: lower case and whitespace. It cannot
 * transliterate, so every Cyrillic city still holds a Cyrillic `city_search`
 * and is unreachable from a Latin query. This runs the real
 * `normalizeSearchText` over the table.
 *
 * Idempotent, and safe to run against a live database: it only writes rows
 * whose stored value differs from what the normalizer produces, so a second run
 * writes nothing.
 *
 *   npx ts-node -T -P tsconfig.json scripts/backfill-listing-search-columns.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { normalizeCompact, normalizeSearchText } from '../src/common/search-text';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const BATCH = 500;
  let cursor: string | undefined;
  let seen = 0;
  let written = 0;

  for (;;) {
    const rows = await prisma.listing.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, city: true, citySearch: true, make: true, makeSearch: true, model: true, modelSearch: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    seen += rows.length;

    for (const row of rows) {
      const citySearch = normalizeSearchText(row.city);
      const makeSearch = normalizeCompact(row.make);
      const modelSearch = normalizeCompact(row.model);
      if (
        citySearch === (row.citySearch ?? '') &&
        makeSearch === (row.makeSearch ?? '') &&
        modelSearch === (row.modelSearch ?? '')
      ) {
        continue;
      }
      await prisma.listing.update({
        where: { id: row.id },
        data: { citySearch, makeSearch, modelSearch },
      });
      written++;
    }
    process.stdout.write(`\rseen ${seen}, rewritten ${written}`);
  }

  console.log(`\ndone: ${seen} listings, ${written} rewritten`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
