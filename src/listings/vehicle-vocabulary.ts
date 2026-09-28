/**
 * The closed vocabularies behind the showroom's fuel, gearbox and colour
 * filters, and the folding that gets a real row into one of them.
 *
 * WHY THIS EXISTS. These three columns are declared `@IsString() @MaxLength(32)`
 * on `ReportVehicleDto` and nothing has ever constrained what reaches them.
 * Three writers fill them and only one agrees with the others:
 *
 *   - the website's manual editor validates against a zod enum and writes the
 *     slugs below (`carsalepro-frontend/lib/listing-vehicle.ts`);
 *   - the mobile app copies the VIN decoder's answer through unchanged, and
 *     NHTSA writes prose - "Gasoline", "Flexible Fuel Vehicle (FFV)";
 *   - a legacy report carries whatever an inspector typed, in their own
 *     language.
 *
 * A dropdown filter over that column therefore answers "Petrol" with the rows
 * that happened to be written by the editor and silently drops the rest. The
 * fold below is applied at the one place every provenance passes through
 * (`projectVehicleColumns`), so the column holds a slug whoever wrote it.
 *
 * THE SLUGS ARE A MIRROR, NOT A NEW DECISION. `FUEL_TYPES` and `TRANSMISSIONS`
 * match the frontend's zod enums value for value, and `COLOURS` matches
 * `kStandardColours` in `carsalepro-mobile/lib/core/catalog/standard_colours.dart`
 * - the same thirteen the inspector's own picker draws. Adding a value here
 * without adding it there gives the showroom a filter whose label the website
 * cannot render.
 *
 * AN UNRECOGNISED VALUE KEEPS ITS OWN WORDS. Every folding function returns the
 * trimmed input when no rule matches, never null. The column is read by the
 * detail page as well as by the filter, and blanking "Nardo grey metallic"
 * because it is not one of thirteen destroys a fact about the car to tidy a
 * dropdown. Such a row is simply not returned by a colour filter, which is the
 * same treatment a row with no colour at all gets.
 */

export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'cng'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

/**
 * Two values, and a continuously variable or robotised gearbox folds into
 * `automatic`.
 *
 * A buyer choosing a gearbox is asking whether there is a clutch pedal, and a
 * CVT, a DSG and a torque converter all answer that the same way. Minting
 * `cvt` and `robot` as their own slugs - which AutoRia does - would need the
 * seller editor, the labels in 35 catalogues and the mobile decode to learn
 * them together; until they do, a row folded to `cvt` here would be invisible
 * to a filter the site can offer.
 */
export const TRANSMISSIONS = ['manual', 'automatic'] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

/** The thirteen standard body colours of the inspector's picker. */
export const COLOURS = [
  'white',
  'black',
  'grey',
  'silver',
  'blue',
  'red',
  'green',
  'yellow',
  'orange',
  'brown',
  'beige',
  'gold',
  'purple',
] as const;
export type Colour = (typeof COLOURS)[number];

/**
 * A fold is an ORDERED list of (slug, needles), and the order carries meaning.
 *
 * The needles are matched as substrings of the lower-cased input, so the first
 * rule that hits wins. `hybrid` is therefore listed before `petrol`: a decoder
 * that answers "Gasoline Hybrid" is describing a hybrid, and a rule list
 * sorted by slug would have called it petrol.
 */
type FoldRule<T extends string> = readonly [T, readonly string[]];

function fold<T extends string>(rules: readonly FoldRule<T>[], raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hay = trimmed.toLowerCase();
  for (const [slug, needles] of rules) {
    if (needles.some((needle) => hay.includes(needle))) return slug;
  }
  // Unrecognised: the row keeps the words somebody actually wrote.
  return trimmed;
}

/*
 * The needles are lower case and are matched as SUBSTRINGS, which is what lets
 * one entry cover "Diesel", "diesel engine" and "Дизель 2.0". German and
 * Russian spellings are here because legacy reports were typed by inspectors,
 * not chosen from a list.
 */
