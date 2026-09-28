/**
 * Fold `listing.fuel_type`, `transmission` and `color` onto their vocabularies
 * for every row already in the table - DEN-355.
 *
 * `projectVehicleColumns` folds these three from now on, but a listing written
 * before that holds whatever its writer produced: "Gasoline" from the VIN
 * decoder, "Schwarz" from an inspector, "petrol" from the seller editor. The
 * showroom's new dropdowns compare the column against a slug, so without this
 * pass they answer for the rows the editor happened to write and silently drop
 * every other one - which is the defect the fold exists to fix, left standing
 * on the existing half of the catalogue.
 *
 * It is a SCRIPT and not a SQL migration on purpose: the fold has one
 * definition (`src/listings/vehicle-vocabulary.ts`), and a CASE expression in
 * migration SQL would be a second copy of it that nothing keeps in step.
 *
 * Idempotent and safe against a live database. Folding is a fixed point - the
 * slug `petrol` folds to `petrol` - so a second run writes nothing, and a row
 * the fold does not recognise keeps its own words and is left alone.
 *
 *   npx ts-node -T -P tsconfig.json scripts/backfill-listing-vehicle-vocabulary.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  normalizeColour,
  normalizeFuelType,
  normalizeTransmission,
} from '../src/listings/vehicle-vocabulary';

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
      select: { id: true, fuelType: true, transmission: true, color: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    seen += rows.length;

    for (const row of rows) {
      const fuelType = normalizeFuelType(row.fuelType);
      const transmission = normalizeTransmission(row.transmission);
      const color = normalizeColour(row.color);
      if (
        fuelType === row.fuelType &&
        transmission === row.transmission &&
        color === row.color
      ) {
        continue;
      }
      await prisma.listing.update({
        where: { id: row.id },
        data: { fuelType, transmission, color },
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
