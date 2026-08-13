/**
 * CarsXE's raw responses → `VinHistoryPayloadV2`.
 *
 * PURE. No network, no Nest, no clock — `generatedAt` is an argument precisely
 * so a test can assert the whole payload byte for byte. Everything the adapter
 * knows about CarsXE's shape lives here, so replacing the provider is this file
 * plus a client, and never a schema change.
 *
 * IT MUST NEVER THROW. It runs inside `VinHistoryService.fulfill`, where a throw
 * refunds the buyer AND alerts every admin. An undeliverable report is a normal
 * outcome; a crash in the mapper is an incident, and mixing the two trains
 * operators to ignore the channel that also carries "the refund did not go
 * through". So: an unknown enum value renders as its raw text, an unparsable
 * date becomes null, a missing or renamed key degrades one field, and every
 * section is built inside a guard that falls back to empty.
 *
 * ⚠️ THE RAW SHAPES ARE HAND-AUTHORED FROM THE DOCUMENTED SCHEMA and have never
 * been checked against a captured response — the account holds a single lifetime
 * `/history` call and it is deliberately unspent. That is why every read goes
 * through `field()`, which matches a key regardless of case, underscores or
 * hyphens and accepts a list of spellings. Tolerating a renamed key is a
 * requirement here, not defensive noise.
 */

import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryMileageSource,
  VinHistoryOwner,
  VinHistoryOwnerType,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistoryTheft,
} from '../vin-history-payload-v1';
import {
  emptyCoverageMap,
  VinHistoryBrand,
  VinHistoryBrandCategory,
  VinHistoryCoverageMap,
  VinHistoryEquipment,
  VinHistoryInsuranceRecord,
  VinHistoryMarketValue,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  VinHistorySource,
  VinHistorySummaryV2,
  VinHistoryValueBand,
  VinHistoryVehicle,
  VinHistoryWarranty,
} from '../vin-history-payload-v2';
import { asArray, maskPlate, normalizeDate, toCents, toKilometres } from '../vin-history-normalize';
import {
  carsxeDataset,
  CarsxeEndpointId,
  CarsxeRawBundle,
  CarsxeSection,
  CarsxeSpecsResponse,
} from './carsxe.client';

/**
 * Everything CarsXE serves is US: NMVTIS titles, US state DMVs, NHTSA recalls.
 * A record with no state on it is still a US record, so the country is a
 * constant rather than a guess per row.
 */
const US = 'US';

/** The decoder named on the report beside the vehicle it decoded. */
const SPECS_DECODER = 'carsxe-specs';

export interface CarsxeMapperContext {
  vin: string;
  provider: string;
  generatedAt: string;
  vehicle: VinHistoryVehicle | null;
}

// ===========================================================================
// Tolerant readers
// ===========================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * One field, by any of several spellings, ignoring case, underscores and
 * hyphens.
 *
 * `odometerReading`, `odometer_reading`, `OdometerReading` and `Odometer Reading`
 * are the same field to this function. With fixtures written from prose
 * documentation that is the difference between a mapper that survives first
 * contact with the real API and one that silently returns an empty report.
 */
function field(source: unknown, ...names: string[]): unknown {
  if (!isRecord(source)) return undefined;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(normalizeKey(key)) && value !== null && value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function textOf(source: unknown, ...names: string[]): string | null {
  return text(field(source, ...names));
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A truthy flag however the provider spells one. `null` when it says nothing. */
function flagOf(source: unknown, ...names: string[]): boolean | null {
  const value = field(source, ...names);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(t)) return true;
    if (['false', 'no', 'n', '0'].includes(t)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return null;
}

/** A list of objects from a key that may hold one object, a list, or nothing. */
function recordsOf(source: unknown, ...names: string[]): Record<string, unknown>[] {
  return asArray(field(source, ...names) as unknown).filter(isRecord);
}

/**
 * Money as integer cents, from whatever the provider sent.
 *
 * Strips the currency furniture ('$12,480', 'USD 12480') before handing the
 * number to the shared `toCents`, which owns the rounding. Money crosses into
 * integers once, here, and never travels as a float.
 */
function cents(value: unknown): number | null {
  if (typeof value === 'number') return toCents({ amount: value });
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,-]/g, '').trim();
    return cleaned === '' ? null : toCents({ amount: cleaned });
  }
  if (isRecord(value)) {
    return cents(field(value, 'amount', 'value', 'price', 'average', 'mid'));
  }
  return null;
}

function centsOf(source: unknown, ...names: string[]): number | null {
  return cents(field(source, ...names));
}

/**
 * Odometer unit, defaulting to MILES.
 *
 * ⚠️ A US title record with no unit on it is in miles. Reading it as kilometres
 * understates the car by 38 % — 120 000 miles would print as 120 000 km — on the
 * single number a buyer looks at hardest. Anything starting with 'k' is
 * kilometres; everything else, including a blank, is miles.
 */
function odometerUnit(raw: unknown): 'mi' | 'km' {
  const t = text(raw);
  if (t && /^k/i.test(t)) return 'km';
  return 'mi';
}

/** An odometer reading in km, from a scalar field or a `{value, unit}` object. */
function odometerKm(source: unknown): number | null {
  const raw = field(
    source,
    'odometer',
    'odometerReading',
    'odometerValue',
    'mileage',
    'miles',
    'lastOdometerReading',
  );
  if (isRecord(raw)) {
    return toKilometres(
      field(raw, 'value', 'reading', 'amount', 'odometer'),
      odometerUnit(field(raw, 'unit', 'unitOfMeasure', 'units')),
    );
  }
  const unit = odometerUnit(
    field(
      source,
      'odometerUnit',
      'odometerUnitOfMeasure',
      'odometerUnitOfMeasurement',
      'mileageUnit',
      'unit',
      'unitOfMeasure',
    ),
  );
  return toKilometres(raw, unit);
}

