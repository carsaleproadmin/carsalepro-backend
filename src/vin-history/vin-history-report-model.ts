import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryOwner,
  VinHistoryPayloadV1,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistorySummary,
  VinHistoryTheft,
} from './vin-history-payload-v1';
import {
  VinHistoryPdfLocale,
  VinHistoryPdfStrings,
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
 * Rules that are contractual, not cosmetic:
 *
 * - **All seven sections are always present.** An empty array renders its
 *   `emptyNote`, never a missing section. "No accident records" and "we hold no
 *   accident data" are different claims to make to someone deciding to buy a
 *   car, and silence reads as the first one.
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

export const VIN_HISTORY_REPORT_SECTION_IDS = [
  'owners',
  'mileage',
  'damages',
  'registrations',
  'recalls',
  'theft',
  'inspections',
] as const;

export type VinHistoryReportSectionId = (typeof VIN_HISTORY_REPORT_SECTION_IDS)[number];

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
}

export interface VinHistoryReportCounts {
  /** Rows this document actually contains. See `providerRecordCount`. */
  records: number;
  owners: number;
  mileage: number;
  damages: number;
  registrations: number;
  recalls: number;
  inspections: number;
  /** How many countries — the list is `countryCodes`. */
  countryCount: number;
}

export interface VinHistoryReportModel {
  locale: VinHistoryPdfLocale;
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
  highlightsTitle: string;
  highlights: VinHistoryReportHighlight[];
  sections: VinHistoryReportSection[];

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

const NO_THEFT: VinHistoryTheft = {
  stolen: false,
  reportedAt: null,
  countryCode: null,
  recoveredAt: null,
  source: null,
};

export function buildVinHistoryReportModel(
  payload: VinHistoryPayloadV1,
  options: VinHistoryReportModelOptions = {},
): VinHistoryReportModel {
  const locale = resolveVinHistoryPdfLocale(options.locale);
  const s = vinHistoryPdfStrings(locale);

  const summary: VinHistorySummary = { ...EMPTY_SUMMARY, ...(payload.summary ?? {}) };
  const owners = asArray<VinHistoryOwner>(payload.owners);
  const mileage = [...asArray<VinHistoryMileageRecord>(payload.mileageRecords)].sort((a, b) =>
    (isoDay(a.date) ?? '').localeCompare(isoDay(b.date) ?? ''),
  );
  const damages = asArray<VinHistoryDamageRecord>(payload.damageRecords);
  const registrations = asArray<VinHistoryRegistration>(payload.registrations);
  const recalls = asArray<VinHistoryRecall>(payload.recalls);
  const inspections = asArray<VinHistoryInspection>(payload.inspections);
  const theft: VinHistoryTheft = { ...NO_THEFT, ...(payload.theft ?? {}) };

  // The single retrieval date, and the horizon every open period is measured to.
  const retrievedAt = payload.generatedAt ?? null;
  const endOfRecord = isoDay(retrievedAt);
  const synthetic = payload.synthetic === true;

  const periods = normalizeOwnerPeriods(owners, endOfRecord);

  // A theft registry that answered "clean" is a finding; a provider that holds
  // no theft data is not. `source` is what distinguishes them.
  const theftAnswered = theft.stolen === true || (theft.source ?? null) !== null;

  const countryCodes = uniqueCountries([
    ...registrations.map((r) => r.countryCode),
    ...asArray(summary.countriesSeen),
    ...periods.map((p) => p.countryCode),
  ]);

  const counts: VinHistoryReportCounts = {
    records:
      owners.length +
      mileage.length +
      damages.length +
      registrations.length +
      recalls.length +
      inspections.length +
      (theftAnswered ? 1 : 0),
    owners: owners.length,
    mileage: mileage.length,
    damages: damages.length,
    registrations: registrations.length,
    recalls: recalls.length,
    inspections: inspections.length,
    countryCount: countryCodes.length,
  };

  // Claim OR evidence. Keeping the provider's boolean means a summary that says
  // "accident records exist" is not erased by a tier that withholds the detail;
  // OR-ing the arrays in means a printed damage row is never headlined as "no
  // damage records".
  const flags = {
    accidents: summary.hasAccidentRecords === true || damages.length > 0,
    salvage:
      summary.hasSalvageOrTotalLoss === true ||
      damages.some((d) => d.salvage === true || d.severity === 'total_loss'),
    rollback: summary.hasOdometerRollback === true || mileage.some((m) => m.suspicious === true),
    stolen: summary.hasStolenRecord === true || theft.stolen === true,
    openRecalls: summary.hasOpenRecalls === true || recalls.some((r) => r.open === true),
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

  const sections: VinHistoryReportSection[] = [
    section('owners', s, ownerRows(periods, locale, s)),
    section('mileage', s, mileageRows(mileage, locale, s)),
    section('damages', s, damageRows(damages, locale, s)),
    section('registrations', s, registrationRows(registrations, locale, s)),
    section('recalls', s, recallRows(recalls, locale, s)),
    section('theft', s, theftRows(theft, theftAnswered, locale, s)),
    section('inspections', s, inspectionRows(inspections, locale, s)),
  ];

  return {
    locale,
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
    highlightsTitle: s.highlights.heading,
    highlights,
    sections,
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
): VinHistoryReportSection {
  const strings = s.sections[id];
  return {
    id,
    title: strings.title,
    columns: strings.columns,
    rows,
    emptyNote: rows.length === 0 ? strings.empty : null,
  };
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
