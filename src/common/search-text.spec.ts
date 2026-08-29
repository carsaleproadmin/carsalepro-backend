import { citySearchKeys, normalizeCompact, normalizeSearchText } from './search-text';

/*
 * DEN-205. The fold that makes the showroom filters answer.
 *
 * The bug that produced this file: a car in Berlin, found by typing "Berlin"
 * and not found by typing "Берлин". These cases are the four distinct reasons
 * two strings naming the same thing fail to match, kept apart on purpose -
 * fixing one of them does not fix the others, and a single "it normalizes"
 * test would not have said which was broken.
 */

describe('normalizeSearchText', () => {
  it('folds case and whitespace', () => {
    expect(normalizeSearchText('  BERLIN  ')).toBe('berlin');
    expect(normalizeSearchText('Frankfurt   am    Main')).toBe('frankfurt am main');
  });

  it('strips diacritics without a table', () => {
    // NFD plus combining-mark removal, which is why these need no entries
    // anywhere: the rule is the Unicode decomposition, not a list.
    expect(normalizeSearchText('München')).toBe('munchen');
    expect(normalizeSearchText('Köln')).toBe('koln');
    expect(normalizeSearchText('Zürich')).toBe('zurich');
    expect(normalizeSearchText('Göteborg')).toBe('goteborg');
    expect(normalizeSearchText('Škoda')).toBe('skoda');
    expect(normalizeSearchText('Ćwikła')).toBe('cwikła');
  });

  it('transliterates Cyrillic into the spelling a Latin row already holds', () => {
    // The reported bug, reduced to one assertion.
    expect(normalizeSearchText('Берлин')).toBe('berlin');
    expect(normalizeSearchText('БЕРЛИН')).toBe('berlin');
    expect(normalizeSearchText('Гамбург')).toBe('gamburg');
  });

  it('drops the soft and hard signs, which no Latin row spells', () => {
    expect(normalizeSearchText('Харьков')).toBe('harkov');
    expect(normalizeSearchText('Объезд')).toBe('obezd');
  });

  it('reads multi-character Cyrillic before single characters', () => {
    // "щ" must not be read as "ш" with a leftover.
    expect(normalizeSearchText('щ')).toBe('shch');
    expect(normalizeSearchText('Шчучин')).toBe('shchuchin');
  });

  it('answers empty for nothing, blank and whitespace', () => {
    // A caller reads this as "no filter", so it must not be a string that
    // `contains` would match against every row.
    expect(normalizeSearchText(null)).toBe('');
    expect(normalizeSearchText(undefined)).toBe('');
    expect(normalizeSearchText('')).toBe('');
    expect(normalizeSearchText('   ')).toBe('');
  });
});

describe('citySearchKeys', () => {
  const has = (input: string, key: string) => citySearchKeys(input).includes(key);

  it('reaches a Latin row from a Cyrillic query and back', () => {
    expect(has('Берлин', 'berlin')).toBe(true);
    expect(has('Berlin', 'berlin')).toBe(true);
  });

  it('reaches an umlaut row from every spelling of it', () => {
    for (const typed of ['München', 'Munchen', 'Muenchen', 'MUENCHEN', 'Мюнхен', 'munich']) {
      expect(has(typed, 'munchen')).toBe(true);
    }
  });

  it('crosses an exonym, which no fold can reach', () => {
    // "Москва" transliterates to "moskva", and no rule turns that into
    // "moscow" - these are different words and need the table.
    expect(has('Moscow', 'moskva')).toBe(true);
    expect(has('Москва', 'moscow')).toBe(true);
    expect(has('Vienna', 'wien')).toBe(true);
    expect(has('Wien', 'vienna')).toBe(true);
    expect(has('Prague', 'praha')).toBe(true);
    expect(has('Warsaw', 'warszawa')).toBe(true);
    expect(has('Kyiv', 'kiev')).toBe(true);
    expect(has('Киев', 'kyiv')).toBe(true);
    expect(has('Gothenburg', 'goteborg')).toBe(true);
  });

  it('is symmetric: every spelling in a group reaches every other', () => {
    // The property that keeps the table honest. A one-way entry is the bug
    // this whole file exists to prevent, and it is invisible in a spot check.
    const groups = [
      ['Moscow', 'Москва', 'Moskau'],
      ['Kyiv', 'Kiev', 'Киев'],
      ['Vienna', 'Wien', 'Вена'],
      ['Cologne', 'Köln', 'Koeln'],
    ];
    for (const group of groups) {
      for (const a of group) {
        for (const b of group) {
          expect(citySearchKeys(a)).toEqual(expect.arrayContaining([normalizeSearchText(b)]));
        }
      }
    }
  });

  it('returns nothing for a blank box', () => {
    expect(citySearchKeys('')).toEqual([]);
    expect(citySearchKeys('   ')).toEqual([]);
    expect(citySearchKeys(null)).toEqual([]);
  });

  it('never DERIVES a key short enough to match half the table', () => {
    /*
     * The floor is on the keys this module invents, not on the one the reader
     * typed: somebody who types two characters has asked for a two-character
     * `contains` and is entitled to it. What must not happen is the umlaut
     * collapse turning "Bue" into a search for "bu" nobody asked for, which is
     * a substring of Bucharest, Budapest and Buxtehude.
     */
    for (const city of ['Bue', 'Ae', 'Oe', 'Prague', 'Toulouse', 'Berlin']) {
      const base = normalizeSearchText(city);
      const derived = citySearchKeys(city).filter((key) => key !== base);
      for (const key of derived) expect(key.length).toBeGreaterThanOrEqual(3);
    }
    // And concretely: the collapse does not fire on a three-letter word.
    expect(citySearchKeys('Bue')).toEqual(['bue']);
  });
});

describe('normalizeCompact', () => {
  it('removes the punctuation nobody agrees on in a car name', () => {
    expect(normalizeCompact('Mercedes-Benz')).toBe('mercedesbenz');
    expect(normalizeCompact('mercedes benz')).toBe('mercedesbenz');
    expect(normalizeCompact('C 220')).toBe('c220');
    expect(normalizeCompact('c-220')).toBe('c220');
    expect(normalizeCompact('Model 3')).toBe('model3');
  });

  it('keeps digits, which are most of what a model name is', () => {
    expect(normalizeCompact('XC60')).toBe('xc60');
    expect(normalizeCompact('A4 Avant')).toBe('a4avant');
    expect(normalizeCompact('500')).toBe('500');
  });

  it('folds diacritics like the others', () => {
    expect(normalizeCompact('Škoda')).toBe('skoda');
    expect(normalizeCompact('Citroën')).toBe('citroen');
  });

  it('answers empty for nothing', () => {
    expect(normalizeCompact(null)).toBe('');
    expect(normalizeCompact('  ')).toBe('');
    expect(normalizeCompact('---')).toBe('');
  });
});
