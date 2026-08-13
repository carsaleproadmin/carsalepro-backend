import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryOwner,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistorySummary,
  VinHistoryTheft,
} from './vin-history-payload-v1';
import {
  VinHistoryBrand,
  VinHistoryEquipment,
  VinHistoryInspectionValidity,
  VinHistoryInsuranceRecord,
  VinHistoryMarketValue,
  VinHistoryPayload,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  VinHistoryServiceRecord,
  VinHistorySource,
  VinHistorySummaryV2,
  VinHistoryTheftCoverage,
  VinHistoryTimeToSell,
  VinHistoryVehicle,
  isVinHistoryPayloadV2,
} from './vin-history-payload-v2';
import {
  VinHistoryPdfLocale,
  VinHistoryPdfStrings,
  VinHistorySectionStrings,
  resolveVinHistoryPdfLocale,
  vinHistoryPdfStrings,
} from './vin-history-pdf.i18n';

/**
 * The paid VIN history document, as data.
 *
 * This layer holds every content rule; `vin-history-pdf.renderer.ts` only draws
 * what it is handed. The split is deliberate: a PDF is close to unassertable in
 * a test (embedded subset fonts make the text unreadable without a parser), so
 * anything a test needs to pin — which sections exist, what an empty one says,
 * how money and durations are computed, whether a suspicious reading is marked
 * — has to be observable BEFORE it becomes ink.
 *
 * BOTH CONTRACT VERSIONS RENDER FROM HERE. `buildVinHistoryReportModel` takes
 * the union and branches once, through `isVinHistoryPayloadV2`. A v1 payload
 * must produce exactly the document it produced before v2 existed, down to the
 * section list and the wording of every empty note: those payloads are frozen
 * artefacts that buyers have already paid for, and a document that shifts under
 * them is a document nobody can rely on. The v2 sections, the vehicle block and
 * the sources block are ADDITIONS, reachable only from a v2 payload.
 *
 * Rules that are contractual, not cosmetic:
 *
 * - **Every section is always present.** An empty array renders its
 *   `emptyNote`, never a missing section. "No accident records" and "we hold no
 *   accident data" are different claims to make to someone deciding to buy a
 *   car, and silence reads as the first one.
 * - **A v2 empty note says WHICH of three things happened**, from
 *   `payload.coverage`: the source was queried and holds nothing (a finding
 *   about the car, and a reassuring one), the source could not be reached, or
 *   the source never holds this kind of record. The last two are statements
 *   about the SOURCE and say so in as many words. Service history is
 *   permanently `not_covered` today — a buyer who paid partly to see it must
 *   read that, not a blank table that reads as "this car was never serviced".
 *   A v1 payload has no coverage map, so it keeps its original wording.
 * - **One retrieval date.** The document states `retrievedAt` once, sourced
 *   from the payload's `generatedAt`. The purchase date and the render date are
 *   separate, differently labelled facts — the audit found the same report
 *   printing two dates that both looked like "when the data was pulled".
 * - **Durations are computed here, from these dates.** A provider's
 *   `durationMonths` is not printed: a record spanning 2019-03 to 2019-12 came
 *   back labelled "12 months" from one of them.
 * - **Ownership periods cannot overlap.** Two owners of one car at one time is
 *   impossible; where the records say so, the earlier period ends where the
 *   next begins, and the row says it was adjusted.
 * - **One field name means one thing.** `countryCodes` is a list of codes,
 *   `countryCount` is a number. The payload's `countriesSeen` fed a field named
 *   `registrationCount` in one place and a count in another.
 * - **Nothing here throws.** An unknown enum value renders as its raw text, an
 *   unparsable date renders as itself, an unknown currency falls back to a
 *   plain amount plus the code. A provider adding a value must not break a
 *   download someone has already paid for.
 * - **The document names no data source.** Not a company, not a registry, not
 *   a dataset — not in the meta block, not beside the decoded vehicle, not in
 *   the recalls table, and not in the provenance chapter, which keeps every
 *   entry's STATUS and drops its identity. Which suppliers stand behind the
 *   report is commercial information; that a query was answered, failed or was
 *   never made is what the buyer is owed.
 * - **`synthetic` is the exception and stays everywhere** — the frame, the
 *   warning, every page footer. Hiding WHO supplied data is a commercial
 *   choice; hiding that data was GENERATED is a lie.
 * - **Several valuations are printed as several rows, never as one number.**
 *   Sources price different things; an average of two ladders is a figure no
 *   source stands behind and no buyer can check.
 */

/**
 * The sections a v1 document has, in the order it prints them. FROZEN — every
 * stored v1 payload renders through this list and must keep doing so.
 */
export const VIN_HISTORY_REPORT_SECTION_IDS = [
  'owners',
  'mileage',
  'damages',
  'registrations',
  'recalls',
  'theft',
  'inspections',
] as const;

/**
 * The sections a v2 document has, in the order it prints them.
 *
 * Same ids as `VIN_HISTORY_V2_SECTION_IDS` on the contract — coverage is looked
 * up by these, and a spec asserts the two lists are set-equal so a chapter added
 * to the contract cannot ship as a silently missing one — but a reading order
 * rather than a declaration order: what the car IS and what happened to it first
 * (owners, mileage, damage, the insurer's verdict on that damage, the brand a
 * state put on the title), then the administrative record, then the categories
 * that describe rather than report. `service` sits with them because with
 * today's provider it is always the "this source does not hold it" note, and
 * that belongs after the findings.
 *
 * The two chapters the second source brought are placed by what they answer,
 * not by when they arrived. `inspectionValidity` follows `inspections` because
 * a reader who has just read the test history asks next when the certificate
 * runs out — they are adjacent and separate, never merged, or "valid until
 * 2028" reads as "passed in 2028". `timeToSell` closes the document beside
 * `marketValue`: both describe a MARKET rather than this car, and that is the
 * end of the report for good reason.
 */
export const VIN_HISTORY_V2_REPORT_SECTION_IDS = [
  'owners',
  'mileage',
  'damages',
  'insurance',
  'brands',
  'registrations',
  'recalls',
  'theft',
  'inspections',
  'inspectionValidity',
  'service',
  'equipment',
  'marketValue',
  'timeToSell',
] as const;

export type VinHistoryReportSectionId = (typeof VIN_HISTORY_V2_REPORT_SECTION_IDS)[number];

/** Em dash. One placeholder for "no value", everywhere in the document. */
export const NO_VALUE = '—';

export type VinHistoryReportTone = 'neutral' | 'alert' | 'ok';

export interface VinHistoryReportEntry {
  id: string;
  label: string;
  value: string;
}

export interface VinHistoryReportHighlight extends VinHistoryReportEntry {
  tone: VinHistoryReportTone;
}

export interface VinHistoryReportRow {
  cells: string[];
  /** Draws the row's attention marker — rollback evidence, salvage, an open recall. */
  flagged: boolean;
  /** Free-text lines printed under the row (description, defects, adjustments). */
  notes: string[];
}

export interface VinHistoryReportSection {
  id: VinHistoryReportSectionId;
  title: string;
  columns: string[];
  rows: VinHistoryReportRow[];
  /** Non-null exactly when `rows` is empty. The section is printed either way. */
  emptyNote: string | null;
  /**
   * What the payload said happened when this section's source was consulted, and
   * therefore which of the three empty notes was chosen. Null for a v1 payload,
   * which carries no coverage map — that is the marker for "today's wording".
   */
  coverage: VinHistorySectionCoverage | null;
}

