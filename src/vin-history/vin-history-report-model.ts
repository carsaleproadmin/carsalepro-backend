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
  VinHistoryInsuranceRecord,
  VinHistoryMarketValue,
  VinHistoryPayload,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  VinHistoryServiceRecord,
  VinHistorySource,
  VinHistorySummaryV2,
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
 * up by these — but a reading order rather than a declaration order: what the
 * car IS and what happened to it first (owners, mileage, damage, the insurer's
 * verdict on that damage, the brand a state put on the title), then the
 * administrative record, then the categories that describe rather than report.
 * `service` sits with them because with today's provider it is always the
 * "this source does not hold it" note, and that belongs after the findings.
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
  'service',
  'equipment',
  'marketValue',
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
 */
export interface VinHistoryReportVehicle {
  title: string;
  entries: VinHistoryReportEntry[];
  /** "Decoded by: …", named beside the values as the contract requires. */
  sourceNote: string | null;
}

export interface VinHistoryReportSourceLine {
  /** The mapper's stable id, kept so a line can be traced back to an endpoint. */
  id: string;
  /** The id in the reader's language, or the id itself when we have no wording. */
  label: string;
  dataset: string;
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
 * Which upstream datasets were consulted, and how each answered. v2 only.
 *
 * A report that names its registries can be argued with; one that says only
 * "provider: carsxe" cannot. This is the block that makes an `unavailable`
 * section note verifiable rather than an apology.
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
  provider: string;
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
  const marketValue: VinHistoryMarketValue | null = v2?.marketValue ?? null;

  // The single retrieval date, and the horizon every open period is measured to.
  const retrievedAt = payload.generatedAt ?? null;
  const endOfRecord = isoDay(retrievedAt);
  const synthetic = payload.synthetic === true;

  const periods = normalizeOwnerPeriods(owners, endOfRecord);

  // A theft registry that answered "clean" is a finding; a provider that holds
  // no theft data is not. `source` is what distinguishes them.
  const theftAnswered = theft.stolen === true || (theft.source ?? null) !== null;

  // The v2 sources are appended, never interleaved: the ORDER is "as the
  // document first shows them", and a v1 document must keep the list it had.
  const countryCodes = uniqueCountries([
    ...registrations.map((r) => r.countryCode),
    ...asArray(summary.countriesSeen),
    ...periods.map((p) => p.countryCode),
    ...insuranceRecords.map((i) => i.countryCode),
    ...brands.map((b) => b.countryCode),
    ...serviceRecords.map((r) => r.countryCode),
  ]);

  const counts: VinHistoryReportCounts = {
    records:
      owners.length +
      mileage.length +
      damages.length +
      registrations.length +
      recalls.length +
      inspections.length +
      (theftAnswered ? 1 : 0) +
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

  const meta: VinHistoryReportEntry[] = [
    { id: 'vin', label: s.meta.vin, value: payload.vin ?? NO_VALUE },
    { id: 'provider', label: s.meta.provider, value: payload.provider ?? NO_VALUE },
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
    value: formatTimestamp(options.renderedAt ?? new Date()),
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
      id: 'stolen',
      label: s.highlights.stolen,
      value: yesNo(flags.stolen),
      tone: alertIf(flags.stolen),
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
    theft: theftRows(theft, theftAnswered, locale, s),
    inspections: inspectionRows(inspections, locale, s),
    insurance: insuranceRows(insuranceRecords, locale, s),
    brands: brandRows(brands, locale, s),
    service: serviceRows(serviceRecords, locale, s),
    equipment: equipmentRows(equipment, locale, s),
    marketValue: marketValueRows(marketValue, locale, s),
  };

  const order: readonly VinHistoryReportSectionId[] = v2
    ? VIN_HISTORY_V2_REPORT_SECTION_IDS
    : VIN_HISTORY_REPORT_SECTION_IDS;

  const sections: VinHistoryReportSection[] = order.map((id) =>
    section(id, s, rowsById[id], v2 ? sectionCoverage(v2.coverage, id) : null),
  );

  return {
    locale,
    schemaVersion: v2 ? 2 : 1,
    vin: payload.vin ?? '',
    provider: payload.provider ?? '',
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
    vehicle: v2 ? vehicleBlock(v2.vehicle, s) : null,
    highlightsTitle: s.highlights.heading,
    highlights,
    sections,
    sources: v2 ? sourcesBlock(v2.sources, s) : null,
    counts,
    countryCodes,
    providerRecordCount: summary.recordCount ?? 0,
    footerText: s.footer.disclaimer,
    pageLabel: s.footer.page,
  };
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
): VinHistoryReportSection {
  const strings = s.sections[id];
  return {
    id,
    title: strings.title,
    columns: strings.columns,
    rows,
    emptyNote: rows.length === 0 ? emptyNote(strings, s, coverage) : null,
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
        r.authority ?? NO_VALUE,
        r.title ?? NO_VALUE,
        r.open === true ? s.values.open : s.values.closed,
      ],
      r.open === true,
      [r.description],
    ),
  );
}