const FUEL_RULES: readonly FoldRule<FuelType>[] = [
  // Before petrol and before electric: a hybrid names both of them.
  ['hybrid', ['hybrid', 'hibrid', 'phev', 'mhev', 'hev', 'гибрид', 'гібрид']],
  [
    'electric',
    ['electric', 'elektro', 'elektrisch', 'bev', 'ev only', 'электр', 'електр'],
  ],
  ['diesel', ['diesel', 'tdi', 'hdi', 'cdi', 'дизель', 'дизел']],
  // "Autogas" and the Russian ГБО both mean a retrofitted LPG installation.
  ['lpg', ['lpg', 'autogas', 'propane', 'liquefied petroleum', 'гбо', 'сжиженн']],
  ['cng', ['cng', 'compressed natural', 'erdgas', 'methane', 'метан']],
  /*
   * Last, and the widest net. "Flexible Fuel Vehicle (FFV)" is an NHTSA answer
   * for a car that runs on petrol or on E85, and a buyer looking for a petrol
   * car wants to see it.
   */
  [
    'petrol',
    ['petrol', 'gasoline', 'benzin', 'бензин', 'flexible fuel', 'ffv', 'e85', 'gas'],
  ],
];

const TRANSMISSION_RULES: readonly FoldRule<Transmission>[] = [
  /*
   * Automatic is tested FIRST and this is not arbitrary. "Automated manual"
   * (AMT) and "semi-automatic" both contain the word `manual`, and both have no
   * clutch pedal - which is the question the filter asks.
   */
  [
    'automatic',
    [
      'automat',
      'автомат',
      'cvt',
      'variator',
      'варіатор',
      'вариатор',
      'dsg',
      'tiptronic',
      'steptronic',
      's tronic',
      's-tronic',
      'pdk',
      'robot',
      'робот',
      'amt',
      'акпп',
      'a/t',
    ],
  ],
  ['manual', ['manual', 'manuell', 'schalt', 'механ', 'ручн', 'мкпп', 'm/t']],
];

const COLOUR_RULES: readonly FoldRule<Colour>[] = [
  /*
   * Silver before grey: "silbergrau" and "серо-серебристый" are silver, and a
   * grey rule tested first would swallow both. The same reason puts the
   * compound colours ahead of their components everywhere in this list.
   */
  ['silver', ['silver', 'silber', 'серебр', 'срібл']],
  ['grey', ['grey', 'gray', 'grau', 'сер']],
  ['white', ['white', 'weiss', 'weiß', 'бел', 'біл']],
  ['black', ['black', 'schwarz', 'чёрн', 'черн', 'чорн']],
  ['blue', ['blue', 'blau', 'син', 'голуб']],
  ['red', ['red', 'rot', 'красн', 'червон']],
  ['green', ['green', 'grun', 'grün', 'зелен', 'зелён']],
  ['yellow', ['yellow', 'gelb', 'желт', 'жёлт', 'жовт']],
  ['orange', ['orange', 'оранж', 'помаранч']],
  ['brown', ['brown', 'braun', 'коричн', 'бур']],
  ['beige', ['beige', 'беж']],
  ['gold', ['gold', 'золот']],
  ['purple', ['purple', 'violet', 'violett', 'lila', 'фиолет', 'фіолет', 'сирен']],
];

/** Fold a free-text fuel value onto a {@link FUEL_TYPES} slug. */
export function normalizeFuelType(raw: unknown): string | null {
  return fold(FUEL_RULES, raw);
}

/** Fold a free-text gearbox value onto a {@link TRANSMISSIONS} slug. */
export function normalizeTransmission(raw: unknown): string | null {
  return fold(TRANSMISSION_RULES, raw);
}

/** Fold a free-text colour value onto a {@link COLOURS} slug. */
export function normalizeColour(raw: unknown): string | null {
  return fold(COLOUR_RULES, raw);
}