function dateOf(source: unknown, ...names: string[]): string | null {
  return normalizeDate(field(source, ...names));
}

/**
 * Build a section, or give up on it quietly.
 *
 * The mapper must not throw (see the file header). A section that blows up on
 * an unforeseen shape yields nothing rather than taking the other eleven with
 * it — the buyer keeps a report missing one part instead of a refund plus an
 * admin alert.
 */
function safely<T>(fallback: T, build: () => T): T {
  try {
    return build();
  } catch {
    return fallback;
  }
}

// ===========================================================================
// Section status → coverage
// ===========================================================================

/**
 * What a call's outcome means for the section it fed.
 *
 * `empty` is `covered`: the source was asked and said it holds nothing, which is
 * a finding a buyer can rely on. `failed` is `unavailable` and `skipped` is
 * `not_covered` — neither may ever read as "nothing found", because the whole
 * point of the coverage map is that an absence of data is not a negative result.
 */
function coverageFor(section: CarsxeSection<unknown>): VinHistorySectionCoverage {
  switch (section.status) {
    case 'ok':
    case 'empty':
      return 'covered';
    case 'failed':
      return 'unavailable';
    default:
      return 'not_covered';
  }
}

function bodyOf<T>(section: CarsxeSection<T>): T | null {
  return section.status === 'ok' ? section.body : null;
}

function sourceEntry(id: CarsxeEndpointId, section: CarsxeSection<unknown>): VinHistorySource {
  const status: VinHistorySource['status'] =
    section.status === 'failed' ? 'failed' : section.status === 'skipped' ? 'skipped' : 'ok';
  return { id: `carsxe.${id}`, status, dataset: carsxeDataset(id) };
}

// ===========================================================================
// Title records — the spine of the US history
// ===========================================================================

/**
 * One title or DMV event, flattened out of the three places CarsXE puts them.
 *
 * Titles are the spine: owners, registrations and most odometer readings are all
 * derived from this one list, which is why it is built once and reused rather
 * than each section re-walking the raw body with its own idea of the key names.
 */
interface TitleRecord {
  date: string | null;
  state: string | null;
  mileageKm: number | null;
  plate: string | null;
  current: boolean;
  /** Brand tokens written ON this record — evidence, unlike the dictionary. */
  brandTokens: string[];
}

function brandTokensOn(source: unknown): string[] {
  const raw = field(source, 'brand', 'brands', 'titleBrand', 'titleBrands', 'brandCode', 'brandCodes');
  return asArray(raw as unknown)
    .flatMap((entry) => {
      if (isRecord(entry)) {
        return [textOf(entry, 'brand', 'brandCode', 'code', 'name', 'label', 'description')];
      }
      const t = text(entry);
      // A comma-separated list in one string is common on title feeds.
      return t ? t.split(/[,;|]/).map((part) => part.trim()) : [null];
    })
    .filter((t): t is string => t !== null && t !== '');
}

function readTitle(source: Record<string, unknown>, current: boolean): TitleRecord {
  return {
    date: dateOf(
      source,
      'titleIssueDate',
      'titleDate',
      'titleEffectiveDate',
      'issueDate',
      'reportDate',
      'obtainedDate',
      'odometerReadingDate',
      'date',
    ),
    state: textOf(
      source,
      'state',
      'titleState',
      'stateOfTitle',
      'titleIssuerState',
      'reportingState',
      'reportingEntityState',
      'jurisdiction',
    ),
    mileageKm: odometerKm(source),
    plate: textOf(source, 'licensePlate', 'plate', 'plateNumber', 'registrationPlate', 'tag'),
    current,
    brandTokens: brandTokensOn(source),
  };
}

function collectTitles(history: unknown): TitleRecord[] {
  const titles: TitleRecord[] = [];

  const currentTitle = field(history, 'currentTitleInformation', 'currentTitle', 'titleInformation');
  if (isRecord(currentTitle)) {
    titles.push(readTitle(currentTitle, true));
    for (const historic of recordsOf(currentTitle, 'historicTitles', 'historicTitle', 'priorTitles')) {
      titles.push(readTitle(historic, false));
    }
  }

  for (const entry of recordsOf(history, 'historyInformation', 'history', 'titleHistory')) {
    titles.push(readTitle(entry, false));
  }

  // A row with nothing on it at all is noise, not a record — counting it would
  // inflate `recordCount`, which is what decides whether this report is sellable.
  return titles.filter((t) => t.date !== null || t.state !== null || t.mileageKm !== null);
}

// ===========================================================================
// Brands — the dictionary trap
// ===========================================================================

/**
 * ⚠️ THE SINGLE MOST IMPORTANT RULE IN THIS FILE.
 *
 * `brandsInformation` is CarsXE's ENTIRE brand-code dictionary — roughly eighty
 * entries, Flood damage through Prior Taxi to Crushed, plus a "Clear: no brand
 * exists" line — and it comes back byte-identical for a pristine car and a
 * write-off. It is a legend printed at the foot of the report, not a list of
 * findings. Mapping it straight through reports every single car as
 * flood-damaged, burned, stolen and crushed at once, on a document somebody
 * paid for.
 *
 * A dictionary entry reaches `payload.brands` only with EVIDENCE, which is one
 * of two things:
 *
 *  1. Evidence carried on the entry itself — an explicit applied flag, a brand
 *     date, or an issuing state or entity. A legend line has none of these; a
 *     brand that was really applied to this car has at least one.
 *  2. The brand code or wording appearing on an actual title, history or event
 *     record for THIS vehicle. That is a statement about the car.
 *
 * A token found on a title but absent from the dictionary is still emitted, with
 * its own wording. Losing a real salvage brand because the dictionary spells it
 * differently would be the same failure in the other direction.
 */