function theftRows(
  theft: VinHistoryTheft,
  answered: boolean,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!answered) return [];
  const stolen = theft.stolen === true;
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
        theft.source ?? NO_VALUE,
      ],
      stolen,
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
 * insurer's loss type is inventing a fact.
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
      [
        totalLoss ? s.notes.insuranceTotalLoss : null,
        i.source ? `${s.notes.recordSource}: ${i.source}` : null,
      ],
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
 */
function equipmentRows(
  equipment: VinHistoryEquipment | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!equipment) return [];

  const list = (values: string[] | null | undefined): string | null => {
    const items = asArray(values).filter((v) => typeof v === 'string' && v.trim().length > 0);
    return items.length > 0 ? items.join(', ') : null;
  };

  const rows: VinHistoryReportRow[] = [];
  const push = (label: string, value: string | null): void => {
    if (value !== null) rows.push(row([label, value]));
  };

  push(s.equipment.standard, list(equipment.standard));
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
 * The valuation ladder, one row per basis.
 *
 * The mileage the valuation was computed AT rides with it as a note, because a
 * price without one is not a fact about anything — and it is not necessarily
 * this car's mileage, which is why it is a note and not a column.
 *
 * A provider that publishes a list price and no ladder still gets a row: it is
 * a number the buyer paid to see, and dropping it would leave the section
 * reading "no valuation held" while a valuation object sat in the payload.
 */
function marketValueRows(
  value: VinHistoryMarketValue | null,
  locale: VinHistoryPdfLocale,
  s: VinHistoryPdfStrings,
): VinHistoryReportRow[] {
  if (!value) return [];
  const money = (cents: number | null | undefined): string =>
    formatCents(cents, value.currency, locale);

  const notes = [
    value.mileageKm == null
      ? null
      : `${s.marketValue.atMileage}: ${formatMileage(value.mileageKm, locale, s)}`,
    value.asOf ? `${s.marketValue.asOf}: ${formatIsoDate(value.asOf, locale)}` : null,
    value.msrpCents == null ? null : `${s.marketValue.msrp}: ${money(value.msrpCents)}`,
  ].filter((n): n is string => n !== null);

  const band = (label: string, values: VinHistoryMarketValue['retail']): VinHistoryReportRow | null =>
    values == null
      ? null
      : row([
          label,
          money(values.excellentCents),
          money(values.cleanCents),
          money(values.averageCents),
          money(values.roughCents),
        ]);

  const rows = [
    band(s.marketValue.retail, value.retail),
    band(s.marketValue.tradeIn, value.tradeIn),
  ].filter((r): r is VinHistoryReportRow => r !== null);

  if (rows.length === 0) {
    if (value.msrpCents == null) return [];
    return [
      row(
        [s.marketValue.msrp, money(value.msrpCents), NO_VALUE, NO_VALUE, NO_VALUE],
        false,
        notes.slice(0, 2),
      ),
    ];
  }

  rows[0].notes = notes;
  return rows;
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
 */
function vehicleBlock(
  vehicle: VinHistoryVehicle | null,
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
  add('plantCountry', s.vehicle.plantCountry, vehicle.plantCountry);

  if (entries.length === 0) return null;

  const source = typeof vehicle.source === 'string' ? vehicle.source.trim() : '';
  return {
    title: s.vehicle.title,
    entries,
    sourceNote: source.length > 0 ? `${s.vehicle.decodedBy}: ${source}` : null,
  };
}

/**
 * Which datasets were consulted, and how each answered.
 *
 * The ids are the mapper's and are machine-readable on purpose; the wording is
 * resolved here, per locale, so one stored payload cannot print English inside a
 * German PDF. An id we have no wording for prints as itself — a source missing
 * from the provenance block would be worse than an untranslated one.
 */
function sourcesBlock(
  sources: VinHistorySource[] | null | undefined,
  s: VinHistoryPdfStrings,
): VinHistoryReportSources {
  const lines: VinHistoryReportSourceLine[] = asArray(sources)
    .filter((src): src is VinHistorySource => src != null && typeof src === 'object')
    .map((src) => {
      const status = typeof src.status === 'string' ? src.status : '';
      const dataset = typeof src.dataset === 'string' ? src.dataset.trim() : '';
      return {
        id: src.id ?? '',
        label: translateEnum(s.enums.sourceId, src.id),
        dataset: dataset.length > 0 ? dataset : NO_VALUE,
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
