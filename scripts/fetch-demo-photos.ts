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
  'silver sedan on road', 'white sedan parked street', 'black sedan parked outdoor',
  'blue hatchback car parked', 'white suv parked', 'grey suv on road',
  'red car parked street', 'station wagon car parked', 'compact car parked city street',
  'modern car side profile', 'car parked in front of building', 'family car parked driveway',
  'green car parked', 'beige car parked street', 'dark blue sedan parked',
  'white hatchback parked', 'black suv parked street', 'silver suv parked',
  'grey sedan parked outdoor', 'red suv on road', 'estate car parked street',
  'small car parked kerb', 'sedan rear view parked', 'car parked parking lot',
  'car parked residential street', 'white car alley', 'blue sedan road',
  'black hatchback parked', 'brown car parked', 'car side view street',
];

interface PexelsPhoto {
  id: number;
  /** Pexels' own one-line description. The only thing that makes filtering possible. */
  alt?: string;
  width: number;
  height: number;
  photographer: string;
  url: string;
  src: { large2x: string; large: string; original: string };
}


/*
 * Words that mean "not a photograph of a car somebody could be selling".
 *
 * The first pass without this filter produced a dark crop of a door handle, a
 * 1960 Edsel with its bonnet up at a classic car show, and a blurred Beetle
 * window. Stock libraries answer "car" with mood photography, and a 2022
 * Passat advert illustrated by a vintage American estate is worse than the
 * empty-state icon it replaced.
 */
const REJECT = [
  'close-up', 'closeup', 'close up', 'macro', 'detail',
  'classic', 'vintage', 'retro', 'antique', 'oldtimer',
  'black and white', 'monochrome',
  'interior', 'dashboard', 'steering', 'seat', 'engine',
  'aerial', 'drone', 'top view', 'from above',
  'woman', 'people', 'person', 'child', 'couple',
  'toy', 'miniature', 'wreck', 'abandoned', 'rusty', 'crash',
  'race', 'racing', 'rally', 'formula', 'motorcycle', 'truck',
];

/** Words that mean the frame actually holds a whole car. */
const REQUIRE = ['car', 'sedan', 'suv', 'hatchback', 'wagon', 'vehicle', 'coupe'];

function looksUsable(photo: PexelsPhoto): boolean {
  const alt = (photo.alt ?? '').toLowerCase();
  // No description at all is not a pass: it cannot be checked, and one bad
  // photograph on a card is more visible than one missing photograph.
  if (alt.length < 12) return false;
  if (REJECT.some((w) => alt.includes(w))) return false;
  return REQUIRE.some((w) => alt.includes(w));
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


/*
 * Group the photographs into SETS OF ONE CAR.
 *
 * A listing gallery holding three different cars is not a thin gallery, it is
 * a broken one: the reader clicks through and sees a silver Audi, a black Ford
 * and a white Defender under one advert. Stock photographs are unrelated by
 * default, so the grouping has to be recovered.
 *
 * The signal that works is the photographer plus the colour: stock libraries
 * carry SERIES - one photographer shooting one car from several angles in one
 * session - and those frames share both. "Mike Bird + blue" really is five
 * frames of the same blue Vauxhall Corsa.
 *
 * It is a heuristic, and it will occasionally put two different blue cars by
 * one photographer in one set. That is a far smaller error than mixing three
 * unrelated cars, and it is the best available without a human looking at
 * every frame.
 */
const COLOURS = [
  'white', 'black', 'silver', 'grey', 'gray', 'blue', 'red',
  'green', 'brown', 'beige', 'yellow', 'orange',
];

function groupKey(photo: PexelsPhoto): string {
  const alt = (photo.alt ?? '').toLowerCase();
  const colour = COLOURS.find((c) => alt.includes(c)) ?? 'unknown';
  return `${photo.photographer}|${colour}`;
}

/** One car per entry, biggest sets first. */
function groupPhotos(photos: PexelsPhoto[]): PexelsPhoto[][] {
  const buckets = new Map<string, PexelsPhoto[]>();
  for (const photo of photos) {
    const key = groupKey(photo);
    const list = buckets.get(key);
    if (list) list.push(photo);
    else buckets.set(key, [photo]);
  }
  /*
   * Biggest sets first: the importer walks groups in order, so the listings a
   * visitor is most likely to open - the first page - get the richest
   * galleries rather than whatever happened to sort first.
   */
  return [...buckets.values()].sort((a, b) => b.length - a.length);
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
      if (!looksUsable(photo)) continue;
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

  /*
   * Filenames carry the grouping: `g007-2-12345.jpg` is the third frame of car
   * seven. The importer takes a plain directory and does not read CREDITS.txt,
   * so the group has to travel in the name for that contract to stay intact.
   */
  const groups = groupPhotos(wanted);
  let written = 0;
  for (const [gi, group] of groups.entries()) {
    for (const [pi, photo] of group.entries()) {
      const name = `g${String(gi + 1).padStart(3, '0')}-${pi}-${photo.id}.jpg`;
      const target = path.join(outDir, name);
      if (fs.existsSync(target)) {
        written++;
        continue;
      }
      const res = await fetch(photo.src.large2x);
      if (!res.ok) {
        console.warn(`  skip ${photo.id}: ${res.status}`);
        continue;
      }
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      credits.push(`${name}\t${photo.photographer}\t${photo.url}\t${photo.alt ?? ''}`);
      written++;
      process.stdout.write(`\r${written}/${wanted.length} downloaded, ${groups.length} cars`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'CREDITS.txt'), credits.join('\n') + '\n');
  console.log(`\ndone: ${written} photographs in ${outDir}`);
  console.log(`next: npx ts-node -T -P tsconfig.json scripts/import-demo-listings.ts --photos=${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
