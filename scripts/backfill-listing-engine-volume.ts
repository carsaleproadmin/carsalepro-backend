/**
 * Copy the engine volume from the report to every report-backed listing that
 * was made before DEN-434 - DEN-451.
 *
 * A listing gets `vehicleData.vehicle.engineVolumeL` when it is made from a
 * report, and again when the report is re-synced. A listing made before that
 * code has no value, so its page and its card show no engine volume, and the
 * showroom filter does not find it.
 *
 * It uses the same two functions as the live path (`engineVolumeOf`,
 * `mergeVehicleData`), so the rounding and the range cannot differ.
 *
 * Idempotent and safe against a live database. A listing that already has the
 * value of its report is not written, so a second run writes nothing. A report
 * with no engine volume (an electric car, an older app) is left alone.
 * Dry run by default; `--write` writes.
 *
 *   npx ts-node -T -P tsconfig.json scripts/backfill-listing-engine-volume.ts
 *   npx ts-node -T -P tsconfig.json scripts/backfill-listing-engine-volume.ts --write
 */
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  engineVolumeOf,
  JsonObject,
  mergeVehicleData,
} from '../src/listings/listing-vehicle-data';

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const BATCH = 200;
  let cursor: string | undefined;
  let seen = 0;
  let changed = 0;

  for (;;) {
    const rows = await prisma.listing.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      where: { source: 'report', reportId: { not: null } },
      orderBy: { id: 'asc' },
      select: { id: true, vehicleData: true, report: { select: { reportData: true } } },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    seen += rows.length;

    for (const row of rows) {
      const fromReport = engineVolumeOf(row.report?.reportData as JsonObject | null);
      if (fromReport == null) continue;
      const stored = (row.vehicleData ?? {}) as JsonObject;
      if (engineVolumeOf(stored) === fromReport) continue;
      changed++;
      if (!write) continue;
      await prisma.listing.update({
        where: { id: row.id },
        data: {
          vehicleData: mergeVehicleData(stored, {
            vehicle: { engineVolumeL: fromReport },
          }) as Prisma.InputJsonValue,
        },
      });
    }
    process.stdout.write(`\rseen ${seen}, ${write ? 'written' : 'to write'} ${changed}`);
  }

  console.log(
    `\ndone: ${seen} report-backed listings, ${changed} ${write ? 'written' : 'to write (dry run, add --write)'}`,
  );
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
