/**
 * Fill the showroom with demo listings - DEN-216.
 *
 *   npx ts-node -T -P tsconfig.json scripts/import-demo-listings.ts --dry-run
 *   npx ts-node -T -P tsconfig.json scripts/import-demo-listings.ts --photos=./demo-photos
 *   npx ts-node -T -P tsconfig.json scripts/import-demo-listings.ts --purge
 *
 * Production has five adverts. A showroom with five rows cannot demonstrate
 * pagination, sorting or filters to anybody, so this writes a hundred more.
 *
 * WHAT IS AND IS NOT INVENTED
 *
 * Model facts come from `scripts/data/demo-fleet.ts`, which cites its sources
 * and their licences - read that header before editing the table. Instance
 * facts (mileage, colour, price, dates) are generated here. No inspection
 * report, no quality score, no damage list is ever produced: every demo row is
 * `source: 'manual'`, self-declared, with no report attached.
 *
 * WHY EVERY ROW IS ONE SELLER'S
 *
 * So that removing them is `DELETE FROM listing WHERE seller_id = ...`, not a
 * database restore. Restoring the pre-import dump would also erase whatever
 * real users did in the meantime, which makes it a worse outcome than the
 * import it was meant to undo. `--purge` is the supported rollback.
 *
 * IDEMPOTENT
 *
 * Ids are fixed (`demo-0001`...) and every generated value comes from a PRNG
 * seeded with the row index, so a second run rewrites identical rows. Re-running
 * after an interruption is safe and is the intended way to resume.
 *
 * PHOTOS
 *
 * `--photos=<dir>` uploads the jpegs in that directory, round-robin, through
 * the same compression the seller upload path uses. Without the flag, listings
 * are written with no photo - useful for a `--dry-run` rehearsal, and useless
 * as a final state, because a showroom card with no picture is worse than no
 * card. Source the files from Pexels or Unsplash; do NOT reuse the objects of
 * real listings, which are photographs of other people's cars taken for one
 * specific inspection.
 *
 * Flags:
 *   --dry-run        report what would be written; touch nothing
 *   --count=N        how many listings (default 100)
 *   --photos=<dir>   directory of source jpegs to upload
 *   --per-listing=N  photos per listing (default 3)
 *   --purge          delete every demo listing and stop
 */
import * as fs from 'fs';
import * as path from 'path';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';
import { PhotoProcessingService } from '../src/common/photo/photo-processing.service';
import { normalizeCompact, normalizeSearchText } from '../src/common/search-text';
import { COLORS, FLEET, PLACES } from './data/demo-fleet';
import { flag, option } from './lib/script-env';

/**
 * The account every demo advert belongs to.
 *
 * A `.local` address on purpose: it cannot receive mail, so nothing here can
 * ever be mistaken for a real seller's inbox, and no message can be delivered
 * to a person who never listed a car.
 */
const SELLER_EMAIL = 'showroom@carsalepro.local';
/** Where a reader who wants to ask about a demo car actually lands. */
const PLATFORM_EMAIL = 'carsaleproadmin@gmail.com';

/**
 * A tiny deterministic PRNG (mulberry32).
 *
 * `Math.random` would make the script non-idempotent in the one way that
 * matters: a re-run would rewrite all hundred rows with different mileage and
 * different prices, so the diff of a resumed import would be the whole table.
 */
