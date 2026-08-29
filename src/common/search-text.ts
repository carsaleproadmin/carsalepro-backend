/**
 * Turning what a person TYPED into something a database column can be matched
 * against - DEN-205.
 *
 * The bug this exists for: a car in Berlin, found by typing "Berlin" and not
 * found by typing "Берлин". The city is free text, written once by whoever
 * created the listing in whatever language their geocoder answered in, and read
 * by a buyer in whatever language they happen to think in. `contains` between
 * those two strings is a coin toss, and the site ships in 35 languages.
 *
 * Four different things were wrong, and they need four different answers:
 *
 *  1. CASE.        "BERLIN" vs "Berlin". Handled by lower-casing.
 *  2. DIACRITICS.  "Munchen" vs "München", "Skoda" vs "Škoda". Handled by
 *                  decomposing to NFD and dropping the combining marks, which
 *                  is why `ü` -> `u` needs no table.
 *  3. SCRIPT.      "Берлин" vs "Berlin". Handled by transliteration: the same
 *                  place, spelled in two alphabets, is one string once both are
 *                  written in the same one.
 *  4. EXONYM.      "Moscow" vs "Москва", "Vienna" vs "Wien". NOT a string
 *                  problem at all - these are different WORDS - so no amount of
 *                  folding reaches them and they need the table in
 *                  `CITY_ALIASES`.
 *
 * What this is NOT: a geocoder. The real fix for a place is to store the place
 * ID the map already returns and search on that, which would make every one of
 * the four cases disappear. That is a schema and a product decision; this makes
 * the column people actually have behave sensibly in the meantime.
 */

/**
 * Cyrillic to Latin, in the shape a German or English speaker would write it.
 *
 * Deliberately NOT ISO 9 or GOST. Those are reversible standards built to
 * recover the original spelling, so they emit `č`, `š`, `ž` and `ʹ` - and the
 * whole point here is to arrive at the plain ASCII that the Latin-script rows
 * are already stored in. "Берлин" has to become exactly "berlin", not "berlín".
 *
 * Order matters: the two-character sequences are tried before the single
 * characters, or "щ" would be read as "ш" plus a leftover.
 */
const CYRILLIC: ReadonlyArray<readonly [string, string]> = [
  ['щ', 'shch'], ['ш', 'sh'], ['ч', 'ch'], ['ц', 'ts'], ['ж', 'zh'],
  ['ю', 'yu'], ['я', 'ya'], ['ё', 'e'], ['э', 'e'], ['ы', 'y'],
  ['й', 'i'], ['ї', 'i'], ['і', 'i'], ['є', 'ie'], ['ґ', 'g'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'],
  ['е', 'e'], ['з', 'z'], ['и', 'i'], ['к', 'k'], ['л', 'l'],
  ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'],
  ['с', 's'], ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'h'],
  // The soft and hard signs carry no sound of their own and are dropped: a
  // Latin-script row never spells them, so emitting anything would guarantee a
  // miss.
  ['ь', ''], ['ъ', ''],
];

/**
 * German is the site's default language and the largest market, so the umlauts
 * get their conventional expansion BEFORE the marks are stripped.
 *
 * `ü` -> `ue` and `ü` -> `u` are both real spellings a person might type
 * ("Muenchen", "Munchen"), which is why `searchKeys` below returns both forms
 * rather than choosing one.
 */
const GERMAN: ReadonlyArray<readonly [string, string]> = [
  ['ä', 'ae'], ['ö', 'oe'], ['ü', 'ue'], ['ß', 'ss'],
];

/** Lower-case, strip diacritics, collapse whitespace. No transliteration. */
function fold(input: string): string {
  return input
    .normalize('NFD')
    // Combining marks. This is what turns `ü` into `u` and `š` into `s`.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function transliterate(input: string): string {
  let out = input.toLowerCase();
  for (const [from, to] of CYRILLIC) out = out.split(from).join(to);
  return out;
}