/**
 * The opening block: which car this VIN decoded to. v2 only.
 *
 * A field the decoder did not know is absent from `entries` rather than printed
 * with a placeholder — an empty row beside "Fuel" tells the reader nothing and
 * costs a line. When it knew nothing at all the whole block is null: a heading
 * with no fields under it is not a header block.
 *
 * There is no "decoded by" note. The decoder is a data source like any other,
 * and this document names none.
 */
export interface VinHistoryReportVehicle {
  title: string;
  entries: VinHistoryReportEntry[];
}

export interface VinHistoryReportSourceLine {
  /**
   * A neutral position — "Source 1", "Source 2" — and never a name.
   *
   * The upstream id and the dataset name are dropped here rather than at the
   * renderer, so no future drawing code can reach them.
   */
  label: string;
  /** The raw status, whatever the provider sent. */
  status: string;
  statusLabel: string;
  /**
   * `alert` for a source that FAILED, neutral for everything else.
   *
   * A skipped source is a decision, not a fault — the provider deliberately does
   * not ask a US-only registry about a European VIN — and marking it red would
   * teach a reader to ignore the colour that matters. A source answering
   * normally is likewise not an achievement worth a green tick.
   */
  tone: VinHistoryReportTone;
}

/**
 * How many queries stand behind this document, and how each one answered. v2
 * only.
 *
 * This is the block that makes an `unavailable` section note checkable rather
 * than an apology: a reader can see that one position was not reachable and
 * another was never asked. It is deliberately ANONYMOUS — the status is the
 * product, the identity is not.
 */
export interface VinHistoryReportSources {
  title: string;
  note: string;
  columns: string[];
  lines: VinHistoryReportSourceLine[];
  emptyNote: string | null;
}

export interface VinHistoryReportCounts {
  /**
   * RECORDS this document contains — rows in the sections that report events.
   *
   * Equipment and market value are excluded on purpose: a colour list and a
   * valuation ladder are descriptions of the car, not things that happened to
   * it, and counting them would inflate the one number a buyer reads as "how
   * much is known about this car". Always 0 for the v2-only categories on a v1
   * payload, so the v1 total is unchanged.
   */
  records: number;
  owners: number;
  mileage: number;
  damages: number;
  registrations: number;
  recalls: number;
  inspections: number;
  // v2 only; 0 on a v1 payload.
  insurance: number;
  brands: number;
  service: number;
  /** How many countries — the list is `countryCodes`. */
  countryCount: number;
}

export interface VinHistoryReportModel {
  locale: VinHistoryPdfLocale;
  /** Which contract this document was built from. 1 or 2, never guessed. */
  schemaVersion: 1 | 2;
  vin: string;
  /**
   * Deliberately NO `provider` field.
   *
   * It used to be printed in the meta block as "Data source: carsxe". The
   * payload still carries it — it is half of a cache key and the provenance of
   * a purchase — but nothing that reaches the page may hold it, or the next
   * person to add a header has it to hand.
   */
  synthetic: boolean;

  title: string;
  subtitle: string;

  /** Non-null exactly when `synthetic` — the frame AND the per-page footer text. */
  syntheticWarning: {
    badge: string;
    title: string;
    body: string;
    footer: string;
  } | null;

  meta: VinHistoryReportEntry[];
  /** The decoded vehicle. Null for v1, which has no such field. */
  vehicle: VinHistoryReportVehicle | null;
  highlightsTitle: string;
  highlights: VinHistoryReportHighlight[];
  sections: VinHistoryReportSection[];
  /** The datasets behind the document. Null for v1, which does not name them. */
  sources: VinHistoryReportSources | null;

  counts: VinHistoryReportCounts;
  /** ISO country codes, in the order the document first shows them. */
  countryCodes: string[];
  /**
   * What the provider's own summary claimed. Kept for reconciliation and NOT
   * printed as a second headline: a "23 records" banner above twelve printed
   * rows is exactly the self-contradiction this model exists to remove.
   */
  providerRecordCount: number;

  /**
   * The line that closes the document. Null for v1, which had one source.
   *
   * States that the report draws on several independent vehicle-data sources
   * and stops there: no count, no ranking, no names.
   */
  closingNote: string | null;

  footerText: string;
  pageLabel: (current: number, total: number) => string;
}

export interface VinHistoryReportModelOptions {
  locale?: string | null;
  purchaseId?: string | null;
  purchasedAt?: Date | string | null;
  renderedAt?: Date | string | null;
}

// ============================================================
// Formatting primitives
// ============================================================

/** Intl needs a region to pick separators and currency placement. */
const INTL_LOCALE: Record<VinHistoryPdfLocale, string> = {
  de: 'de-DE',
  en: 'en-GB',
  ru: 'ru-RU',
};

/**
 * ICU emits NBSP/narrow-NBSP inside formatted numbers. They render fine, but
 * they make every string here depend on an invisible character, which turns a
 * failed assertion into a five-minute stare. Normalised to plain spaces.
 */
function normalizeSpaces(value: string): string {
  // Written as escapes, not as the characters themselves: a literal NBSP in
  // source is invisible in every diff and every review.
  return value.replace(/[\u00a0\u202f\u2007\u2009]/g, ' ');
}

/**
 * Integer cents to a localized amount.
 *
 * Falls back to "1234.00 XYZ" for a currency Intl refuses rather than throwing:
 * a provider sending a bad code must not turn a paid download into a 500.
 */
export function formatCents(
  cents: number | null | undefined,
  currency: string | null | undefined,
  locale: VinHistoryPdfLocale,
): string {
  if (cents == null || !Number.isFinite(cents)) return NO_VALUE;
  const amount = cents / 100;
  const code = (currency ?? 'EUR').toUpperCase();
  const intl = INTL_LOCALE[locale];
  try {
    return normalizeSpaces(
      new Intl.NumberFormat(intl, { style: 'currency', currency: code }).format(amount),
    );
  } catch {
    const plain = normalizeSpaces(
      new Intl.NumberFormat(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        amount,
      ),
    );
    return `${plain} ${code}`;
  }
}

export function formatNumber(value: number | null | undefined, locale: VinHistoryPdfLocale): string {
  if (value == null || !Number.isFinite(value)) return NO_VALUE;
  return normalizeSpaces(new Intl.NumberFormat(INTL_LOCALE[locale]).format(value));
}