function rng(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(items: readonly T[], r: () => number): T =>
  items[Math.floor(r() * items.length)];

const between = (min: number, max: number, r: () => number): number =>
  min + Math.floor(r() * (max - min + 1));

interface GeneratedListing {
  id: string;
  make: string;
  model: string;
  year: number;
  mileageKm: number;
  color: string;
  bodyType: string;
  driveType: string;
  fuelType: string;
  transmission: string;
  powerKw: number;
  priceCents: number;
  city: string;
  countryCode: string;
  plz: string;
  firstRegistration: Date;
  huValidUntil: string;
  description: string;
}

/**
 * One car, decided entirely by its index.
 *
 * Mileage follows the year rather than being drawn independently: a 2023 car
 * with 240 000 km sorts to the top of "cheapest" and reads as broken data to
 * anybody who knows cars, which is the audience a demo showroom is for.
 */
function generate(index: number, now: Date): GeneratedListing {
  const r = rng(index * 7919);
  const spec = FLEET[index % FLEET.length];
  const place = PLACES[(index * 5) % PLACES.length];

  const year = between(spec.years[0], spec.years[1], r);
  const age = Math.max(0, now.getUTCFullYear() - year);
  // 8 000-22 000 km a year, plus a small delivery-mileage floor.
  const mileageKm = Math.round((between(8_000, 22_000, r) * age + between(50, 900, r)) / 100) * 100;

  /*
   * Depreciation in TWO stages, because one exponential cannot describe a car.
   * A single rate steep enough for the first years (a new car loses about a
   * sixth of its value a year) drives a thirteen-year-old Golf to 3 200 EUR,
   * roughly a third of what one really costs; a rate gentle enough for an old
   * car leaves a three-year-old one at nearly its list price. So: -16 % a year
   * for the first five years, -6 % a year after that, which is the shape of
   * the real curve - the cliff is early, and then it flattens.
   *
   * Plausible, not a valuation. See the note on `newPriceCents`.
   */
  const steep = Math.min(age, 5);
  const gentle = Math.max(0, age - 5);
  const byAge = spec.newPriceCents * Math.pow(0.84, steep) * Math.pow(0.94, gentle);
  const byMileage = byAge * (1 - Math.min(0.25, mileageKm / 1_200_000));
  const priceCents = Math.round((byMileage * (0.94 + r() * 0.12)) / 5_000) * 5_000;

  const regMonth = between(1, 12, r);
  const firstRegistration = new Date(Date.UTC(year, regMonth - 1, between(1, 28, r)));
  /*
   * HU is valid for two years from the last test, so a date in the past means
   * an overdue car. Free text, `YYYY-MM`, because that is how the seller
   * editor stores it - the column is not a date.
   */
  const huYear = now.getUTCFullYear() + between(0, 2, r);
  const huValidUntil = `${huYear}-${String(between(1, 12, r)).padStart(2, '0')}`;

  return {
    id: `demo-${String(index + 1).padStart(4, '0')}`,
    make: spec.make,
    model: spec.model,
    year,
    mileageKm,
    color: pick(COLORS, r),
    bodyType: spec.bodyType,
    driveType: spec.driveType,
    fuelType: spec.fuelType,
    transmission: spec.transmission,
    powerKw: spec.powerKw,
    priceCents,
    city: place.city,
    countryCode: place.countryCode,
    plz: place.plz,
    firstRegistration,
    huValidUntil,
    /*
     * The description says what the row is. The `isDemo` column is what code
     * reads, but a person looking at one advert sees only this page, and a
     * hundred fabricated cars on a live site with nothing on them saying so is
     * not a thing to ship quietly.
     */
    description:
      `${spec.make} ${spec.model}, ${year}, ${mileageKm.toLocaleString('de-DE')} km. ` +
      'Beispielinserat der Plattform / demo listing / демонстраційне оголошення. ' +
      'Kein reales Fahrzeug, kein Gutachten.',
  };
}

/**
 * The photographs on disk, grouped into SETS OF ONE CAR.
 *
 * `fetch-demo-photos.ts` names its files `g007-2-12345.jpg`: car seven, third
 * frame. Grouping matters because a gallery is per advert - three unrelated
 * cars under one listing reads as broken, not as thin. Files that do not carry
 * the prefix (a directory the user filled by hand) each become their own group
 * of one, which is the safe reading: one photograph per advert and no false
 * claim that two frames show the same car.
 *
 * Sorted, so the assignment is identical on every run.
 */
function loadPhotoGroups(dir: string): string[][] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error(`No image files in ${dir}. Nothing to upload.`);
  }

  const groups = new Map<string, string[]>();
  for (const name of files) {
    const match = /^(g\d+)-/.exec(name);
    const key = match ? match[1] : name;
    const list = groups.get(key);
    if (list) list.push(path.join(dir, name));
    else groups.set(key, [path.join(dir, name)]);
  }
  return [...groups.values()];
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run');
  const purge = flag('purge');
  const count = Number(option('count', '100'));
  const perListing = Number(option('per-listing', '3'));
  const photoDir = option('photos', '');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const r2 = app.get(R2Service);
  const photos = app.get(PhotoProcessingService);

  const seller = await prisma.user.findUnique({ where: { email: SELLER_EMAIL } });

  if (purge) {
    if (!seller) {
      console.log('No demo seller account. Nothing to purge.');
      await app.close();
      return;
    }
    const doomed = await prisma.listing.findMany({
      where: { sellerId: seller.id, isDemo: true },
      select: { id: true },
    });
    console.log(`${dryRun ? 'Would delete' : 'Deleting'} ${doomed.length} demo listings.`);
    if (!dryRun) {
      // Photo rows cascade; the R2 objects are left behind deliberately, so a
      // mistaken purge can be re-imported without re-uploading a hundred files.
      await prisma.listing.deleteMany({ where: { sellerId: seller.id, isDemo: true } });
    }
    await app.close();
    return;
  }

  const groups = photoDir ? loadPhotoGroups(photoDir) : [];
  if (!photoDir) {
    console.warn(
      'WARNING: --photos was not given. Listings will have no image, and a showroom\n' +
        '         card with no picture is worse than no card. Use this for a rehearsal only.',
    );
  }

  const now = new Date();
  const rows = Array.from({ length: count }, (_, i) => generate(i, now));

  if (dryRun) {
    for (const row of rows.slice(0, 5)) {
      console.log(
        `${row.id}  ${row.make} ${row.model} ${row.year}  ` +
          `${row.mileageKm} km  ${(row.priceCents / 100).toFixed(0)} EUR  ${row.city}`,
      );
    }
    const frames = groups.reduce((n, g) => n + g.length, 0);
    console.log(`... ${rows.length} listings total, ${frames} photos in ${groups.length} car sets.`);
    console.log(`Public bucket configured: ${r2.isPublicBucketConfigured()}`);
    await app.close();
    return;
  }

  const owner =
    seller ??
    (await prisma.user.create({
      data: {
        email: SELLER_EMAIL,
        name: 'CarSalePro',
        locale: 'de',
        countryCode: 'DE',
        emailVerified: new Date(),
      },
    }));

  let written = 0;
  let uploaded = 0;

  for (const [index, row] of rows.entries()) {
    const data = {
      sellerId: owner.id,
      source: 'manual',
      status: 'ACTIVE' as const,
      package: 'free',
      isDemo: true,
      priceCents: row.priceCents,
      city: row.city,
      countryCode: row.countryCode,
      plz: row.plz,
      description: row.description,
      /*
       * No phone. The platform does not have one, and inventing a number is
       * how a stranger's line ends up ringing. The button simply does not
       * render without it.
       */
      contactPhone: null,
      contactEmail: PLATFORM_EMAIL,
      make: row.make,
      model: row.model,
      year: row.year,
      mileageKm: row.mileageKm,
      fuelType: row.fuelType,
      transmission: row.transmission,
      powerKw: row.powerKw,
      firstRegistration: row.firstRegistration,
      huValidUntil: row.huValidUntil,
      color: row.color,
      bodyType: row.bodyType,
      driveType: row.driveType,
      /*
       * Written HERE rather than left to the backfill script. A row that
       * arrives without them is invisible to every filter until somebody
       * remembers to run a second pass, and DEN-205 is the ticket about
       * exactly that class of hole.
       */
      citySearch: normalizeSearchText(row.city),
      makeSearch: normalizeCompact(row.make),
      modelSearch: normalizeCompact(row.model),
      expiresAt: null,
    };

    /*
     * `publishedAt` is set ON CREATE ONLY, and that is what makes a re-run
     * idempotent. Derived from `now`, it is the one generated value that is not
     * a function of the row index, so writing it on update rewrote all hundred
     * rows with new timestamps every time - the diff of a resumed import would
     * have been the whole table. It is also the right behaviour on its own
     * terms: re-importing is not republishing, and it must not shuffle the
     * showroom to the top.
     *
     * Spread over the past few months rather than all stamped `now`: the
     * default sort is `publishedAt DESC`, and a hundred rows sharing one
     * timestamp fall back to the id tiebreaker, which would order the whole
     * showroom alphabetically by make forever.
     */
    await prisma.listing.upsert({
      where: { id: row.id },
      update: data,
      create: {
        id: row.id,
        ...data,
        publishedAt: new Date(now.getTime() - index * 61 * 60 * 1000),
      },
    });
    written++;

    if (groups.length > 0) {
      /*
       * ONE car set per listing, walked in order. Two adverts may end up
       * showing the same car when there are fewer sets than listings - that is
       * a repetition a reader can notice, but it is honest: each advert still
       * shows one car from several angles rather than a collage of three.
       */
      const group = groups[index % groups.length];
      const existing = await prisma.listingPhoto.count({ where: { listingId: row.id } });
      for (let slot = existing; slot < Math.min(perListing, group.length); slot++) {
        const file = group[slot];
        const processed = await photos.compress(fs.readFileSync(file));
        const key = `listings/${row.id}/demo-${slot}.jpg`;
        const bucket = r2.isPublicBucketConfigured()
          ? await r2.publicPutObject(key, processed.data, 'image/jpeg')
          : await r2.putObject(key, processed.data, 'image/jpeg').then(() => null);
        await prisma.listingPhoto.create({
          data: {
            listingId: row.id,
            r2Key: key,
            bucket,
            sizeBytes: processed.sizeBytes,
            width: processed.width,
            height: processed.height,
            format: processed.format,
            order: slot,
          },
        });
        uploaded++;
      }
    }

    process.stdout.write(`\r${written}/${rows.length} listings, ${uploaded} photos`);
  }

  console.log(`\ndone: ${written} listings, ${uploaded} photos uploaded.`);
  if (!r2.isPublicBucketConfigured()) {
    console.warn(
      'NOTE: R2_PUBLIC_* is unset, so these photos are served through 15-minute\n' +
        '      presigned URLs from the PRIVATE reports bucket - no CDN, and a shared\n' +
        '      link dies. See scripts/migrate-listing-photos-public.ts.',
    );
  }
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
