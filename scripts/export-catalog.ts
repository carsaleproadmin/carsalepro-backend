/**
 * Exports the canonical reference catalog (`src/catalog/catalog.data.ts`,
 * the single source of truth also served by `GET /catalog`) to the mobile
 * app's bundled asset, byte-for-byte identical to the endpoint payload.
 *
 * Run from the backend root:  npx ts-node scripts/export-catalog.ts
 *
 * Keeps the Flutter app DRY: the mobile bundle is generated, never
 * hand-transcribed. CatalogService loads this bundle as its source of truth
 * and treats `GET /catalog` as an optional, non-blocking freshness override.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { CATALOG_V1 } from '../src/catalog/catalog.data';

const out = resolve(
  __dirname,
  '../../carsalepro-mobile/assets/catalog/catalog.v1.json',
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(CATALOG_V1, null, 2)}\n`, 'utf8');

const c = CATALOG_V1;
const exterior = c.angles.filter((a) => a.group === 'exterior' && a.required);
const interior = c.angles.filter((a) => a.group === 'interior');
// eslint-disable-next-line no-console
console.log(
  `catalog.v1.json written → ${out}\n` +
    `  version=${c.version}  angles=${c.angles.length} (exterior required=${exterior.length}, ` +
    `interior=${interior.length})  parts=${c.parts.length}  damageTypes=${c.damageTypes.length}  ` +
    `kstCodes=${c.kstCodes.length}  checklist=${c.checklist.length}  ` +
    `thicknessPanels=${c.thicknessPanels.length}`,
);
