/**
 * Uploads the CJK PDF font packs to the reports bucket.
 *
 *   npx ts-node scripts/upload-fonts.ts <directory-with-the-ttf-files>
 *
 * Each file is verified against the SHA-256 in `src/fonts/fonts.manifest.ts`
 * BEFORE it is uploaded. The script never rewrites that table: a manifest that
 * regenerates itself from whatever happens to be on disk verifies nothing, and
 * the whole point of the digest is that the app can detect a truncated download
 * — a truncated TrueType file does not throw when parsed, it yields a font with
 * zero glyph metrics and a report full of invisible text.
 *
 * Get the files with `carsalepro-mobile/tool/fonts/fetch_test_fonts.ps1`, which
 * pulls the Google Fonts static per-weight TTF instances (NOT the noto-cjk
 * OTF/OTC releases — `package:pdf` cannot parse those).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { FONT_MANIFEST } from '../src/fonts/fonts.manifest';
import { R2Service } from '../src/r2/r2.service';

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    // eslint-disable-next-line no-console
    console.error('usage: npx ts-node scripts/upload-fonts.ts <directory>');
    process.exit(2);
  }
  const root = resolve(dir);

  // Verify EVERYTHING before uploading ANYTHING: a half-uploaded pack leaves the
  // app able to fetch three of four faces, which registers a Helvetica fallback
  // for the missing one and prints tofu.
  const planned: { path: string; body: Buffer }[] = [];
  for (const file of FONT_MANIFEST) {
    const path = join(root, file.name);
    if (!existsSync(path)) {
      throw new Error(`missing: ${path}`);
    }
    const body = readFileSync(path);
    if (body.length !== file.bytes) {
      throw new Error(
        `${file.name}: expected ${file.bytes} bytes, found ${body.length}`,
      );
    }
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== file.sha256) {
      throw new Error(
        `${file.name}: SHA-256 mismatch\n  manifest ${file.sha256}\n  on disk  ${digest}`,
      );
    }
    // The sfnt version must be TrueType glyf, or package:pdf silently degrades.
    if (body.readUInt32BE(0) !== 0x00010000) {
      throw new Error(
        `${file.name}: not a TrueType glyf font (sfnt=0x${body
          .readUInt32BE(0)
          .toString(16)})`,
      );
    }
    planned.push({ path, body });
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const r2 = app.get(R2Service);

  for (const [i, file] of FONT_MANIFEST.entries()) {
    await r2.putObject(file.key, planned[i].body, 'font/ttf');
    // eslint-disable-next-line no-console
    console.log(
      `uploaded ${file.key} (${(file.bytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  await app.close();
  // eslint-disable-next-line no-console
  console.log(`\n${FONT_MANIFEST.length} file(s) uploaded. Verify with:`);
  // eslint-disable-next-line no-console
  console.log('  curl -s https://carsalepro-backend.onrender.com/fonts/manifest');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