export function formatMileage(
  km: number | null | undefined,
  locale: VinHistoryPdfLocale,
  strings: VinHistoryPdfStrings,
): string {
  if (km == null || !Number.isFinite(km)) return NO_VALUE;
  return `${formatNumber(km, locale)} ${strings.units.km}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A date the way the locale writes one.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`, because ICU changes its
 * date patterns between Node releases and the output of this function is
 * asserted in tests; a document that reformats itself on a runtime upgrade is
 * not worth an assertion nobody can trust. Anything that is not an ISO date
 * passes through untouched — never an exception, never an "Invalid Date".
 */
export function formatIsoDate(
  value: string | null | undefined,
  locale: VinHistoryPdfLocale,
): string {
  if (value == null || value === '') return NO_VALUE;
  const m = ISO_DATE.exec(value);
  if (!m) return value;
  const [, year, month, day] = m;
  return locale === 'en' ? `${year}-${month}-${day}` : `${day}.${month}.${year}`;
}

/** A timestamp, always UTC and always the same shape — this is a document. */
export function formatTimestamp(value: Date | string | null | undefined): string {
  if (value == null || value === '') return NO_VALUE;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : NO_VALUE;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A provider value in the caller's language, or the value itself.
 *
 * The passthrough is the point: `severity: 'flood'` from a provider that added
 * a category must print "flood", not throw and not silently vanish from a
 * report someone paid for.
 */
export function translateEnum(
  dictionary: Record<string, string>,
  value: string | null | undefined,
): string {
  if (value == null || value === '') return NO_VALUE;
  return dictionary[value] ?? value;
}

/**
 * A machine token as something a reader can read — and NOTHING else.
 *
 * Sources publish `ALL_WHEEL_DRIVE` and `ELECTRIC_TRUNK`. Underscores become
 * spaces and the shout is dropped, because that is presentation. The words
 * themselves are never touched: `ELECTRIC_TRUNK` → "Electric boot" would be a
 * TRANSLATION, and translating a source's vocabulary is how a report ends up
 * asserting something the source never said.
 *
 * Anything that is not SCREAMING_SNAKE keeps the spelling it arrived with — an
 * acronym (`ABS`), a brand name and a sentence a human wrote are all spelled
 * that way on purpose. A single all-lowercase word (`automatic`) gets a capital
 * and nothing more.
 */
export function formatToken(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return '';
  if (text.includes('_') && text === text.toUpperCase()) {
    const words = text.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (text === text.toLowerCase()) return text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

/** Whole months between two ISO dates, or null when either is unusable. */
export function monthsBetween(from: string | null, to: string | null): number | null {
  const a = ISO_DATE.exec(from ?? '');
  const b = ISO_DATE.exec(to ?? '');
  if (!a || !b) return null;
  const [ya, ma, da] = [Number(a[1]), Number(a[2]), Number(a[3])];
  const [yb, mb, db] = [Number(b[1]), Number(b[2]), Number(b[3])];
  let months = (yb - ya) * 12 + (mb - ma);
  if (db < da) months -= 1;
  return months < 0 ? null : months;
}

function isoDay(value: string | null | undefined): string | null {
  const m = ISO_DATE.exec(value ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Earliest of a set of ISO dates, ignoring anything unparsable. */
function earliestIso(values: (string | null | undefined)[]): string | null {
  const days = values.map(isoDay).filter((d): d is string => d !== null);
  return days.length > 0 ? days.sort()[0] : null;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A payload field that is supposed to be an object, or null.
 *
 * Payloads come back out of a JSON column, so "supposed to be" is all we have.
 * Anything else is read as "not supplied", which is the safe reading: a section
 * that says nothing beats a section that invents something.
 */
function objectOrNull<T>(value: T | null | undefined): T | null {
  return value != null && typeof value === 'object' ? value : null;
}

/**
 * The document's own day, as an ISO date — the horizon an expiry is measured
 * against. Null when there is no usable date, in which case nothing is called
 * expired.
 */
function documentDay(value: Date | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return isoDay(typeof value === 'string' ? value : null);
}

// ============================================================
// Ownership periods
// ============================================================

export interface VinHistoryOwnerPeriod {
  sequence: number;
  type: string | null;
  countryCode: string | null;
  from: string | null;
  /** Null means the period is still open at `endOfRecord`. */
  to: string | null;
  /** True when the stated end was moved (or filled in) to remove an overlap. */
  adjusted: boolean;
  durationMonths: number | null;
}

/**
 * Order the ownership records and make the periods disjoint.
 *
 * Two owners cannot hold one car at the same time, so where the records overlap
 * the earlier period is closed at the point the next one starts — and the row
 * says so, because moving a date silently is worse than the overlap. An open
 * final period is measured to `endOfRecord` (the retrieval date), which is the
 * latest moment the data can speak for.
 */
export function normalizeOwnerPeriods(
  owners: VinHistoryOwner[],
  endOfRecord: string | null,
): VinHistoryOwnerPeriod[] {
  const ordered = [...asArray(owners)].sort((a, b) => {
    const bySeq = (a.sequence ?? 0) - (b.sequence ?? 0);
    if (bySeq !== 0) return bySeq;
    return (isoDay(a.fromDate) ?? '').localeCompare(isoDay(b.fromDate) ?? '');
  });

  return ordered.map((owner, index) => {
    const from = isoDay(owner.fromDate);
    const statedTo = isoDay(owner.toDate);
    const nextFrom = isoDay(ordered[index + 1]?.fromDate);

    let to = statedTo;
    let adjusted = false;
    if (nextFrom !== null && (statedTo === null || statedTo > nextFrom)) {
      to = nextFrom;
      adjusted = true;
    }

    return {
      sequence: owner.sequence ?? index + 1,
      type: owner.type ?? null,
      countryCode: owner.countryCode ?? null,
      from,
      to,
      adjusted,
      durationMonths: monthsBetween(from, to ?? endOfRecord),
    };
  });
}

// ============================================================
// Theft register coverage
// ============================================================

/**
 * How much a theft answer is actually worth.
 *
 * - `unknown`  — the payload does not say which registers were searched. Every
 *                v1 payload, and a v2 payload from a source with no such field.
 *                Today's wording, and no new claim in either direction.
 * - `none`     — an empty list: nothing was searched at all.
 * - `partial`  — something was searched, but not every country this document
 *                puts the car in — or the document never established one.
 * - `complete` — every country the document names was among the registers.
 */
export type VinHistoryTheftAssurance = 'unknown' | 'none' | 'partial' | 'complete';

export interface VinHistoryTheftRegisters {
  state: VinHistoryTheftAssurance;
  /** The registers actually searched, upper-cased and de-duplicated. */
  searched: string[];
  /** Countries this document puts the car in that no register covered. */
  missing: string[];
}

/**
 * WHICH theft registers were searched, and whether they could have known about
 * THIS car.
 *
 * The most consequential computation in the document. A source covering five
 * national registers answers "not stolen" for a car registered in a sixth
 * having searched nothing that would know, and printing that as a clean result
 * is how somebody buys a stolen car on the strength of a report they paid for.
 *
 * A car with no country at all is treated as `partial`, not `complete`: we
 * cannot show the search was relevant to it, which in practice is the same
 * answer as a country nobody searched.
 */
export function theftRegisters(
  coverage: VinHistoryTheftCoverage | null | undefined,
  countryCodes: string[],
): VinHistoryTheftRegisters {
  const held = objectOrNull(coverage);
  if (!held) return { state: 'unknown', searched: [], missing: [] };

  const searched = uniqueCountries(asArray(held.countryCodes));
  const missing = countryCodes.filter((code) => !searched.includes(code));
  if (searched.length === 0) return { state: 'none', searched, missing };

  const state: VinHistoryTheftAssurance =
    missing.length > 0 || countryCodes.length === 0 ? 'partial' : 'complete';
  return { state, searched, missing };
}

// ============================================================
// The model
// ============================================================

const EMPTY_SUMMARY: VinHistorySummary = {
  recordCount: 0,
  ownersCount: 0,
  countriesSeen: [],
  hasAccidentRecords: false,
  hasSalvageOrTotalLoss: false,
  hasOdometerRollback: false,
  hasStolenRecord: false,
  hasOpenRecalls: false,
  lastRecordedMileageKm: null,
  firstRegistration: null,
};

/**
 * The v1 defaults plus the v2 flags, all off.
 *
 * A v1 payload spread over this gets `false`/`0` for everything v2 added, which
 * is correct: those flags are only ever READ for a v2 payload, and a default of
 * "no finding" cannot invent one.
 */
const EMPTY_SUMMARY_V2: VinHistorySummaryV2 = {
  ...EMPTY_SUMMARY,
  hasCommercialUse: false,
  hasTitleBrand: false,
  hasInsuranceTotalLoss: false,
  insuranceRecordCount: 0,
  brandCount: 0,
  serviceRecordCount: 0,
};

const NO_THEFT: VinHistoryTheft = {
  stolen: false,
  reportedAt: null,
  countryCode: null,
  recoveredAt: null,
  source: null,
};

/**
 * The v2 view of a payload, or null.
 *
 * The null check is not paranoia: payloads come back out of a JSON column and
 * this function is on the path of a download someone has already paid for, so
 * it must survive a shape nobody predicted rather than throw.
 */
function asV2(payload: VinHistoryPayload): VinHistoryPayloadV2 | null {
  return payload && isVinHistoryPayloadV2(payload) ? payload : null;
}

/**
 * The coverage state for one section, or null when the payload does not say.
 *
 * Anything that is not one of the three known states is treated as "does not
 * say" — a provider inventing a fourth state must fall back to the neutral
 * wording, never print a raw enum value into a sentence a buyer reads.
 */
function sectionCoverage(
  coverage: VinHistoryPayloadV2['coverage'] | null | undefined,
  id: VinHistoryReportSectionId,
): VinHistorySectionCoverage | null {
  const state = coverage?.[id];
  return state === 'covered' || state === 'unavailable' || state === 'not_covered' ? state : null;
}

export function buildVinHistoryReportModel(
  payload: VinHistoryPayload,
  options: VinHistoryReportModelOptions = {},
): VinHistoryReportModel {
  const locale = resolveVinHistoryPdfLocale(options.locale);
  const s = vinHistoryPdfStrings(locale);

  // THE branch. Below this line `v2` is the only source of anything v1 has no
  // field for, and `payload` is read for everything both versions carry — which
  // is why a v1 payload walks exactly the code path it always did.
  const v2 = asV2(payload);

  const summary: VinHistorySummaryV2 = { ...EMPTY_SUMMARY_V2, ...(payload.summary ?? {}) };
  const owners = asArray<VinHistoryOwner>(payload.owners);
  const mileage = [...asArray<VinHistoryMileageRecord>(payload.mileageRecords)].sort((a, b) =>
    (isoDay(a.date) ?? '').localeCompare(isoDay(b.date) ?? ''),
  );
  const damages = asArray<VinHistoryDamageRecord>(payload.damageRecords);
  const registrations = asArray<VinHistoryRegistration>(payload.registrations);
  const recalls = asArray<VinHistoryRecall>(payload.recalls);
  const inspections = asArray<VinHistoryInspection>(payload.inspections);
  const theft: VinHistoryTheft = { ...NO_THEFT, ...(payload.theft ?? {}) };

  // Empty for a v1 payload, which makes every count, flag and section below
  // read exactly as it did before v2 existed.
  const insuranceRecords = asArray<VinHistoryInsuranceRecord>(v2?.insuranceRecords);
  const brands = asArray<VinHistoryBrand>(v2?.brands);
  const serviceRecords = asArray<VinHistoryServiceRecord>(v2?.serviceRecords);
  const equipment: VinHistoryEquipment | null = v2?.equipment ?? null;

  /*
   * The categories the second source brought. All optional on the contract,
   * which is what lets a payload written by one source stay valid beside one
   * written by two — absent and null read alike here: not supplied.
   */
  const marketValues = allMarketValues(v2);
  const timeToSell = objectOrNull<VinHistoryTimeToSell>(v2?.timeToSell);
  const inspectionValidity = objectOrNull<VinHistoryInspectionValidity>(v2?.inspectionValidity);

  // The single retrieval date, and the horizon every open period is measured to.
  const retrievedAt = payload.generatedAt ?? null;
  const endOfRecord = isoDay(retrievedAt);
  const synthetic = payload.synthetic === true;
  const renderedAt = options.renderedAt ?? new Date();

  const periods = normalizeOwnerPeriods(owners, endOfRecord);

  // The v2 sources are appended, never interleaved: the ORDER is "as the
  // document first shows them", and a v1 document must keep the list it had.
  //
  // Countries this CAR was in, and nothing else. The registers a theft check
  // searched are deliberately NOT folded in: they are compared against this
  // list, and a list that absorbed them would always agree with itself.
  const countryCodes = uniqueCountries([
    ...registrations.map((r) => r.countryCode),
    ...asArray(summary.countriesSeen),
    ...periods.map((p) => p.countryCode),
    ...insuranceRecords.map((i) => i.countryCode),
    ...brands.map((b) => b.countryCode),
    ...serviceRecords.map((r) => r.countryCode),
    // A statutory certificate is issued where the car is road-legal, so this is
    // a country the car is in — and one the theft check had better cover.
    inspectionValidity?.countryCode,
  ]);

  const registers = theftRegisters(v2?.theftCoverage, countryCodes);

  // A theft registry that answered "clean" is a finding; a provider that holds
  // no theft data is not. A per-record source, or a register that was actually
  // searched, is what distinguishes them.
  const theftAnswered =
    theft.stolen === true || (theft.source ?? null) !== null || registers.searched.length > 0;

  // Built BEFORE the counts, because the chapter may decline to print a row it
  // would otherwise have (nothing searched), and the record count has to match
  // what the reader can actually see.
  const theftTable = theftRows(theft, theftAnswered, registers, locale, s);

  const counts: VinHistoryReportCounts = {
    records:
      owners.length +
      mileage.length +
      damages.length +
      registrations.length +
      recalls.length +
      inspections.length +
      theftTable.length +
      insuranceRecords.length +
      brands.length +
      serviceRecords.length,
    owners: owners.length,
    mileage: mileage.length,
    damages: damages.length,
    registrations: registrations.length,
    recalls: recalls.length,
    inspections: inspections.length,
    insurance: insuranceRecords.length,
    brands: brands.length,
    service: serviceRecords.length,
    countryCount: countryCodes.length,
  };

  // Claim OR evidence. Keeping the provider's boolean means a summary that says
  // "accident records exist" is not erased by a tier that withholds the detail;
  // OR-ing the arrays in means a printed damage row is never headlined as "no
  // damage records".
  //
  // The v2 terms below are all empty on a v1 payload. They exist because the
  // same fact now arrives from more than one dataset: a write-off is an insurance
  // record AND a salvage title brand, and a headline saying "no salvage" above
  // either row is the contradiction this whole model exists to remove.
  const flags = {
    accidents: summary.hasAccidentRecords === true || damages.length > 0,
    salvage:
      summary.hasSalvageOrTotalLoss === true ||
      damages.some((d) => d.salvage === true || d.severity === 'total_loss') ||
      insuranceRecords.some((i) => i.totalLoss === true) ||
      brands.some((b) => b.category === 'salvage'),
    rollback:
      summary.hasOdometerRollback === true ||
      mileage.some((m) => m.suspicious === true) ||
      brands.some((b) => b.category === 'odometer'),
    stolen:
      summary.hasStolenRecord === true ||
      theft.stolen === true ||
      brands.some((b) => b.category === 'theft'),
    openRecalls: summary.hasOpenRecalls === true || recalls.some((r) => r.open === true),
    titleBrand: summary.hasTitleBrand === true || brands.length > 0,
    commercialUse:
      summary.hasCommercialUse === true || brands.some((b) => b.category === 'commercial'),
    insuranceTotalLoss:
      summary.hasInsuranceTotalLoss === true || insuranceRecords.some((i) => i.totalLoss === true),
  };

  // The table is what the buyer reads; the headline must agree with it.
  const lastMileageKm =
    mileage.length > 0 ? mileage[mileage.length - 1].mileageKm : summary.lastRecordedMileageKm;
  const firstRegistration = earliestIso([
    summary.firstRegistration,
    ...registrations.map((r) => r.firstRegistration),
  ]);

  // No provider row. It used to read "Data source: carsxe"; the identity of a
  // supplier is not part of what was bought.
  const meta: VinHistoryReportEntry[] = [
    { id: 'vin', label: s.meta.vin, value: payload.vin ?? NO_VALUE },
    { id: 'retrievedAt', label: s.meta.retrievedAt, value: formatTimestamp(retrievedAt) },
  ];
  if (options.purchasedAt) {
    meta.push({
      id: 'purchasedAt',
      label: s.meta.purchasedAt,
      value: formatTimestamp(options.purchasedAt),
    });
  }
  meta.push({
    id: 'renderedAt',
    label: s.meta.renderedAt,
    value: formatTimestamp(renderedAt),
  });
  if (options.purchaseId) {
    meta.push({ id: 'purchaseId', label: s.meta.purchaseId, value: options.purchaseId });
  }

  const yesNo = (value: boolean): string => (value ? s.values.yes : s.values.no);
  const alertIf = (value: boolean): VinHistoryReportTone => (value ? 'alert' : 'ok');

  const highlights: VinHistoryReportHighlight[] = [
    {
      id: 'records',
      label: s.highlights.records,
      value: formatNumber(counts.records, locale),
      tone: 'neutral',
    },
    {
      id: 'owners',
      label: s.highlights.owners,
      value: counts.owners > 0 ? formatNumber(counts.owners, locale) : NO_VALUE,
      tone: 'neutral',
    },
    {
      id: 'countries',
      label: s.highlights.countries,
      value:
        countryCodes.length > 0
          ? `${formatNumber(countryCodes.length, locale)} (${countryCodes.join(', ')})`
          : NO_VALUE,
      tone: 'neutral',
    },
    {
      id: 'firstRegistration',
      label: s.highlights.firstRegistration,
      value: formatIsoDate(firstRegistration, locale),
      tone: 'neutral',
    },
    {
      id: 'lastMileage',
      label: s.highlights.lastMileage,
      value: formatMileage(lastMileageKm, locale, s),
      tone: 'neutral',
    },
    {
      id: 'accidents',
      label: s.highlights.accidents,
      value: flags.accidents ? formatNumber(Math.max(counts.damages, 1), locale) : yesNo(false),
      tone: alertIf(flags.accidents),
    },
    {
      id: 'salvage',
      label: s.highlights.salvage,
      value: yesNo(flags.salvage),
      tone: alertIf(flags.salvage),
    },
    {
      id: 'rollback',
      label: s.highlights.rollback,
      value: yesNo(flags.rollback),
      tone: alertIf(flags.rollback),
    },
    {
      /*
       * A "no" here is only an all-clear if a register that could have known was
       * asked. Nothing searched is not a finding at all and says so; a partial
       * search keeps the "no" but loses the green tone, because `ok` is read as
       * a clean bill and the caveat lives down in the chapter.
       */
      id: 'stolen',
      label: s.highlights.stolen,
      value:
        !flags.stolen && registers.state === 'none' ? s.values.notChecked : yesNo(flags.stolen),
      tone: flags.stolen
        ? 'alert'
        : registers.state === 'unknown' || registers.state === 'complete'
          ? 'ok'
          : 'neutral',
    },
    {
      id: 'openRecalls',
      label: s.highlights.openRecalls,
      value: yesNo(flags.openRecalls),
      tone: alertIf(flags.openRecalls),
    },
  ];

  // v2 only. A v1 payload has nothing behind these three, and a headline with
  // no data behind it is the thing this document must never print.
  if (v2) {
    highlights.push(
      {
        id: 'titleBrands',
        label: s.highlights.titleBrands,
        value: flags.titleBrand ? formatNumber(Math.max(counts.brands, 1), locale) : yesNo(false),
        tone: alertIf(flags.titleBrand),
      },
      {
        id: 'commercialUse',
        label: s.highlights.commercialUse,
        value: yesNo(flags.commercialUse),
        tone: alertIf(flags.commercialUse),
      },
      {
        id: 'insuranceTotalLoss',
        label: s.highlights.insuranceTotalLoss,
        value: yesNo(flags.insuranceTotalLoss),
        tone: alertIf(flags.insuranceTotalLoss),
      },
    );
  }

  // Every section is built for both versions — the v2 ones are simply empty on a
  // v1 payload — and the ORDER decides which ones the document prints.
  const rowsById: Record<VinHistoryReportSectionId, VinHistoryReportRow[]> = {
    owners: ownerRows(periods, locale, s),
    mileage: mileageRows(mileage, locale, s),
    damages: damageRows(damages, locale, s),
    registrations: registrationRows(registrations, locale, s),
    recalls: recallRows(recalls, locale, s),
    theft: theftTable,
    inspections: inspectionRows(inspections, locale, s),
    inspectionValidity: inspectionValidityRows(
      inspectionValidity,
      documentDay(renderedAt),
      locale,
      s,
    ),
    insurance: insuranceRows(insuranceRecords, locale, s),
    brands: brandRows(brands, locale, s),
    service: serviceRows(serviceRecords, locale, s),
    equipment: equipmentRows(equipment, locale, s),
    marketValue: marketValueRows(marketValues, locale, s),
    timeToSell: timeToSellRows(timeToSell, locale, s),
  };

  const order: readonly VinHistoryReportSectionId[] = v2
    ? VIN_HISTORY_V2_REPORT_SECTION_IDS
    : VIN_HISTORY_REPORT_SECTION_IDS;

  /*
   * The one empty note the coverage map may not write.
   *
   * `covered` + no rows reads "we checked and this vehicle is not reported
   * stolen", which is exactly the sentence an empty register list cannot
   * support. Overriding it is narrower than teaching the coverage map about a
   * second dimension, and it only ever REPLACES a claim with a disclaimer.
   */
  const theftEmptyOverride = registers.state === 'none' ? s.notes.theftNoRegisterSearched : null;

  const sections: VinHistoryReportSection[] = order.map((id) =>
    section(
      id,
      s,
      rowsById[id],
      v2 ? sectionCoverage(v2.coverage, id) : null,
      id === 'theft' ? theftEmptyOverride : null,
    ),
  );

  return {
    locale,
    schemaVersion: v2 ? 2 : 1,
    vin: payload.vin ?? '',
    synthetic,
    title: s.documentTitle,
    subtitle: s.documentSubtitle,
    syntheticWarning: synthetic
      ? {
          badge: s.synthetic.badge,
          title: s.synthetic.title,
          body: s.synthetic.body,
          footer: s.synthetic.footer,
        }
      : null,
    meta,
    vehicle: v2 ? vehicleBlock(v2.vehicle, locale, s) : null,
    highlightsTitle: s.highlights.heading,
    highlights,
    sections,
    sources: v2 ? sourcesBlock(v2.sources, s) : null,
    counts,
    countryCodes,
    providerRecordCount: summary.recordCount ?? 0,
    // v1 documents came from one source and never claimed otherwise.
    closingNote: v2 ? s.closingNote : null,
    footerText: s.footer.disclaimer,
    pageLabel: s.footer.page,
  };
}

/**
 * Every valuation the payload carries, and never a blend of them.
 *
 * Two sources price a car differently because they are pricing different
 * things — one a retail ladder by condition, one a single market scalar — so an
 * average is a figure no source stands behind and no buyer can check. There is
 * deliberately no arithmetic anywhere on this path.
 *
 * `marketValues` is the full list when a payload has one; `marketValue` is the
 * single first-source view that predates it and is used ONLY when the list is
 * absent, so one valuation can never be printed twice.
 */
function allMarketValues(v2: VinHistoryPayloadV2 | null): VinHistoryMarketValue[] {
  const many = asArray(v2?.marketValues).filter(
    (value): value is VinHistoryMarketValue => objectOrNull(value) !== null,
  );
  if (many.length > 0) return many;
  const single = objectOrNull(v2?.marketValue);
  return single ? [single] : [];
}

function uniqueCountries(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const code = value.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Wrap rows in their section. The empty note is attached HERE, once, so no
 * caller can build a section that silently disappears when a provider returns
 * nothing for it.
 */
function section(
  id: VinHistoryReportSectionId,
  s: VinHistoryPdfStrings,
  rows: VinHistoryReportRow[],
  coverage: VinHistorySectionCoverage | null,
  /**
   * Replaces the coverage-derived note when the section knows something the
   * coverage map cannot express. Used by exactly one chapter — see the theft
   * override in `buildVinHistoryReportModel`.
   */
  emptyOverride: string | null = null,
): VinHistoryReportSection {
  const strings = s.sections[id];
  return {
    id,
    title: strings.title,
    columns: strings.columns,
    rows,
    emptyNote: rows.length === 0 ? (emptyOverride ?? emptyNote(strings, s, coverage)) : null,
    coverage,
  };
}

/**
 * WHY this section is empty, in the reader's language.
 *
 * Three different things can put a buyer in front of an empty table and only
 * one of them is about the car:
 *
 * - `covered`     — we asked and there is nothing. That is a finding, and for
 *                   damage or theft it is the finding they paid for.
 * - `unavailable` — we asked and the source did not answer this time.
 * - `not_covered` — the source never holds this kind of record at all.
 *
 * Anything else — a v1 payload, which has no coverage map, or a state we do not
 * recognise — keeps the original neutral wording. That is deliberate: v1
 * documents are already sold and must not change, and an unknown state is not a
 * licence to make a claim.
 */
function emptyNote(
  strings: VinHistorySectionStrings,
  s: VinHistoryPdfStrings,
  coverage: VinHistorySectionCoverage | null,
): string {
  if (coverage === 'covered') return strings.emptyCovered;
  if (coverage === 'unavailable') return s.coverageNotes.unavailable;
  if (coverage === 'not_covered') return s.coverageNotes.not_covered;
  return strings.empty;
}

function row(cells: string[], flagged = false, notes: (string | null | undefined)[] = []): VinHistoryReportRow {
  return {
    cells,
    flagged,
    notes: notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0),
  };
}

function ownerRows(
  periods: VinHistoryOwnerPeriod[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return periods.map((p) =>
    row(
      [
        String(p.sequence),
        translateEnum(s.enums.ownerType, p.type),
        p.countryCode ?? NO_VALUE,
        formatIsoDate(p.from, locale),
        p.to === null ? s.values.present : formatIsoDate(p.to, locale),
        p.durationMonths === null
          ? NO_VALUE
          : `${formatNumber(p.durationMonths, locale)} ${s.units.months}`,
      ],
      false,
      [p.adjusted ? s.notes.overlapAdjusted : null],
    ),
  );
}

function mileageRows(
  records: VinHistoryMileageRecord[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((m) =>
    row(
      [
        formatIsoDate(m.date, locale),
        formatMileage(m.mileageKm, locale, s),
        translateEnum(s.enums.mileageSource, m.source),
        m.countryCode ?? NO_VALUE,
      ],
      m.suspicious === true,
      [m.suspicious === true ? s.notes.suspiciousMileage : null],
    ),
  );
}

function damageRows(
  records: VinHistoryDamageRecord[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((d) => {
    const areas = asArray(d.areas)
      .map((a) => translateEnum(s.enums.damageArea, a))
      .join(', ');
    const salvage = d.salvage === true || d.severity === 'total_loss';
    return row(
      [
        formatIsoDate(d.date, locale),
        translateEnum(s.enums.damageSeverity, d.severity),
        areas.length > 0 ? areas : NO_VALUE,
        formatCents(d.estimatedRepairCostCents, d.currency, locale),
        salvage ? s.values.yes : s.values.no,
      ],
      salvage,
      [
        d.description,
        d.airbagDeployed === true ? s.notes.airbagDeployed : null,
        salvage ? s.notes.salvage : null,
      ],
    );
  });
}

function registrationRows(
  records: VinHistoryRegistration[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((r) =>
    row([
      r.countryCode ?? NO_VALUE,
      r.region ?? NO_VALUE,
      formatIsoDate(r.firstRegistration, locale),
      formatIsoDate(r.lastRegistration, locale),
      r.plateMasked ?? NO_VALUE,
      translateEnum(s.enums.registrationStatus, r.status),
    ]),
  );
}

/**
 * Recalls, WITHOUT the issuing authority.
 *
 * `authority` is filled by the mapper with the name of the registry the recall
 * was read from, so printing it names a data source in a table nobody would
 * think to check. The reference number stays: it is the manufacturer's own and
 * is what a garage needs to look the campaign up.
 */
function recallRows(
  records: VinHistoryRecall[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((r) =>
    row(
      [
        r.reference ?? NO_VALUE,
        formatIsoDate(r.issuedAt, locale),
        r.title ?? NO_VALUE,
        r.open === true ? s.values.open : s.values.closed,
      ],
      r.open === true,
      [r.description],
    ),
  );
}

/**
 * The theft chapter, and the wording that matters most in this document.
 *
 * Three answers have to stay apart, and only one of them is good news:
 *
 * - searched, and this car is not in any of them,
 * - searched somewhere that could not have known about this car,
 * - nothing searched at all.
 *
 * So the row states WHICH registers were searched, and a clean answer from an
 * incomplete search carries the caveat in as many words. Where NOTHING was
 * searched there is no row at all: "no theft record" would be a finding made
 * out of the absence of any query, and the chapter's note says so instead. A
 * positive hit always prints — that is a fact whoever else was asked.
 *
 * The `source` column is gone with it. It held the name of the register.
 */
function theftRows(
  theft: VinHistoryTheft,
  answered: boolean,
  registers: VinHistoryTheftRegisters,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  const stolen = theft.stolen === true;
  if (registers.state === 'none' && !stolen) return [];
  if (!answered) return [];

  const notes: (string | null)[] = [
    registers.searched.length > 0
      ? `${s.notes.theftRegistersSearched}: ${registers.searched.join(', ')}`
      : null,
  ];

  // Only under a clean answer. A confirmed theft record needs no explanation of
  // what a miss would have meant.
  if (!stolen && registers.state === 'partial') {
    notes.push(
      registers.missing.length > 0
        ? `${s.notes.theftRegistersIncomplete}: ${registers.missing.join(', ')}`
        : s.notes.theftCountryUnknown,
      s.notes.theftNotProof,
    );
  }

  return [
    row(
      [
        stolen ? s.values.stolen : s.values.notStolen,
        formatIsoDate(theft.reportedAt, locale),
        theft.countryCode ?? NO_VALUE,
        stolen
          ? theft.recoveredAt
            ? `${s.values.recovered} (${formatIsoDate(theft.recoveredAt, locale)})`
            : s.values.notRecovered
          : NO_VALUE,
      ],
      stolen,
      notes,
    ),
  ];
}

function inspectionRows(
  records: VinHistoryInspection[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((i) => {
    const defects = asArray(i.defects).filter((d) => typeof d === 'string' && d.length > 0);
    return row(
      [
        formatIsoDate(i.date, locale),
        i.authority ?? NO_VALUE,
        translateEnum(s.enums.inspectionResult, i.result),
        formatMileage(i.mileageKm, locale, s),
        i.countryCode ?? NO_VALUE,
        formatIsoDate(i.nextDueDate, locale),
      ],
      i.result === 'fail',
      [defects.length > 0 ? `${s.notes.defects}: ${defects.join(', ')}` : null],
    );
  });
}

// ============================================================
// v2 sections
// ============================================================

/**
 * Insurance events, kept apart from the damage table on purpose.
 *
 * A total loss is an insurer's decision about a car's VALUE, not a description
 * of its damage, and the same crash routinely appears in both datasets. Merging
 * them would tell a buyer that one accident is two.
 *
 * `reason` is the provider's own wording and is printed verbatim: rephrasing an
 * insurer's loss type is inventing a fact. The record's `source` is NOT printed
 * — it is free text from upstream and arrives as a registry name.
 *
 * The insurer itself stays. That is a party to the event this row describes,
 * not a supplier of the row.
 */
function insuranceRows(
  records: VinHistoryInsuranceRecord[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((i) => {
    const totalLoss = i.totalLoss === true;
    return row(
      [
        formatIsoDate(i.date, locale),
        i.insurer ?? NO_VALUE,
        i.countryCode ?? NO_VALUE,
        totalLoss ? s.values.yes : s.values.no,
        i.reason ?? NO_VALUE,
      ],
      totalLoss,
      [totalLoss ? s.notes.insuranceTotalLoss : null],
    );
  });
}

/**
 * Title brands, rendered verbatim.
 *
 * `payload.brands` holds only brands the mapper found EVIDENCE for — the
 * provider returns its whole ~80-entry code dictionary on every lookup, and
 * rendering that would report every car as flooded, burned and crushed at once.
 * By the time a brand reaches here it is a finding about this car, which is why
 * every row is flagged rather than only the severe categories.
 *
 * `label` is printed as the issuing authority wrote it. We do not re-word a
 * brand: the category beside it is ours and is a grouping, the label is the
 * record. Commercial use — prior taxi, police, rental — carries its own note,
 * because a buyer looking at a private car's price is entitled to see it.
 */
function brandRows(
  records: VinHistoryBrand[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((b) =>
    row(
      [
        formatIsoDate(b.reportedAt, locale),
        b.label ?? NO_VALUE,
        translateEnum(s.enums.brandCategory, b.category),
        b.authority ?? NO_VALUE,
        b.countryCode ?? NO_VALUE,
      ],
      true,
      [
        b.category === 'commercial' ? s.notes.commercialUse : null,
        b.code ? `${s.notes.brandCode}: ${b.code}` : null,
      ],
    ),
  );
}

function serviceRows(
  records: VinHistoryServiceRecord[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  return records.map((r) => {
    const items = asArray(r.items).filter((i) => typeof i === 'string' && i.trim().length > 0);
    return row([
      formatIsoDate(r.date, locale),
      formatMileage(r.mileageKm, locale, s),
      r.facility ?? NO_VALUE,
      r.countryCode ?? NO_VALUE,
      items.length > 0 ? items.join(', ') : NO_VALUE,
    ]);
  });
}

/**
 * Factory configuration, as a label/value table rather than a record table.
 *
 * Nothing here is an event, so there is no date column and no flag: an options
 * list describes the car as it left the plant. A group the provider left empty
 * is omitted rather than printed as a dash — "Interior colours: —" is a line
 * that costs space and says nothing.
 *
 * WHERE THE SOURCE GROUPED THE OPTIONS, SO DOES THE TABLE. Fifty-one options in
 * one cell is a wall of text nobody reads; the same items under the source's own
 * category headings are something a buyer can scan. The categories are printed
 * as the source wrote them — a wrong grouping is worse than an unfamiliar one,
 * so they are formatted and never re-worded. Without groups the flat list is
 * printed exactly as before, and the two are never printed together: they are
 * the same items, and showing both would double the longest section in the
 * document.
 */
function equipmentRows(
  equipment: VinHistoryEquipment | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!equipment) return [];

  const list = (values: string[] | null | undefined): string | null => {
    const items = asArray(values)
      .map((v) => (typeof v === 'string' ? formatToken(v) : ''))
      .filter((v) => v.length > 0);
    return items.length > 0 ? items.join(', ') : null;
  };

  const rows: VinHistoryReportRow[] = [];
  const push = (label: string, value: string | null): void => {
    if (value !== null) rows.push(row([label, value]));
  };

  const grouped = asArray(equipment.groups)
    .map((group) => {
      const held = objectOrNull(group);
      const items = held ? list(held.items) : null;
      // A group's own label, formatted and not translated. An unlabelled group
      // still prints its items rather than losing them.
      return items === null
        ? null
        : { label: formatToken(held?.category) || s.equipment.standard, items };
    })
    .filter((g): g is { label: string; items: string } => g !== null);

  if (grouped.length > 0) {
    for (const group of grouped) push(group.label, group.items);
  } else {
    push(s.equipment.standard, list(equipment.standard));
  }
  push(s.equipment.exteriorColors, list(equipment.exteriorColors));
  push(s.equipment.interiorColors, list(equipment.interiorColors));

  for (const warranty of asArray(equipment.warranties)) {
    // The provider's own wording for the cover; the numbers are ours to format.
    const terms = [
      warranty.months == null
        ? null
        : `${formatNumber(warranty.months, locale)} ${s.units.months}`,
      warranty.distanceKm == null ? null : formatMileage(warranty.distanceKm, locale, s),
    ].filter((t): t is string => t !== null);
    rows.push(
      row([
        `${s.equipment.warranty}: ${warranty.type ?? NO_VALUE}`,
        terms.length > 0 ? terms.join(' · ') : NO_VALUE,
      ]),
    );
  }

  if (equipment.msrpCents != null) {
    push(s.equipment.msrp, formatCents(equipment.msrpCents, equipment.currency, locale));
  }
  if (equipment.invoiceCents != null) {
    push(s.equipment.invoice, formatCents(equipment.invoiceCents, equipment.currency, locale));
  }

  return rows;
}

/**
 * The valuation ladders — one block of rows per valuation, NEVER one number.
 *
 * A payload may carry several valuations from several sources. They are printed
 * one after another, each row formatted in ITS OWN currency, and nothing here
 * averages, picks a "best" or reconciles them: a blended figure is one no
 * source stands behind and no buyer can check, and a document that prints it
 * cannot answer the only question that matters about it — who says so.
 *
 * When there is more than one, each ladder is numbered. By position, because
 * the document does not say who produced which — and the numbering is skipped
 * for a single valuation so the common report reads exactly as it always did.
 *
 * The mileage a valuation was computed AT rides with it as a note, because a
 * price without one is not a fact about anything — and it is not necessarily
 * this car's mileage, which is why it is a note and not a column. The notes
 * attach to the first row of THEIR OWN ladder: under the wrong one they would
 * bind a mileage to a price that was not computed at it.
 *
 * A source that publishes a list price and no ladder still gets a row: it is a
 * number the buyer paid to see, and dropping it would leave the section reading
 * "no valuation held" while a valuation sat in the payload.
 */
function marketValueRows(
  values: VinHistoryMarketValue[],
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  const numbered = values.length > 1;
  const out: VinHistoryReportRow[] = [];

  values.forEach((value, index) => {
    const money = (cents: number | null | undefined): string =>
      formatCents(cents, value.currency, locale);
    const basis = (text: string): string =>
      numbered ? `${s.marketValue.valuation} ${index + 1}: ${text}` : text;

    const notes = [
      value.mileageKm == null
        ? null
        : `${s.marketValue.atMileage}: ${formatMileage(value.mileageKm, locale, s)}`,
      value.asOf ? `${s.marketValue.asOf}: ${formatIsoDate(value.asOf, locale)}` : null,
      value.msrpCents == null ? null : `${s.marketValue.msrp}: ${money(value.msrpCents)}`,
    ].filter((n): n is string => n !== null);

    const band = (
      label: string,
      band0: VinHistoryMarketValue['retail'],
    ): VinHistoryReportRow | null =>
      band0 == null
        ? null
        : row([
            basis(label),
            money(band0.excellentCents),
            money(band0.cleanCents),
            money(band0.averageCents),
            money(band0.roughCents),
          ]);

    const rows = [
      band(s.marketValue.retail, value.retail),
      band(s.marketValue.tradeIn, value.tradeIn),
    ].filter((r): r is VinHistoryReportRow => r !== null);

    if (rows.length === 0) {
      if (value.msrpCents == null) return;
      out.push(
        row(
          [basis(s.marketValue.msrp), money(value.msrpCents), NO_VALUE, NO_VALUE, NO_VALUE],
          false,
          notes.slice(0, 2),
        ),
      );
      return;
    }

    rows[0].notes = notes;
    out.push(...rows);
  });

  return out;
}

/**
 * When the statutory certificates run out.
 *
 * Deliberately NOT part of `inspections[]`, which holds inspection EVENTS: a
 * date, a result, the defects found. These are two expiry dates and nothing
 * else, and inside that table "valid until 2028" would be read as "passed in
 * 2028". The column says "valid until", the note says it again in a sentence,
 * and the chapter stands on its own — a buyer uses the two differently, one
 * being the car's history and the other a bill arriving.
 *
 * A date already past is flagged. That is arithmetic on a date the source
 * published, not a judgement about the car; an unparsable date still prints,
 * because it is what the source published, but is never called expired.
 */
function inspectionValidityRows(
  validity: VinHistoryInspectionValidity | null,
  today: string | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!validity) return [];
  const country = validity.countryCode ?? NO_VALUE;

  const entry = (label: string, value: string | null | undefined): VinHistoryReportRow | null => {
    if (value == null || value === '') return null;
    const day = isoDay(value);
    const expired = day !== null && today !== null && day < today;
    return row([label, country, formatIsoDate(value, locale)], expired, [
      expired ? s.notes.inspectionExpired : null,
    ]);
  };

  const rows = [
    entry(s.inspectionValidity.technical, validity.technicalValidTo),
    entry(s.inspectionValidity.emissions, validity.emissionsValidTo),
  ].filter((r): r is VinHistoryReportRow => r !== null);

  // On the first row, ahead of any "expired": it governs how the whole table is
  // read, and a reader who takes these for test results reads the rest wrong.
  if (rows.length > 0) rows[0].notes.unshift(s.notes.inspectionValidity);
  return rows;
}

/**
 * How long comparable cars take to sell.
 *
 * A fact about the car's COHORT and not about the car, which the wording has to
 * make impossible to misread: the chapter is titled for comparable vehicles,
 * the market is the first column, and the note says in a sentence that this is
 * neither a statement about this vehicle nor a price for it. Sitting next to
 * the valuation chapter is exactly why that matters.
 *
 * The quartiles ride beside the median because a median alone hides whether the
 * market is decisive or slow. They are nullable — a thin cohort yields a median
 * with no spread around it — and a missing median means there is nothing to
 * print at all, rather than a row of placeholders.
 */
function timeToSellRows(
  value: VinHistoryTimeToSell | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!value) return [];
  if (value.medianDays == null || !Number.isFinite(value.medianDays)) return [];

  const days = (count: number | null | undefined): string =>
    count == null || !Number.isFinite(count)
      ? NO_VALUE
      : `${formatNumber(count, locale)} ${s.units.days}`;

  return [
    row(
      [
        value.countryCode ?? NO_VALUE,
        days(value.medianDays),
        days(value.p25Days),
        days(value.p75Days),
      ],
      false,
      [s.notes.timeToSellCohort],
    ),
  ];
}

// ============================================================
// v2 blocks
// ============================================================

/**
 * The decoded vehicle, as the document's opening block.
 *
 * The decode is free and already cached, and the report used to name eight
 * counters against a bare seventeen-character string without ever saying which
 * car it was about. A field the decoder did not know is omitted rather than
 * printed empty; when it knew nothing at all the block is null, because a
 * heading with no fields under it is not a header.
 *
 * `vehicle.source` is read by nothing here. It used to print "Decoded by:
 * carsxe-specs" under the block — a data source named in eight-point grey.
 */
function vehicleBlock(
  vehicle: VinHistoryVehicle | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportVehicle | null {
  if (!vehicle) return null;

  const entries: VinHistoryReportEntry[] = [];
  const add = (id: string, label: string, value: string | null | undefined): void => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 0) entries.push({ id, label, value: text });
  };

  add('make', s.vehicle.make, vehicle.make);
  add('model', s.vehicle.model, vehicle.model);
  // A model year is a label, not a quantity: run through `formatNumber` it would
  // print "2.015" in German.
  add(
    'modelYear',
    s.vehicle.modelYear,
    typeof vehicle.modelYear === 'number' && Number.isFinite(vehicle.modelYear)
      ? String(vehicle.modelYear)
      : null,
  );
  add('bodyClass', s.vehicle.bodyClass, vehicle.bodyClass);
  add('fuelType', s.vehicle.fuelType, vehicle.fuelType);

  /*
   * The drivetrain facts, which arrived with the second source and are paid
   * content: a buyer comparing two listings of one model wants the gearbox, the
   * driven wheels and the power. They are optional on the contract, so a
   * payload without them simply shows the block it always showed.
   */
  add('transmission', s.vehicle.transmission, formatToken(vehicle.transmission));
  add('drivetrain', s.vehicle.drivetrain, formatToken(vehicle.drivetrain));
  // Kilowatts, as published. See `units.kw` for why nothing is converted.
  add(
    'enginePower',
    s.vehicle.enginePower,
    typeof vehicle.enginePowerKw === 'number' && Number.isFinite(vehicle.enginePowerKw)
      ? `${formatNumber(vehicle.enginePowerKw, locale)} ${s.units.kw}`
      : null,
  );

  add('plantCountry', s.vehicle.plantCountry, vehicle.plantCountry);

  if (entries.length === 0) return null;

  return { title: s.vehicle.title, entries };
}

/**
 * How many queries stand behind the document, and how each one answered.
 *
 * ANONYMOUS BY CONSTRUCTION. Each entry becomes a numbered position and its
 * status word; the upstream id and the dataset name are dropped here rather
 * than at the renderer, so no drawing code can reach them later.
 *
 * The status still carries its full meaning — answered, could not be reached,
 * not queried — because that is what makes an `unavailable` section note
 * checkable. An entry with a status nobody recognises prints that status as its
 * own text: a position missing from this chapter would be worse than an
 * untranslated word, since the count of positions is the block's whole point.
 */
function sourcesBlock(
  sources: VinHistorySource[] | null | undefined,
  s: VinHistoryPdfStrings,
): VinHistoryReportSources {
  const lines: VinHistoryReportSourceLine[] = asArray(sources)
    .filter((src): src is VinHistorySource => src != null && typeof src === 'object')
    .map((src, index) => {
      const status = typeof src.status === 'string' ? src.status : '';
      return {
        label: `${s.sources.position} ${index + 1}`,
        status,
        statusLabel: translateEnum(s.sources.status, status),
        tone: status === 'failed' ? 'alert' : 'neutral',
      };
    });

  return {
    title: s.sources.title,
    note: s.sources.note,
    columns: s.sources.columns,
    lines,
    emptyNote: lines.length === 0 ? s.sources.empty : null,
  };
}
