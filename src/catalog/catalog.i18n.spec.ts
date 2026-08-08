import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CATALOG_V1, CatalogV1, LocalizedLabel } from './catalog.data';
import { I18N_DIR, mergeCatalogI18n } from './catalog.i18n';

/**
 * The catalog is the source of truth for angle, part, damage-type, K/S/T,
 * checklist and paint-station names in both the API and the mobile bundle. The
 * four human-translated locales are authored in `catalog.data.ts`; the 26
 * machine-translated ones arrive as sidecars and are folded in here.
 *
 * A silent failure in that fold is expensive and invisible: every label has a
 * fallback chain, so a locale that merged nothing renders another language with
 * nothing erroring anywhere. That is exactly how 164 Ukrainian labels shipped as
 * Russian in July 2026.
 */
describe('mergeCatalogI18n', () => {
  /** A throwaway catalog so tests never mutate the module singleton. */
  const makeCatalog = (): CatalogV1 =>
    JSON.parse(JSON.stringify(CATALOG_V1)) as CatalogV1;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csp-i18n-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSidecar = (tag: string, body: Record<string, string>): void => {
    writeFileSync(join(dir, `catalog.${tag}.json`), JSON.stringify(body), 'utf8');
  };

  it('returns an empty report when the directory does not exist', () => {
    const report = mergeCatalogI18n(makeCatalog(), join(dir, 'nope'));
    expect(report.tags).toEqual([]);
  });

  it('applies a label onto the matching entry', () => {
    const catalog = makeCatalog();
    const part = catalog.parts[0];
    writeSidecar('es', { [`parts.${part.id}`]: 'Puerta delantera izquierda' });

    const report = mergeCatalogI18n(catalog, dir);

    expect(report.tags).toEqual(['es']);
    expect(report.applied.es).toBe(1);
    expect(catalog.parts[0].label.es).toBe('Puerta delantera izquierda');
  });

  it('applies angle hints through the `.hint` suffix', () => {
    const catalog = makeCatalog();
    const withHint = catalog.angles.find((a) => a.hint);
    expect(withHint).toBeDefined();
    writeSidecar('fr', { [`angles.${withHint!.id}.hint`]: 'Tournez la roue' });

    mergeCatalogI18n(catalog, dir);

    const merged = catalog.angles.find((a) => a.id === withHint!.id);
    expect(merged!.hint!.fr).toBe('Tournez la roue');
    // The label must NOT have been touched by a hint key.
    expect(merged!.label.fr).toBeUndefined();
  });

  it('never overwrites the hand-authored locales', () => {
    const catalog = makeCatalog();
    const part = catalog.parts[0];
    const originals = { de: part.label.de, en: part.label.en, ru: part.label.ru };
    writeSidecar('es', { [`parts.${part.id}`]: 'Puerta' });

    mergeCatalogI18n(catalog, dir);

    expect(catalog.parts[0].label.de).toBe(originals.de);
    expect(catalog.parts[0].label.en).toBe(originals.en);
    expect(catalog.parts[0].label.ru).toBe(originals.ru);
  });

  it('reports keys that match no catalog entry instead of throwing', () => {
    const catalog = makeCatalog();
    writeSidecar('es', {
      'parts.this_part_was_deleted': 'Fantasma',
      [`parts.${catalog.parts[0].id}`]: 'Puerta',
    });

    const report = mergeCatalogI18n(catalog, dir);

    // The catalog is allowed to drop an entry between a translation run and an
    // export; failing the export over it would block a legitimate change.
    expect(report.applied.es).toBe(1);
    expect(report.orphans.es).toEqual(['parts.this_part_was_deleted']);
  });

  it('ignores empty values rather than blanking a label', () => {
    const catalog = makeCatalog();
    const part = catalog.parts[0];
    writeSidecar('es', { [`parts.${part.id}`]: '' });

    const report = mergeCatalogI18n(catalog, dir);

    expect(report.applied.es).toBe(0);
    expect(catalog.parts[0].label.es).toBeUndefined();
  });

  it('accepts a script subtag in the filename', () => {
    const catalog = makeCatalog();
    writeSidecar('zh-Hant', { [`parts.${catalog.parts[0].id}`]: '左前門' });

    const report = mergeCatalogI18n(catalog, dir);

    expect(report.tags).toEqual(['zh-Hant']);
    expect(catalog.parts[0].label['zh-Hant']).toBe('左前門');
  });

  it('ignores files that are not locale sidecars', () => {
    writeFileSync(join(dir, 'README.md'), '# notes', 'utf8');
    writeFileSync(join(dir, 'catalog.json'), '{}', 'utf8');

    expect(mergeCatalogI18n(makeCatalog(), dir).tags).toEqual([]);
  });
});

/**
 * The committed sidecars, checked as data. These assertions are what make a
 * green mobile build meaningful — the app's own catalog test asserts
 * completeness of the exported bundle, and this asserts completeness of what
 * the bundle is generated FROM.
 */
describe('the committed catalog i18n sidecars', () => {
  const MACHINE_LOCALES = [
    'cs', 'da', 'nl', 'fr', 'el', 'hu', 'it', 'pl', 'pt', 'ro', 'es', 'sv', 'tr',
    'ar', 'he', 'fa',
    'zh', 'zh-Hant', 'ja', 'ko', 'vi', 'th', 'id', 'ms',
    'hi', 'bn',
  ];

  it('exist for all 26 machine-translated locales', () => {
    expect(existsSync(I18N_DIR)).toBe(true);
    const present = readdirSync(I18N_DIR)
      .map((f) => /^catalog\.(.+)\.json$/.exec(f)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort();
    expect(present).toEqual([...MACHINE_LOCALES].sort());
  });

  it('each cover every localizable catalog entry', () => {
    const catalog = JSON.parse(JSON.stringify(CATALOG_V1)) as CatalogV1;
    const expected: string[] = [];
    const add = (key: string, label?: LocalizedLabel): void => {
      if (label) expected.push(key);
    };
    for (const a of catalog.angles) {
      add(`angles.${a.id}`, a.label);
      add(`angles.${a.id}.hint`, a.hint);
    }
    for (const p of catalog.parts) add(`parts.${p.id}`, p.label);
    for (const t of catalog.damageTypes) add(`damageTypes.${t.id}`, t.label);
    for (const c of catalog.kstCodes) add(`kstCodes.${c.code}`, c.label);
    for (const i of catalog.checklist) add(`checklist.${i.number}`, i.label);
    for (const p of catalog.thicknessPanels) add(`thicknessPanels.${p.id}`, p.label);

    for (const tag of MACHINE_LOCALES) {
      const file = join(I18N_DIR, `catalog.${tag}.json`);
      const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const missing = expected.filter((k) => !body[k]);
      expect({ tag, missing }).toEqual({ tag, missing: [] });
    }
  });
});
