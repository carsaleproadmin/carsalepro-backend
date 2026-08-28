/**
 * Download stock car photographs for the demo showroom - DEN-216.
 *
 *   PEXELS_API_KEY=... npx ts-node -T -P tsconfig.json scripts/fetch-demo-photos.ts
 *   ... scripts/fetch-demo-photos.ts --out=./demo-photos --count=120
 *
 * Feeds `scripts/import-demo-listings.ts --photos=<dir>`. Kept separate on
 * purpose: downloading a hundred files off the internet and writing a hundred
 * rows to production are different kinds of risk, and the download is the one
 * worth being able to repeat, inspect and throw away on its own.
 *
 * WHY PEXELS
 *
 * The Pexels licence allows commercial use with no attribution, which is what
 * a showroom card needs - there is nowhere on a card to put a credit line, and
 * a licence that demands one is a licence being broken.
 *
 * Openverse was tried first and rejected. Its CC0 pool for "car" is Wikimedia
 * and Flickr miscellany: trains, a 1933 armoured car, a number plate, the
 * ruins of a castle in the French commune of Les Cars. Correct licence, wrong
 * photographs. Wikimedia Commons has real photographs of the exact models in
 * `demo-fleet.ts`, but they are mostly CC BY-SA - per-file attribution plus
 * share-alike, which is a poor fit for a commercial listing page.
 *
 * WHAT IS NOT DONE HERE
 *
 * No attempt is made to match a photograph to the model of the listing it will
 * illustrate. Stock libraries do not reliably label a car by generation, and a
 * Passat advert carrying a photograph of a Mondeo is worse than one carrying an
 * unlabelled silver estate. The importer therefore assigns photographs
 * round-robin, and the description says the listing is an example.
 *
 * Flags:
 *   --out=<dir>    where to write (default ./demo-photos)
 *   --count=N      how many photographs (default 120)
 *   --dry-run      list what would be downloaded; write nothing
 */
import * as fs from 'fs';
import * as path from 'path';

import { flag, loadEnv, option, requireEnv } from './lib/script-env';

/**
 * The queries, chosen to spread body styles rather than makes.
 *
 * A hundred photographs of the same silver hatchback would make the showroom
 * look like one car listed a hundred times, which is the failure the whole
 * exercise is meant to avoid.
 */
const QUERIES = [
  'car exterior side view',
  'silver sedan car',
  'suv car parked',
  'station wagon car',
  'hatchback car street',
  'white car front view',
  'black car parked outdoor',
  'blue car side',
  'used car dealership',
  'compact car city',
];

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  photographer: string;
  url: string;
  src: { large2x: string; large: string; original: string };
}

async function search(key: string, query: string, perPage: number): Promise<PexelsPhoto[]> {
  const url =
    'https://api.pexels.com/v1/search' +
    `?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape&size=large`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    throw new Error(`Pexels ${res.status} ${res.statusText} for "${query}"`);
  }
  const body = (await res.json()) as { photos?: PexelsPhoto[] };
  return body.photos ?? [];
}

async function main(): Promise<void> {
  loadEnv();
  const dryRun = flag('dry-run');
  const outDir = path.resolve(option('out', './demo-photos'));
  const count = Number(option('count', '120'));
  const key = requireEnv('PEXELS_API_KEY');

  const perQuery = Math.ceil(count / QUERIES.length);
  const chosen: PexelsPhoto[] = [];
  const seen = new Set<number>();

  for (const query of QUERIES) {
    const photos = await search(key, query, perQuery);
    for (const photo of photos) {
      // The same photograph answers several of these queries; a showroom with
      // the same picture on four cards is what the dedupe prevents.
      if (seen.has(photo.id)) continue;
      seen.add(photo.id);
      chosen.push(photo);
    }
    console.log(`${query}: ${photos.length} found, ${chosen.length} kept so far`);
    if (chosen.length >= count) break;
  }

  const wanted = chosen.slice(0, count);

  if (dryRun) {
    for (const photo of wanted.slice(0, 10)) {
      console.log(`  ${photo.id}  ${photo.width}x${photo.height}  ${photo.photographer}`);
    }
    console.log(`... ${wanted.length} photographs would be written to ${outDir}`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  /*
   * A credits file, even though the Pexels licence does not require one.
   *
   * If a photographer ever asks for their picture to be taken down, the only
   * way to find which of a hundred adverts carries it is a record made at
   * download time. Writing it costs nothing now and is impossible to
   * reconstruct later.
   */
  const credits: string[] = [
    '# Demo showroom photographs (DEN-216)',
    '# Source: Pexels (https://www.pexels.com/license/) - commercial use, no attribution required.',
    '# Recorded anyway, so a takedown request can be traced to a file.',
    '',
  ];

  let written = 0;
  for (const [index, photo] of wanted.entries()) {
    const name = `${String(index + 1).padStart(3, '0')}-${photo.id}.jpg`;
    const target = path.join(outDir, name);
    if (fs.existsSync(target)) {
      written++;
      continue;
    }
    // `large2x` and not `original`: originals run to 20 MB, and the importer
    // compresses to 1920 px anyway, so the extra bytes are downloaded only to
    // be thrown away.
    const res = await fetch(photo.src.large2x);
    if (!res.ok) {
      console.warn(`  skip ${photo.id}: ${res.status}`);
      continue;
    }
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    credits.push(`${name}\t${photo.photographer}\t${photo.url}`);
    written++;
    process.stdout.write(`\r${written}/${wanted.length} downloaded`);
  }

  fs.writeFileSync(path.join(outDir, 'CREDITS.txt'), credits.join('\n') + '\n');
  console.log(`\ndone: ${written} photographs in ${outDir}`);
  console.log(`next: npx ts-node -T -P tsconfig.json scripts/import-demo-listings.ts --photos=${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