const CLEAR_BRAND = /\bclear\b|\bnone\b|no\s+brands?\b|no\s+brand\s+exists?/i;

/**
 * ⚠️ THE BACKSTOP, and the reason this file has two independent defences rather
 * than one.
 *
 * Rule 1 above decides brand by brand whether an entry carries evidence. It is
 * only as good as our reading of a schema nobody has captured: if the real
 * dictionary turns out to carry some constant field this mapper mistakes for
 * evidence — an issuing agency, a placeholder date — then EVERY entry passes,
 * and every car is reported as flood-damaged, burned, stolen and crushed at
 * once.
 *
 * So there is a second, shape-based defence that does not depend on getting the
 * field names right: a real vehicle has a handful of brands. Eighty of them is
 * not a very unlucky car, it is a dictionary. Past this many, inline evidence is
 * discarded wholesale and only brands corroborated by a title, event or salvage
 * record survive.
 */
const MAX_PLAUSIBLE_APPLIED_BRANDS = 8;

const BRAND_CATEGORIES: [RegExp, VinHistoryBrandCategory][] = [
  [/flood|water\s*damage|submerg/i, 'flood'],
  [/fire|burn/i, 'fire'],
  [/theft|stolen/i, 'theft'],
  [/odometer|mileage|tamper|not\s*actual|exceeds\s*mechanical|discrepan/i, 'odometer'],
  [/lemon|manufacturer\s*buy\s*back|buyback|warranty\s*return|defect/i, 'lemon'],
  [/export|import|foreign/i, 'export'],
  [/taxi|police|livery|ambulance|rental|lease|fleet|driver\s*education|bus|commercial|municipal|government/i, 'commercial'],
  [/salvage|junk|scrap|crush|dismantl|totaled|total\s*loss|parts?\s*only|non[\s-]*repair|rebuilt|reconstruct/i, 'salvage'],
];

function brandCategory(label: string): VinHistoryBrandCategory {
  for (const [pattern, category] of BRAND_CATEGORIES) {
    if (pattern.test(label)) return category;
  }
  // The provider's wording is rendered verbatim either way, so an unrecognised
  // brand still reaches the buyer — it just cannot be ranked.
  return 'other';
}

interface BrandDictionaryEntry {
  code: string;
  label: string;
  reportedAt: string | null;
  authority: string | null;
  /** True only when the ENTRY itself carries per-vehicle evidence. */
  applied: boolean;
}

function readDictionary(history: unknown): BrandDictionaryEntry[] {
  return recordsOf(history, 'brandsInformation', 'brands', 'brandInformation').map((entry) => {
    const label =
      textOf(entry, 'brand', 'brandName', 'name', 'title', 'label', 'description') ??
      textOf(entry, 'brandCode', 'code') ??
      'Unspecified brand';
    const code = textOf(entry, 'brandCode', 'code', 'id') ?? label;
    const reportedAt = dateOf(
      entry,
      'brandDate',
      'brandAppliedDate',
      'appliedDate',
      'reportedAt',
      'reportDate',
      'obtainedDate',
      'date',
    );
    const authority = textOf(
      entry,
      'brandState',
      'reportingEntityName',
      'reportingEntity',
      'authority',
      'state',
      'agency',
    );
    const explicit = flagOf(entry, 'applied', 'isApplied', 'present', 'active', 'hasBrand');

    return {
      code,
      label,
      reportedAt,
      authority,
      // The dictionary lines are pure legend: a code, a name, a definition. Any
      // of a date, an issuer or an explicit flag is per-vehicle information, and
      // a legend line has none of them.
      applied: explicit === true || reportedAt !== null || authority !== null,
    };
  });
}

interface AppliedToken {
  token: string;
  reportedAt: string | null;
  authority: string | null;
}

function collectAppliedTokens(history: unknown, titles: TitleRecord[]): AppliedToken[] {
  const tokens: AppliedToken[] = [];

  for (const title of titles) {
    for (const token of title.brandTokens) {
      tokens.push({ token, reportedAt: title.date, authority: title.state });
    }
  }

  // `/history.events[]` is read for brand tokens and NOTHING else. What else it
  // holds is undocumented, and inventing a meaning for an undocumented array on
  // a paid report is exactly the kind of guess this adapter refuses to make.
  for (const event of recordsOf(history, 'events')) {
    for (const token of brandTokensOn(event)) {
      tokens.push({
        token,
        reportedAt: dateOf(event, 'date', 'eventDate', 'reportDate', 'obtainedDate'),
        authority: textOf(event, 'state', 'reportingEntityName', 'authority', 'jurisdiction'),
      });
    }
  }

  for (const junk of recordsOf(history, 'junkAndSalvageInformation', 'junkAndSalvage', 'salvageInformation')) {
    for (const token of brandTokensOn(junk)) {
      tokens.push({
        token,
        reportedAt: dateOf(junk, 'obtainedDate', 'reportDate', 'date'),
        authority: textOf(junk, 'reportingEntityName', 'state', 'authority'),
      });
    }
  }

  return tokens.filter((t) => !CLEAR_BRAND.test(t.token));
}