/**
 * The single canonical form of a piece of free text: folded and transliterated.
 *
 * This is what gets STORED, and what a query is reduced to before matching.
 * Everything else in this file exists to generate the alternatives that should
 * also reach it.
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return '';
  return fold(transliterate(input));
}

/**
 * Cities whose names are different WORDS in different languages.
 *
 * Folding and transliteration cannot reach these - "Москва" transliterates to
 * "moskva", and no rule turns that into "moscow". Each entry lists every
 * spelling that means one place; a query matching any of them searches for all
 * of them.
 *
 * Kept short and honest on purpose. This is a list of exceptions, not a
 * gazetteer: the moment it wants to be complete it should be a geocoder
 * instead. Entries are the places this marketplace actually trades in.
 *
 * Entries may be written in their OWN script. Every one is put through
 * `normalizeSearchText` when the index is built, so "Мюнхен" is stored as the
 * transliteration it actually produces rather than as a guess somebody typed
 * into this table by hand - which is how "miunhen" got here and why it never
 * matched anything.
 */
const CITY_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['moskva', 'moscow', 'moskau', 'Москва'],
  ['kiev', 'kyiv', 'kiew', 'Киев', 'Київ'],
  ['wien', 'vienna', 'vena', 'Вена'],
  ['praha', 'prague', 'prag', 'Прага'],
  ['warszawa', 'warsaw', 'warschau', 'Варшава'],
  ['munchen', 'muenchen', 'munich', 'Мюнхен'],
  ['koln', 'koeln', 'cologne', 'Кёльн', 'Кельн'],
  ['zurich', 'zuerich', 'Цюрих'],
  ['berlin', 'Берлин'],
  ['hamburg', 'Гамбург'],
  ['frankfurt', 'Франкфурт'],
  ['stuttgart', 'Штутгарт'],
  ['dusseldorf', 'duesseldorf', 'Дюссельдорф'],
  ['leipzig', 'Лейпциг'],
  ['dresden', 'Дрезден'],
  ['paris', 'Париж'],
  ['london', 'Лондон'],
  ['madrid', 'Мадрид'],
  ['barcelona', 'Барселона'],
  ['amsterdam', 'Амстердам'],
  ['nurnberg', 'nuernberg', 'nuremberg'],
  ['hannover', 'hanover'],
  ['braunschweig', 'brunswick'],
  ['lisboa', 'lisbon', 'lissabon'],
  ['milano', 'milan', 'mailand'],
  ['roma', 'rome', 'rom'],
  ['torino', 'turin'],
  ['firenze', 'florence', 'florenz'],
  ['napoli', 'naples', 'neapel'],
  ['venezia', 'venice', 'venedig'],
  ['genova', 'genoa', 'genua'],
  ['antwerpen', 'antwerp', 'anvers'],
  ['brussel', 'bruxelles', 'brussels', 'bruessel'],
  ['den haag', 'the hague', 'la haye', 'haag'],
  ['gent', 'ghent'],
  ['liege', 'luik', 'luttich'],
  ['athina', 'athens', 'athen'],
  ['beograd', 'belgrade', 'belgrad'],
  ['bucuresti', 'bucharest', 'bukarest'],
  ['sofiya', 'sofia'],
  ['zagreb', 'agram'],
  ['ljubljana', 'laibach'],
  ['bratislava', 'pressburg'],
  ['gdansk', 'danzig'],
  ['wroclaw', 'breslau'],
  ['krakow', 'cracow', 'krakau'],
  ['poznan', 'posen'],
  ['szczecin', 'stettin'],
  ['lodz', 'lodsch'],
  ['lviv', 'lvov', 'lemberg', 'lwow', 'Львов', 'Львів'],
  ['odesa', 'odessa', 'Одесса', 'Одеса'],
  ['kharkiv', 'charkiw', 'Харьков', 'Харків'],
  ['dnipro', 'dnepr', 'dnipropetrovsk', 'Днепр'],
  ['sankt peterburg', 'saint petersburg', 'st petersburg', 'petersburg', 'Санкт-Петербург'],
  ['goteborg', 'gothenburg', 'gotheborg'],
  ['kobenhavn', 'copenhagen', 'kopenhagen'],
  ['helsinki', 'helsingfors'],
  ['tallinn', 'reval'],
  ['riga', 'ryga'],
  ['vilnius', 'wilna', 'wilno'],
  ['tbilisi', 'tiflis'],
  ['istanbul', 'stambul', 'konstantinopol'],
  ['izmir', 'smyrna'],
  ['basel', 'basle', 'bale'],
  ['geneve', 'geneva', 'genf', 'zheneva'],
  ['bern', 'berne'],
  ['luzern', 'lucerne'],
  ['salzburg', 'salcburg'],
  ['graz', 'gradec'],
  ['sevilla', 'seville'],
  ['zaragoza', 'saragossa'],
  ['a coruna', 'la coruna', 'corunna'],
  ['donostia', 'san sebastian'],
  ['marseille', 'marseilles'],
  ['lyon', 'lyons'],
  ['dunkerque', 'dunkirk'],
  ['strasbourg', 'strassburg', 'straatsburg'],
];

