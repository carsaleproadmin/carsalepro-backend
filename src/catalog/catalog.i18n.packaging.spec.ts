import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The sidecars must be COPIED into the build output, not merely committed.
 *
 * `tsc` emits only JavaScript, so `src/catalog/i18n/*.json` reaches `dist/`
 * exclusively via the `assets` list in `nest-cli.json`. Without that entry
 * `mergeCatalogI18n` resolves its directory relative to `__dirname`, finds
 * nothing, and returns an empty report — **without failing**, which is right for
 * a locale that is legitimately absent and catastrophic for all 26 at once.
 *
 * That is exactly what production did between the 30-language release and
 * 2026-08-10: `GET /catalog` served four locales instead of thirty, and nothing
 * noticed. The mobile app reads its own bundled copy of the catalog, and the
 * website only ever asks for de/en/ru.
 *
 * `catalog.i18n.spec.ts` cannot catch this: it reads from `src/`, where the
 * files have always been. So this asserts the PACKAGING rule instead — the one
 * thing that was actually wrong.
 */
describe('catalog i18n packaging', () => {
  const root = resolve(__dirname, '../..');

  it('nest-cli.json copies the sidecars into dist', () => {
    // Required, not optional: `require` would resolve the file from the build
    // output in some configurations, and this must read the source of truth.
    const config = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').readFileSync(join(root, 'nest-cli.json'), 'utf8'),
    ) as { compilerOptions?: { assets?: { include?: string }[] } };

    const includes = (config.compilerOptions?.assets ?? []).map((a) => a.include);
    expect(includes).toContain('catalog/i18n/*.json');
  });

  it('every committed sidecar is a locale the app actually ships', () => {
    const dir = join(root, 'src/catalog/i18n');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(26);
    for (const file of files) {
      expect(file).toMatch(/^catalog\.[a-z]{2}(-[A-Z][a-z]{3})?\.json$/);
    }
  });

  it('the source directory the loader points at exists', () => {
    // A rename of src/catalog/i18n would silently disable the merge in dev too.
    expect(existsSync(join(root, 'src/catalog/i18n'))).toBe(true);
  });
});