function buildBrands(history: unknown, titles: TitleRecord[]): VinHistoryBrand[] {
  const dictionary = readDictionary(history);
  const tokens = collectAppliedTokens(history, titles);
  const byCode = new Map<string, VinHistoryBrand>();

  const push = (brand: VinHistoryBrand): void => {
    // The "Clear: no brand exists" line is dropped in every path, including when
    // something marked it applied. It is the ABSENCE of a brand; printing it as
    // one is nonsense on a report and would set `hasTitleBrand`.
    if (CLEAR_BRAND.test(brand.label) || CLEAR_BRAND.test(brand.code)) return;
    const key = normalizeKey(brand.code);
    const existing = byCode.get(key);
    if (!existing) {
      byCode.set(key, brand);
      return;
    }
    // Keep the richest version of a brand reported from two directions.
    byCode.set(key, {
      ...existing,
      reportedAt: existing.reportedAt ?? brand.reportedAt,
      authority: existing.authority ?? brand.authority,
    });
  };

  for (const token of tokens) {
    const match = dictionary.find(
      (entry) => normalizeKey(entry.code) === normalizeKey(token.token) ||
        normalizeKey(entry.label) === normalizeKey(token.token),
    );
    const label = match?.label ?? token.token;
    push({
      code: match?.code ?? token.token.toUpperCase(),
      category: brandCategory(label),
      label,
      reportedAt: token.reportedAt ?? match?.reportedAt ?? null,
      authority: token.authority ?? match?.authority ?? null,
      countryCode: US,
    });
  }

  // See MAX_PLAUSIBLE_APPLIED_BRANDS: a dictionary that claims wholesale to be
  // applied is a dictionary, and its inline evidence is worth nothing.
  const trustInlineEvidence =
    dictionary.filter((entry) => entry.applied).length <= MAX_PLAUSIBLE_APPLIED_BRANDS;

  for (const entry of dictionary) {
    if (!entry.applied || !trustInlineEvidence) continue;
    push({
      code: entry.code,
      category: brandCategory(entry.label),
      label: entry.label,
      reportedAt: entry.reportedAt,
      authority: entry.authority,
      countryCode: US,
    });
  }

  return [...byCode.values()];
}

// ===========================================================================
// Mileage
// ===========================================================================

interface MileageCandidate {
  date: string | null;
  mileageKm: number | null;
  source: VinHistoryMileageSource;
}

/**
 * Every odometer reading in the response, sorted, with rollbacks computed.
 *
 * ⚠️ The provider gives READINGS and never a rollback verdict. `suspicious` is
 * ours: sort ascending by date, then flag any reading lower than one taken
 * earlier. It has to be computed after the sort, because a feed that arrives out
 * of order — they do — would otherwise hide a rollback behind a later-but-
 * earlier-dated reading.
 *
 * Undated readings are dropped. An odometer with no date cannot be placed in the
 * sequence, so it can neither prove nor disprove a rollback, and `date` is
 * non-nullable on the record for exactly that reason.
 */