/** Built once: every spelling in a group points at the whole group. */
const ALIAS_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, readonly string[]>();
  for (const group of CITY_ALIAS_GROUPS) {
    const normalized = group.map((name) => normalizeSearchText(name));
    for (const name of normalized) index.set(name, normalized);
  }
  return index;
})();

/**
 * Every normalized string a search for `input` should also look for.
 *
 * Returns at least one entry for any non-empty input, and an EMPTY array for a
 * blank one - a caller reads that as "no city filter", which is the honest
 * reading of a box the user left empty or filled with spaces.
 *
 * The German expansions are added as alternatives rather than replacing the
 * plain fold, because both spellings occur in real data: a row geocoded in
 * German holds "München", one typed by hand may hold "Muenchen", and a buyer
 * may type either or neither.
 */
export function citySearchKeys(input: string | null | undefined): string[] {
  const base = normalizeSearchText(input);
  if (!base) return [];

  const keys = new Set<string>([base]);

  // "München" folds to "munchen"; also offer "muenchen".
  let german = input!.toLowerCase();
  for (const [from, to] of GERMAN) german = german.split(from).join(to);
  const germanKey = normalizeSearchText(german);
  if (germanKey) keys.add(germanKey);

  /*
   * And the reverse: a query written "Muenchen" should reach a row stored
   * "München", which normalizes to "munchen".
   *
   * Only when it actually changes something, and only when what is left is
   * still a word. Without the length floor a two-letter remainder becomes a
   * `contains` that matches half the table - and the collapse fires on words
   * that have no umlaut behind them at all ("Prague" -> "pragu", "Toulouse" ->
   * "toulose"), which is harmless as an extra candidate and would not be if it
   * were short.
   */
  const collapsed = base.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
  if (collapsed !== base && collapsed.length >= 3) keys.add(collapsed);

  for (const key of [...keys]) {
    for (const alias of ALIAS_INDEX.get(key) ?? []) keys.add(alias);
  }

  return [...keys];
}

/**
 * The same fold, with every separator removed as well - DEN-205.
 *
 * For a MAKE and a MODEL rather than a place. Those are catalogue strings whose
 * punctuation is not agreed on by anybody: the table holds "Mercedes-Benz" and
 * "C 220", and a buyer types "mercedes benz", "Mercedes", "C220" or "c-220"
 * meaning the same car. Dropping the separators on both sides makes all of
 * those one string, which a place name must NOT do - "Bad Homburg" and
 * "Badhomburg" are the same town, but collapsing "Frankfurt am Main" would let
 * a search for "Main" reach it through the middle of a word.
 *
 * Digits are kept, obviously: they are most of what a model name is.
 */
export function normalizeCompact(input: string | null | undefined): string {
  return normalizeSearchText(input).replace(/[^a-z0-9]/g, '');
}