function buildMileage(candidates: MileageCandidate[]): VinHistoryMileageRecord[] {
  return candidates
    .filter((c): c is MileageCandidate & { date: string; mileageKm: number } =>
      c.date !== null && c.mileageKm !== null && c.mileageKm > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((c, index, all) => {
      const highestBefore = all
        .slice(0, index)
        .reduce((max, other) => Math.max(max, other.mileageKm), 0);
      return {
        date: c.date,
        mileageKm: c.mileageKm,
        source: c.source,
        countryCode: US,
        suspicious: c.mileageKm < highestBefore,
      };
    });
}

// ===========================================================================
// Junk / salvage and insurance
// ===========================================================================

const TOTAL_LOSS_WORDING =
  /total\s*loss|totaled|totalled|write[\s-]*off|written\s*off|constructive\s*total|unrecovered\s*theft/i;
const DESTROYED_WORDING = /crush|scrap|destro|part[s]?\s*only|non[\s-]*repair|dismantl/i;

function buildDamageRecords(history: unknown): VinHistoryDamageRecord[] {
  return recordsOf(history, 'junkAndSalvageInformation', 'junkAndSalvage', 'salvageInformation').map(
    (entry) => {
      const disposition = textOf(entry, 'disposition', 'vehicleDisposition', 'status', 'reason');
      const forExport = flagOf(entry, 'vehicleIntendedForExport', 'intendedForExport', 'export');
      const parts = [disposition, forExport === true ? 'Intended for export' : null].filter(
        (p): p is string => p !== null,
      );

      return {
        date: dateOf(entry, 'obtainedDate', 'reportDate', 'date', 'dispositionDate'),
        /*
         * `unknown`, deliberately, unless the disposition SAYS the car was
         * destroyed. NMVTIS records that a vehicle entered a junk or salvage
         * database; it does not describe the damage. Inferring "severe" from
         * that would be us inventing a severity, and `salvage: true` already
         * carries the finding into `hasSalvageOrTotalLoss`.
         */
        severity:
          disposition !== null && DESTROYED_WORDING.test(disposition) ? 'total_loss' : 'unknown',
        areas: [],
        estimatedRepairCostCents: null,
        currency: null,
        salvage: true,
        airbagDeployed: null,
        // The provider's own wording, verbatim. We do not re-describe a finding.
        description: parts.length > 0 ? parts.join(' — ') : null,
        // The reporting BUSINESS — a salvage yard or auction. Never a contact
        // name, phone or address, which the raw record also carries and which
        // this deliberately does not read.
        source: textOf(entry, 'reportingEntityName', 'reportingEntity', 'source'),
      };
    },
  );
}

function buildInsuranceRecords(history: unknown): VinHistoryInsuranceRecord[] {
  return recordsOf(history, 'insuranceInformation', 'insurance', 'insuranceRecords').map((entry) => {
    const reason = textOf(
      entry,
      'disposition',
      'vehicleDisposition',
      'lossType',
      'reason',
      'status',
      'description',
    );
    const flagged = flagOf(entry, 'totalLoss', 'isTotalLoss', 'totalLossIndicator');

    return {
      date: dateOf(entry, 'obtainedDate', 'lossDate', 'reportDate', 'date'),
      // The insurer. Never a policyholder, and never the policy number the raw
      // record may also carry.
      insurer: textOf(entry, 'reportingEntityName', 'insurer', 'carrier', 'reportingEntity'),
      countryCode: US,
      /*
       * True only when the record SAYS so. Most NMVTIS insurance entries are
       * total-loss reports, and defaulting to true on that reasoning would be a
       * claim about someone's car derived from a statistic — the strongest kind
       * of claim from the weakest kind of evidence. `reason` carries the
       * provider's own wording either way, so nothing is hidden from the buyer.
       */
      totalLoss: flagged === true || (reason !== null && (TOTAL_LOSS_WORDING.test(reason) || DESTROYED_WORDING.test(reason))),
      reason,
      source: textOf(entry, 'reportingEntityName', 'reportingEntity', 'source'),
    };
  });
}

// ===========================================================================
// Owners and registrations
// ===========================================================================

function ownerTypeForBrand(label: string): VinHistoryOwnerType | null {
  if (/police|ambulance|municipal|government|federal|state\s*owned/i.test(label)) return 'government';
  if (/rental|daily\s*rental/i.test(label)) return 'rental';
  if (/lease|leased/i.test(label)) return 'lease';
  if (/fleet|driver\s*education|bus|school/i.test(label)) return 'fleet';
  if (/taxi|livery|commercial/i.test(label)) return 'company';
  return null;
}

/**
 * Owners derived from title events, conservatively and anonymously.
 *
 * ⚠️ NO NAME AND NO ADDRESS EVER LEAVES THIS FUNCTION. CarsXE sells owner
 * identity as a separate product which we deliberately do not buy, and a VIN
 * history is a record of the CAR. What is derivable without it is the SHAPE of
 * the ownership: how many transfers, when, and for how long.
 *
 * One owner per distinct titling event, deduplicated on state and date. That is
 * the standard derivation — a title transfer is a change of keeper — and its
 * known limit is that a title re-issued to the SAME keeper (a lost document, a
 * lien release) counts twice. Undated titles are excluded because they cannot be
 * sequenced.
 *
 * `type` stays `unknown` unless an applied brand contradicts it: a Prior Taxi or
 * Police brand dated inside an owner's window says what that keeper was, and
 * that is the only inference made here.
 */
function buildOwners(titles: TitleRecord[], brands: VinHistoryBrand[]): VinHistoryOwner[] {
  const seen = new Set<string>();
  const dated = titles
    .filter((t) => t.date !== null)
    .filter((t) => {
      const key = `${t.state ?? ''}|${t.date ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const commercial = brands.filter((b) => b.category === 'commercial');

  return dated.map((title, index) => {
    const fromDate = title.date;
    const toDate = dated[index + 1]?.date ?? null;
    let durationMonths: number | null = null;
    if (fromDate && toDate) {
      const from = Date.parse(fromDate);
      const to = Date.parse(toDate);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        durationMonths = Math.max(0, Math.round((to - from) / (30.44 * 86_400_000)));
      }
    }

    const brandInWindow = commercial.find(
      (b) =>
        b.reportedAt !== null &&
        fromDate !== null &&
        b.reportedAt >= fromDate &&
        (toDate === null || b.reportedAt < toDate),
    );

    return {
      sequence: index + 1,
      type: (brandInWindow ? ownerTypeForBrand(brandInWindow.label) : null) ?? 'unknown',
      countryCode: US,
      fromDate,
      toDate,
      durationMonths,
    };
  });
}

function buildRegistrations(titles: TitleRecord[]): VinHistoryRegistration[] {
  return titles.map((title) => ({
    countryCode: US,
    region: title.state,
    firstRegistration: title.date,
    lastRegistration: null,
    // Masked here, at the boundary, so a full plate is never written down.
    plateMasked: maskPlate(title.plate),
    /*
     * `unknown` for a superseded title, never `deregistered`. A prior title
     * means the car was re-titled — usually because it moved state or changed
     * hands — and "deregistered" would tell the buyer it was taken off the road.
     */
    status: title.current ? 'active' : 'unknown',
  }));
}

// ===========================================================================
// Recalls and theft
// ===========================================================================

function buildRecalls(section: CarsxeSection<unknown>): VinHistoryRecall[] {
  const body = bodyOf(section);
  if (!body) return [];

  return recordsOf(body, 'recalls', 'results', 'data', 'campaigns').map((entry) => {
    const remedied =
      flagOf(entry, 'remedied', 'completed', 'isRemedied', 'repaired') === true ||
      dateOf(entry, 'remedyDate', 'completionDate', 'repairedDate') !== null;
    const explicitlyOpen = flagOf(entry, 'open', 'isOpen', 'outstanding');
    const statusText = textOf(entry, 'status', 'remedyStatus', 'recallStatus');

    return {
      reference:
        textOf(entry, 'campaignNumber', 'nhtsaCampaignNumber', 'recallNumber', 'reference', 'id') ??
        'UNKNOWN',
      issuedAt: dateOf(entry, 'reportReceivedDate', 'recallDate', 'issuedAt', 'date', 'campaignDate'),
      // The issuing body, not the manufacturer. NHTSA runs the campaign register
      // this endpoint serves.
      authority: textOf(entry, 'authority', 'agency') ?? 'NHTSA',
      title:
        textOf(entry, 'component', 'subject', 'title', 'summary', 'description') ??
        'Unspecified recall',
      description: textOf(entry, 'consequence', 'summary', 'remedy', 'description', 'notes'),
      /*
       * Open by DEFAULT, which is the one place this mapper deliberately assumes
       * the worse reading. A recall is a call to action for the buyer, not an
       * accusation about the car's past: telling someone to check an already
       * fixed recall costs them a phone call, while staying silent about a live
       * airbag defect does not. An explicit remedy or status always wins.
       */
      open: explicitlyOpen ?? (remedied || (statusText !== null && /closed|complete|remedied/i.test(statusText)) ? false : true),
    };
  });
}

const NO_THEFT: VinHistoryTheft = {
  stolen: false,
  reportedAt: null,
  countryCode: null,
  recoveredAt: null,
  source: null,
};

/**
 * Theft, and ONLY from the theft endpoint.
 *
 * When that call was skipped or failed the answer is this all-null object AND a
 * coverage of `not_covered` / `unavailable`. The object on its own reads exactly
 * like "we checked and it is not stolen", which for a database nobody queried is
 * a false clean bill of health — the coverage map is what stops it being read
 * that way, so the two must always be set together.
 *
 * Liens are in the same response and are dropped: the payload contract has no
 * field for one, and folding a finance agreement into `damageRecords` to avoid
 * losing it would be worse than losing it.
 */
function buildTheft(section: CarsxeSection<unknown>): VinHistoryTheft {
  const body = bodyOf(section);
  if (!body) return NO_THEFT;

  const events = recordsOf(body, 'events', 'records', 'data', 'theft', 'theftRecords').filter(
    (event) => {
      const kind = textOf(event, 'type', 'recordType', 'eventType', 'category', 'record') ?? '';
      const stolenFlag = flagOf(event, 'stolen', 'isStolen', 'theft');
      return /theft|stolen/i.test(kind) || stolenFlag === true;
    },
  );
  if (events.length === 0) return NO_THEFT;

  const dates = events
    .map((event) => dateOf(event, 'reportedAt', 'theftDate', 'reportDate', 'date', 'eventDate'))
    .filter((d): d is string => d !== null)
    .sort();
  const recoveries = events
    .map((event) => dateOf(event, 'recoveryDate', 'recoveredDate', 'dateRecovered', 'returnDate'))
    .filter((d): d is string => d !== null)
    .sort();

  return {
    // Still `true` for a recovered vehicle: the buyer is being told a theft
    // record EXISTS, and `recoveredAt` beside it says how it ended.
    stolen: true,
    reportedAt: dates[0] ?? null,
    countryCode: US,
    recoveredAt: recoveries[recoveries.length - 1] ?? null,
    source: textOf(events[0], 'reportingEntityName', 'source', 'agency') ?? 'carsxe.lienTheft',
  };
}

// ===========================================================================
// Specs → vehicle and equipment
// ===========================================================================

/**
 * The decoded vehicle, from `/specs`.
 *
 * Exported so the provider can build it and pass it into the mapper's context —
 * which keeps the mapper's signature honest about the fact that the vehicle is
 * an input, not something derived from the history.
 */
export function vehicleFromCarsxeSpecs(
  section: CarsxeSection<CarsxeSpecsResponse>,
): VinHistoryVehicle | null {
  const body = bodyOf(section);
  if (!body) return null;
  const attributes = field(body, 'attributes', 'attribute', 'specs') ?? body;

  const modelYearRaw = numberOf(field(attributes, 'year', 'modelYear', 'model_year'));
  const vehicle: VinHistoryVehicle = {
    make: textOf(attributes, 'make', 'manufacturer'),
    model: textOf(attributes, 'model', 'trim', 'series'),
    modelYear: modelYearRaw !== null ? Math.round(modelYearRaw) : null,
    bodyClass: textOf(attributes, 'style', 'bodyStyle', 'bodyClass', 'body'),
    fuelType: textOf(attributes, 'fuelType', 'fuel', 'engineFuelType'),
    plantCountry: textOf(attributes, 'madeIn', 'plantCountry', 'builtIn', 'countryOfManufacture'),
    source: SPECS_DECODER,
  };

  // Nothing decoded is not a vehicle — returning an object of six nulls would
  // print an empty vehicle block instead of omitting it.
  const known = [vehicle.make, vehicle.model, vehicle.bodyClass, vehicle.fuelType, vehicle.plantCountry];
  if (vehicle.modelYear === null && known.every((v) => v === null)) return null;
  return vehicle;
}

function readStandardEquipment(body: unknown): string[] {
  const raw = field(body, 'equipment', 'standardEquipment', 'options');
  if (Array.isArray(raw)) {
    return raw
      .map((entry) =>
        isRecord(entry) ? textOf(entry, 'name', 'description', 'option', 'label', 'value') : text(entry),
      )
      .filter((v): v is string => v !== null);
  }
  if (isRecord(raw)) {
    // An object of option → availability. Only what the car actually has.
    return Object.entries(raw)
      .filter(([, value]) => {
        const t = text(value);
        if (t === null) return value === true;
        return !/^(n\/?a|none|no|not\s*available|optional|0|false)$/i.test(t);
      })
      .map(([key]) => key);
  }
  return [];
}

function readColors(body: unknown): { exterior: string[]; interior: string[] } {
  const raw = field(body, 'colors', 'color');
  const exterior: string[] = [];
  const interior: string[] = [];

  const names = (entry: unknown): string[] =>
    asArray(field(entry, 'options', 'values', 'names') as unknown)
      .map((option) => (isRecord(option) ? textOf(option, 'name', 'value', 'label') : text(option)))
      .filter((v): v is string => v !== null);

  for (const entry of asArray(raw as unknown)) {
    if (!isRecord(entry)) continue;
    const category = (textOf(entry, 'category', 'type', 'kind') ?? '').toLowerCase();
    const values = names(entry);
    const own = textOf(entry, 'name', 'value', 'label');
    const all = values.length > 0 ? values : own !== null ? [own] : [];
    if (category.includes('interior')) interior.push(...all);
    else if (category.includes('exterior')) exterior.push(...all);
  }

  // The other published shape: `{ exterior: [...], interior: [...] }`.
  if (exterior.length === 0 && interior.length === 0 && isRecord(raw)) {
    exterior.push(
      ...asArray(field(raw, 'exterior', 'exteriorColors') as unknown)
        .map((v) => (isRecord(v) ? textOf(v, 'name', 'value') : text(v)))
        .filter((v): v is string => v !== null),
    );
    interior.push(
      ...asArray(field(raw, 'interior', 'interiorColors') as unknown)
        .map((v) => (isRecord(v) ? textOf(v, 'name', 'value') : text(v)))
        .filter((v): v is string => v !== null),
    );
  }

  return { exterior: [...new Set(exterior)], interior: [...new Set(interior)] };
}

function readWarranties(body: unknown): VinHistoryWarranty[] {
  return recordsOf(body, 'warranties', 'warranty').map((entry) => {
    // The unit is in the KEY here, not in a sibling field: CarsXE publishes
    // warranty coverage as `miles`. A generic `distance` is read as miles too,
    // for the same reason every other odometer here is.
    const km = numberOf(field(entry, 'kilometers', 'kilometres', 'km'));
    const miles = numberOf(field(entry, 'miles', 'mileage', 'distance'));
    return {
      type: textOf(entry, 'type', 'name', 'category') ?? 'Unspecified',
      months: numberOf(field(entry, 'months', 'durationMonths', 'term')),
      distanceKm: km !== null ? Math.round(km) : toKilometres(miles, 'mi'),
    };
  });
}

function buildEquipment(section: CarsxeSection<CarsxeSpecsResponse>): VinHistoryEquipment | null {
  const body = bodyOf(section);
  if (!body) return null;
  const attributes = field(body, 'attributes', 'attribute', 'specs') ?? body;

  const standard = readStandardEquipment(body);
  const colors = readColors(body);
  const warranties = readWarranties(body);
  const msrpCents = centsOf(
    attributes,
    'manufacturerSuggestedRetailPrice',
    'msrp',
    'msrpPrice',
    'retailPrice',
  );
  const invoiceCents = centsOf(attributes, 'invoicePrice', 'invoice', 'dealerInvoice');

  /*
   * Null rather than an object of empty arrays. `/specs` answers for a non-US
   * vehicle with dimensions and emissions and no options list at all, and an
   * "Equipment" heading over nothing reads as "this car has no equipment". The
   * caller marks the section `not_covered` when this is null, which is the
   * honest statement: this source does not hold it for this vehicle.
   */
  if (
    standard.length === 0 &&
    colors.exterior.length === 0 &&
    colors.interior.length === 0 &&
    warranties.length === 0 &&
    msrpCents === null &&
    invoiceCents === null
  ) {
    return null;
  }

  return {
    standard,
    exteriorColors: colors.exterior,
    interiorColors: colors.interior,
    warranties,
    msrpCents,
    invoiceCents,
    currency: msrpCents !== null || invoiceCents !== null ? 'USD' : null,
  };
}

// ===========================================================================
// Market value
// ===========================================================================

function readBand(raw: unknown): VinHistoryValueBand | null {
  if (raw === undefined || raw === null) return null;

  // A bare number where a ladder was expected: one price, and the only band it
  // can honestly occupy is the middle one.
  if (typeof raw === 'number' || typeof raw === 'string') {
    const value = cents(raw);
    return value === null
      ? null
      : { excellentCents: null, cleanCents: null, averageCents: value, roughCents: null };
  }
  if (!isRecord(raw)) return null;

  const band: VinHistoryValueBand = {
    excellentCents: centsOf(raw, 'excellent', 'excellentCondition', 'outstanding'),
    cleanCents: centsOf(raw, 'clean', 'cleanCondition', 'good'),
    averageCents: centsOf(raw, 'average', 'averageCondition', 'fair', 'mid', 'value', 'price'),
    roughCents: centsOf(raw, 'rough', 'roughCondition', 'poor', 'below'),
  };
  const anything = Object.values(band).some((v) => v !== null);
  return anything ? band : null;
}

function buildMarketValue(section: CarsxeSection<unknown>): VinHistoryMarketValue | null {
  const body = bodyOf(section);
  if (!body) return null;

  const value = field(body, 'marketValue', 'market_value', 'values', 'value', 'data') ?? body;
  const retail = readBand(field(value, 'retail', 'retailValue', 'retailPrices', 'privateParty'));
  const tradeIn = readBand(field(value, 'tradeIn', 'trade', 'tradeInValue', 'tradeInPrices'));
  const msrpCents = centsOf(value, 'msrp', 'manufacturerSuggestedRetailPrice') ?? centsOf(body, 'msrp');
  const mileageRaw = field(value, 'mileage', 'odometer') ?? field(body, 'mileage', 'odometer');
  const mileageKm = toKilometres(
    mileageRaw,
    odometerUnit(field(value, 'mileageUnit', 'unit') ?? field(body, 'mileageUnit', 'unit')),
  );
  const asOf = dateOf(value, 'asOf', 'date', 'valuationDate', 'updated', 'generatedAt') ?? dateOf(body, 'asOf', 'date');

  if (retail === null && tradeIn === null && msrpCents === null) return null;

  return {
    // CarsXE values US vehicles against US guides. Recorded explicitly so a
    // report never prints a dollar figure behind a euro sign.
    currency: textOf(value, 'currency') ?? textOf(body, 'currency') ?? 'USD',
    retail,
    tradeIn,
    msrpCents,
    mileageKm,
    asOf,
  };
}

// ===========================================================================
// The mapper
// ===========================================================================

export function mapCarsxeToPayloadV2(
  input: CarsxeRawBundle,
  context: CarsxeMapperContext,
): VinHistoryPayloadV2 {
  const history = bodyOf(input.history);

  const titles = safely<TitleRecord[]>([], () => collectTitles(history));
  const brands = safely<VinHistoryBrand[]>([], () => buildBrands(history, titles));
  const damageRecords = safely<VinHistoryDamageRecord[]>([], () => buildDamageRecords(history));
  const insuranceRecords = safely<VinHistoryInsuranceRecord[]>([], () =>
    buildInsuranceRecords(history),
  );
  const owners = safely<VinHistoryOwner[]>([], () => buildOwners(titles, brands));
  const registrations = safely<VinHistoryRegistration[]>([], () => buildRegistrations(titles));
  const recalls = safely<VinHistoryRecall[]>([], () => buildRecalls(input.recalls));
  const theft = safely<VinHistoryTheft>(NO_THEFT, () => buildTheft(input.lienTheft));
  const equipment = safely<VinHistoryEquipment | null>(null, () => buildEquipment(input.specs));
  const marketValue = safely<VinHistoryMarketValue | null>(null, () =>
    buildMarketValue(input.marketValue),
  );

  // Odometer readings come from titles, from junk/salvage entries and from
  // insurance entries, and all three go into ONE sorted series — a rollback is
  // only visible when the readings are compared against each other.
  const mileageRecords = safely<VinHistoryMileageRecord[]>([], () =>
    buildMileage([
      ...titles.map((t) => ({
        date: t.date,
        mileageKm: t.mileageKm,
        source: 'registration' as VinHistoryMileageSource,
      })),
      ...recordsOf(history, 'junkAndSalvageInformation', 'junkAndSalvage', 'salvageInformation').map(
        (entry) => ({
          date: dateOf(entry, 'obtainedDate', 'reportDate', 'date'),
          mileageKm: odometerKm(entry),
          source: 'auction' as VinHistoryMileageSource,
        }),
      ),
      ...recordsOf(history, 'insuranceInformation', 'insurance', 'insuranceRecords').map((entry) => ({
        date: dateOf(entry, 'obtainedDate', 'lossDate', 'reportDate', 'date'),
        mileageKm: odometerKm(entry),
        source: 'insurance' as VinHistoryMileageSource,
      })),
    ]),
  );

  // CarsXE has no roadworthiness-inspection dataset. Both of these are empty
  // arrays with a `not_covered` coverage, which is a statement, not a blank.
  const inspections: VinHistoryInspection[] = [];

  const historyCoverage = coverageFor(input.history);
  const coverage: VinHistoryCoverageMap = {
    ...emptyCoverageMap(),
    owners: historyCoverage,
    mileage: historyCoverage,
    damages: historyCoverage,
    registrations: historyCoverage,
    brands: historyCoverage,
    insurance: historyCoverage,
    theft: coverageFor(input.lienTheft),
    recalls: coverageFor(input.recalls),
    // Both permanently `not_covered`: the source holds neither, ever.
    inspections: 'not_covered',
    service: 'not_covered',
    // `covered` only when something actually came back. `/specs` answers for a
    // non-US vehicle without an options list, and `/marketvalue` without a
    // valuation, and neither absence is a finding about the car.
    equipment: input.specs.status === 'failed' ? 'unavailable' : equipment ? 'covered' : 'not_covered',
    marketValue:
      input.marketValue.status === 'failed' ? 'unavailable' : marketValue ? 'covered' : 'not_covered',
  };

  const sources: VinHistorySource[] = [
    sourceEntry('history', input.history),
    sourceEntry('specs', input.specs),
    sourceEntry('marketvalue', input.marketValue),
    sourceEntry('recalls', input.recalls),
    sourceEntry('lienTheft', input.lienTheft),
  ];

  const lastMileage = mileageRecords[mileageRecords.length - 1] ?? null;
  const firstRegistration =
    registrations
      .map((r) => r.firstRegistration)
      .filter((d): d is string => d !== null)
      .sort()[0] ?? null;

  const summary: VinHistorySummaryV2 = {
    /*
     * Every array, plus the theft record when there is one. It includes the v2
     * categories the v1 formula could not know about, because this number is
     * what `MIN_SELLABLE_RECORD_COUNT` reads to decide whether the buyer got
     * anything — a report whose only finding is an applied salvage brand is very
     * much worth what was paid for it.
     */
    recordCount:
      owners.length +
      mileageRecords.length +
      damageRecords.length +
      registrations.length +
      recalls.length +
      inspections.length +
      insuranceRecords.length +
      brands.length +
      (theft.stolen ? 1 : 0),
    ownersCount: owners.length,
    countriesSeen: [...new Set(registrations.map((r) => r.countryCode))],
    hasAccidentRecords: damageRecords.length > 0,
    hasSalvageOrTotalLoss:
      damageRecords.some((d) => d.salvage || d.severity === 'total_loss') ||
      insuranceRecords.some((i) => i.totalLoss) ||
      brands.some((b) => b.category === 'salvage'),
    hasOdometerRollback: mileageRecords.some((m) => m.suspicious),
    hasStolenRecord: theft.stolen,
    hasOpenRecalls: recalls.some((r) => r.open),
    lastRecordedMileageKm: lastMileage ? lastMileage.mileageKm : null,
    firstRegistration,
    hasCommercialUse: brands.some((b) => b.category === 'commercial'),
    hasTitleBrand: brands.length > 0,
    hasInsuranceTotalLoss: insuranceRecords.some((i) => i.totalLoss),
    insuranceRecordCount: insuranceRecords.length,
    brandCount: brands.length,
    // Typed, never populated — see `VinHistoryServiceRecord`.
    serviceRecordCount: 0,
  };

  return {
    schemaVersion: 2,
    // OUR normalised VIN, never the provider's echo of it.
    vin: context.vin.toUpperCase(),
    provider: context.provider,
    // Sourced from records, not generated. Never conditional.
    synthetic: false,
    generatedAt: context.generatedAt,
    summary,
    vehicle: context.vehicle,
    owners,
    mileageRecords,
    damageRecords,
    registrations,
    recalls,
    theft,
    inspections,
    insuranceRecords,
    brands,
    serviceRecords: [],
    equipment,
    marketValue,
    coverage,
    sources,
  };
}
