/**
 * Merge several providers' answers about one VIN into a single report.
 *
 * PURE. No DI, no network, no clock — `generatedAt` is passed in, so the same
 * inputs produce the same bytes and every rule below is testable without a
 * container. The composite provider owns the calling; this file owns the
 * meaning.
 *
 * THE ONE THING THIS FILE IS ABOUT: a merged report must not claim more than its
 * sources do. Two sources that overlap are two views of one car, not two cars,
 * and the ways of getting that wrong all look like extra value on the page —
 * doubled record counts, an averaged valuation nobody stands behind, a theft
 * answer covering registers nobody searched. Each rule below exists to refuse
 * one of those.
 *
 * It NEVER THROWS. It runs after the money has been taken and after the sources
 * have been paid, on payloads that may have come back out of a JSON column
 * written by an older build. A merge failure at that point would refund a
 * customer whose data we are holding in memory, so the fallback is an
 * empty-but-well-formed report with every member marked failed, and the sale is
 * refused one layer up by `MIN_SELLABLE_RECORD_COUNT` — the ordinary path for a
 * report with nothing in it.
 */

import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryOwner,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistoryTheft,
} from './vin-history-payload-v1';
import {
  VinHistoryBrand,
  VinHistoryCoverageMap,
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
  VIN_HISTORY_V2_SECTION_IDS,
  emptyCoverageMap,
  isVinHistoryPayloadV2,
} from './vin-history-payload-v2';

/** One member's contribution: what it is called, what it said, and whether it broke. */
export interface VinHistoryMergeMember {
  /** The member's own frozen `name` — this is what `sources[]` is keyed on. */
  name: string;
  /** Null when the member failed, or answered with nothing at all. */
  payload: VinHistoryPayload | null;
  /** True when the member threw. It contributes no data and one failed source. */
  failed: boolean;
}

export interface VinHistoryMergeInput {
  vin: string;
  /** The COMPOSITE's name — 'aggregate'. Stamped on the merged payload. */
  provider: string;
  /** Passed in, never read from the clock, so this function stays pure. */
  generatedAt: string;
  members: VinHistoryMergeMember[];
}

/** Best evidence wins: a section one source answered is an answered section. */
const COVERAGE_RANK: Record<VinHistorySectionCoverage, number> = {
  not_covered: 0,
  unavailable: 1,
  covered: 2,
};

/**
 * The sections a v1 payload implicitly answers.
 *
 * v1 predates `coverage` and has no map to read, but it is not silent about
 * these: it carries exactly these seven arrays, and a provider that emitted a v1
 * payload emitted them because it had looked. Treating them as `covered` and
 * everything else as `not_covered` is the only reading that does not either
 * invent data ("marked covered, holds nothing") or discard a real answer
 * ("marked not_covered, holds three damage records").
 */
const V1_ANSWERED_SECTIONS = [
  'owners',
  'mileage',
  'damages',
  'registrations',
  'recalls',
  'theft',
  'inspections',
] as const;

/** A member that answered, seen through the v2 shape whatever version it sent. */
interface MemberView {
  name: string;
  synthetic: boolean;
  payload: VinHistoryPayloadV2;
}

export function mergeVinHistoryPayloads(input: VinHistoryMergeInput): VinHistoryPayloadV2 {
  const vin = (input.vin ?? '').toUpperCase();
  const members = asArray(input.members);

  try {
    return merge(input, vin, members);
  } catch (err) {
    /*
     * Unreachable by design and handled anyway. Every accessor below is
     * defensive, but the inputs include payloads deserialised from a JSON
     * column, so "shaped like the type" is a compile-time fact and not a runtime
     * one. Losing the merge must not turn into a crash inside `fulfill`, which
     * refunds AND pages every admin — an empty report reaches the same refund
     * quietly, by the path that already exists for a VIN nobody holds records
     * for.
     */
    return {
      ...emptyPayload(vin, input.provider, input.generatedAt),
      sources: members.map((m) => ({
        id: m?.name ?? 'unknown',
        status: 'failed' as const,
        dataset: `merge_failed:${(err as Error)?.message ?? 'unknown'}`.slice(0, 120),
      })),
    };
  }
}

function merge(
  input: VinHistoryMergeInput,
  vin: string,
  members: VinHistoryMergeMember[],
): VinHistoryPayloadV2 {
  const views: MemberView[] = [];
  const sources: VinHistorySource[] = [];

  for (const member of members) {
    const name = member?.name ?? 'unknown';

    /*
     * A failed member contributes NO data and one visible failure. Both halves
     * matter: a report built from one of two sources must never read like a
     * report built from two, and the reader's whole ability to tell "checked and
     * empty" from "could not be reached" lives in this entry's status.
     */
    if (!member || member.failed || !member.payload) {
      sources.push({ id: name, status: 'failed', dataset: null });
      continue;
    }

    const view = viewOf(name, member.payload);
    views.push(view);

    /*
     * `sources[]` CONCATENATES, and each entry keeps the status its own member
     * gave it. A member that named its datasets ('carsxe.recalls',
     * 'carsxe.lienTheft', …) keeps that granularity — those per-dataset statuses
     * are what a section's "we asked and it broke" is rendered from. A member
     * that named none gets one entry standing for itself, so no successful
     * member is invisible.
     */
    const memberSources = asArray(view.payload.sources).filter(isSource);
    if (memberSources.length > 0) sources.push(...memberSources);
    else sources.push({ id: name, status: 'ok', dataset: null });
  }

  const owners = concat(views, (p) => p.owners);
  const damageRecords = concat(views, (p) => p.damageRecords);
  const registrations = concat(views, (p) => p.registrations);
  const inspections = concat(views, (p) => p.inspections);
  const insuranceRecords = concat(views, (p) => p.insuranceRecords);
  const brands = concat(views, (p) => p.brands);
  const serviceRecords = concat(views, (p) => p.serviceRecords);

  const mileageRecords = mergeMileage(views);
  const recalls = pickRecalls(views);
  const theft = mergeTheft(views);
  const theftCoverage = mergeTheftCoverage(views);
  const marketValues = collectMarketValues(views);

  const coverage = mergeCoverage(views, recalls.coverage);

  const summary = buildSummary({
    owners,
    mileageRecords,
    damageRecords,
    registrations,
    recalls: recalls.records,
    inspections,
    insuranceRecords,
    brands,
    serviceRecords,
    theft,
  });

  return {
    schemaVersion: 2,
    vin,
    provider: input.provider,
    /*
     * ⚠️ SYNTHETIC IS AN "ALL", NEVER AN "ANY".
     *
     * `synthetic: true` means "this data was generated, not sourced", and it is
     * the flag the payload, the DTO, the report page and the PDF all carry to
     * tell a buyer what they bought. A merged report is only generated if
     * EVERYTHING in it was generated. One real source beside a mock makes the
     * report partly real — and marking that `true` would label genuine records
     * as invented, which is the same lie in the other direction as labelling
     * invented records genuine.
     *
     * Zero contributors is explicitly false and not the vacuous `every` truth of
     * an empty list: an empty report has no generated data in it either.
     */
    synthetic: views.length > 0 && views.every((v) => v.synthetic),
    generatedAt: input.generatedAt,

    summary,
    // First member that named the car wins. There is one car; a second decode of
    // it is the same fact, not another one.
    vehicle: firstOf(views, (p) => p.vehicle),

    owners,
    mileageRecords,
    damageRecords,
    registrations,
    recalls: recalls.records,
    theft,
    inspections,

    insuranceRecords,
    brands,
    serviceRecords,
    equipment: firstOf(views, (p) => p.equipment),

    /*
     * VALUATIONS ARE NEVER BLENDED. Two sources price a car differently because
     * they are pricing different things — a retail ladder by condition against a
     * single market scalar — and their average is a number no source stands
     * behind and no buyer can check. Every valuation is listed; `marketValue`
     * keeps the first one, unchanged, for every reader written before
     * `marketValues[]` existed.
     */
    marketValue: marketValues[0] ?? null,
    marketValues,

    // Single-valued sections: the first source that published one. Two medians
    // for one cohort cannot be averaged into a third that means anything, and
    // two expiry dates for one certificate is a contradiction to show, not to
    // resolve by arithmetic.
    timeToSell: firstOf(views, (p) => p.timeToSell ?? null),
    inspectionValidity: firstOf(views, (p) => p.inspectionValidity ?? null),
    theftCoverage,

    coverage,
    sources,
  };
}

// ===========================================================================
// Mileage — the only array that is genuinely merged
// ===========================================================================

/**
 * Every reading from every source, as ONE chronological ladder.
 *
 * ⚠️ AND `suspicious` IS RECOMPUTED ACROSS IT. That flag means "this reading is
 * lower than an earlier one", and it is a property of the SERIES, not of the
 * reading — so it cannot be carried across from a member. The rollback this
 * whole field exists to catch is exactly the one that is invisible to each
 * source alone: source A holds 120 000 km in March, source B holds 90 000 km in
 * September, and neither has anything to compare against. Interleaved, the
 * second reading is a rollback; carried through, both members' flags say false
 * and the merged report says the odometer is clean.
 *
 * Duplicates are dropped on date AND value, which is the only pair that makes
 * two readings the same reading. Not date alone: two different readings on one
 * day is precisely the evidence of tampering, and keeping only one of them would
 * delete the finding. The retained copy is the earlier member's, so the merged
 * ladder is stable in member order.
 */
function mergeMileage(views: MemberView[]): VinHistoryMileageRecord[] {
  const readings = concat(views, (p) => p.mileageRecords).filter(
    (r): r is VinHistoryMileageRecord =>
      isRecord(r) && typeof r.date === 'string' && typeof r.mileageKm === 'number',
  );

  // Stable sort, so readings sharing a date keep the order their members were
  // called in.
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));

  const seen = new Set<string>();
  const deduped = sorted.filter((r) => {
    const key = `${r.date}|${r.mileageKm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let highestBefore = 0;
  return deduped.map((r) => {
    const suspicious = r.mileageKm < highestBefore;
    highestBefore = Math.max(highestBefore, r.mileageKm);
    return { ...r, suspicious };
  });
}

// ===========================================================================
// Recalls — deliberately NOT merged
// ===========================================================================

/**
 * The first member that supplied any recalls, whole.
 *
 * ⚠️ NOT CONCATENATED, and that is the difference between recalls and every
 * other array here. Both sources relay the SAME authority — a manufacturer
 * campaign published by the national regulator — so the same campaign arriving
 * from two of them is one recall reported twice, with different reference
 * formatting and no reliable key to match on. Concatenating shows a buyer "4
 * open recalls" on a car with two, on the section people act on most directly.
 *
 * Taking one source's list whole keeps it internally consistent: the references,
 * the open/closed states and the wording all come from one relay of one
 * authority. The section's coverage comes from that same member for the same
 * reason — it describes that member's query, not a blend of two.
 *
 * When NO member supplied any recall, there is no member to take coverage from,
 * so it falls back to the ordinary best-evidence merge. That preserves the
 * distinction the coverage map exists for: a member that queried the recall
 * database and found nothing leaves `covered` + empty ("we checked, it is
 * clean"), which must not degrade to `not_covered` ("nobody checked").
 */
function pickRecalls(views: MemberView[]): {
  records: VinHistoryRecall[];
  coverage: VinHistorySectionCoverage | null;
} {
  for (const view of views) {
    const records = asArray(view.payload.recalls).filter(isRecord) as VinHistoryRecall[];
    if (records.length > 0) {
      return { records, coverage: coverageOf(view, 'recalls') };
    }
  }
  return { records: [], coverage: null };
}

// ===========================================================================
// Theft
// ===========================================================================

/**
 * Stolen is an OR, and the register list is a UNION.
 *
 * The OR is the only safe direction: one source saying "stolen" and another
 * saying nothing means the car is on a register, not that the sources disagree.
 * The details come from whichever source raised the flag, so the date, the
 * country and the recovery all describe the same event rather than being
 * assembled from two.
 */
function mergeTheft(views: MemberView[]): VinHistoryTheft {
  const thefts = views
    .map((v) => v.payload.theft)
    .filter((t): t is VinHistoryTheft => isRecord(t));

  const stolen = thefts.find((t) => t.stolen === true);
  if (stolen) return { ...stolen, stolen: true };

  const first = thefts[0];
  return first
    ? { ...first, stolen: false }
    : { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null };
}

/**
 * WHICH registers were actually searched, unioned — never narrowed.
 *
 * ⚠️ This is the load-bearing field of the whole theft section, and merging is
 * where it is easiest to lose. `stolen: false` on its own is not publishable: a
 * source covering five national registers answers "not stolen" for a car
 * registered in a sixth having searched nothing that would know. The value of a
 * second source here is almost entirely the countries it adds, so the countries
 * are unioned and none is ever dropped.
 *
 * `null` when no member published a coverage at all — absent, meaning "we cannot
 * say which registers were searched", which is a different and weaker statement
 * than an empty list ("none were"). Inventing either from the other would be
 * inventing the answer this field exists to protect.
 */
function mergeTheftCoverage(views: MemberView[]): VinHistoryTheftCoverage | null {
  const published = views
    .map((v) => v.payload.theftCoverage)
    .filter((c): c is VinHistoryTheftCoverage => isRecord(c) && Array.isArray(c.countryCodes));

  if (published.length === 0) return null;

  const codes = new Set<string>();
  for (const entry of published) {
    for (const code of entry.countryCodes) {
      if (typeof code === 'string' && code.trim() !== '') codes.add(code.toUpperCase());
    }
  }
  return { countryCodes: [...codes] };
}

// ===========================================================================
// Valuations
// ===========================================================================

/**
 * Every valuation any member published, in member order, unblended.
 *
 * A member that already carries `marketValues[]` is read from there and NOT from
 * its `marketValue` as well — the older field is a view of the first entry, so
 * reading both would list the same valuation twice and make one source look like
 * two.
 */
function collectMarketValues(views: MemberView[]): VinHistoryMarketValue[] {
  const values: VinHistoryMarketValue[] = [];
  for (const view of views) {
    const many = asArray(view.payload.marketValues).filter(isRecord) as VinHistoryMarketValue[];
    if (many.length > 0) values.push(...many);
    else if (isRecord(view.payload.marketValue)) values.push(view.payload.marketValue);
  }
  return values;
}

// ===========================================================================
// Coverage
// ===========================================================================

/**
 * Per section, the BEST evidence any member offered:
 * `covered` > `unavailable` > `not_covered`.
 *
 * If one source answered a section, the section was answered — the other
 * source's silence about it is not a finding and must not be able to pull it
 * back down to "nobody holds this". `unavailable` beating `not_covered` follows
 * the same logic one step lower: "someone tried and it broke this time" is a
 * transient state a reader can act on (come back later), while `not_covered` is
 * permanent.
 *
 * A FAILED MEMBER CONTRIBUTES NOTHING HERE, and that is a deliberate reading of
 * the rule rather than an oversight. The alternative — marking every section
 * `unavailable` because one member never answered — would promote sections that
 * BOTH sources permanently lack (service history, say) to "temporarily broken",
 * inviting a buyer to come back for data that will never exist. The failure is
 * not hidden: it is in `sources[]` with `status: 'failed'`, which is where a
 * reader is told a source did not answer.
 */
function mergeCoverage(
  views: MemberView[],
  recallsOverride: VinHistorySectionCoverage | null,
): VinHistoryCoverageMap {
  const merged = emptyCoverageMap();

  for (const id of VIN_HISTORY_V2_SECTION_IDS) {
    for (const view of views) {
      const value = coverageOf(view, id);
      if (COVERAGE_RANK[value] > COVERAGE_RANK[merged[id]]) merged[id] = value;
    }
  }

  // Recalls are one member's answer, so they carry that member's coverage —
  // never a merge of two statements about a list only one of them supplied.
  if (recallsOverride) merged.recalls = recallsOverride;

  return merged;
}

function coverageOf(
  view: MemberView,
  id: keyof VinHistoryCoverageMap,
): VinHistorySectionCoverage {
  const value = view.payload.coverage?.[id];
  return value === 'covered' || value === 'unavailable' || value === 'not_covered'
    ? value
    : 'not_covered';
}

// ===========================================================================
// Summary
// ===========================================================================

interface SummaryInput {
  owners: VinHistoryOwner[];
  mileageRecords: VinHistoryMileageRecord[];
  damageRecords: VinHistoryDamageRecord[];
  registrations: VinHistoryRegistration[];
  recalls: VinHistoryRecall[];
  inspections: VinHistoryInspection[];
  insuranceRecords: VinHistoryInsuranceRecord[];
  brands: VinHistoryBrand[];
  serviceRecords: VinHistoryServiceRecord[];
  theft: VinHistoryTheft;
}

/**
 * RECOMPUTED FROM THE MERGED ARRAYS. Never copied, never summed from the
 * members' own summaries.
 *
 * Copying is the obvious shortcut and it breaks in both directions at once:
 * adding two `recordCount`s double-counts every fact both sources hold, while a
 * boolean like `hasOdometerRollback` is a property of the MERGED ladder that
 * neither member could have computed. Every field here is derivable from the
 * arrays beside it — every count equals its array's length, every boolean is a
 * predicate over an array — which is what makes the free preview safe to derive
 * from this block, and what the spec asserts field by field.
 */
function buildSummary(input: SummaryInput): VinHistorySummaryV2 {
  const last = input.mileageRecords[input.mileageRecords.length - 1] ?? null;

  const firstRegistration =
    input.registrations
      .map((r) => r?.firstRegistration ?? null)
      .filter((d): d is string => typeof d === 'string' && d !== '')
      .sort()[0] ?? null;

  return {
    /*
     * Every array, plus the theft record when there is one. This number decides
     * whether the merged report is sellable at all (`MIN_SELLABLE_RECORD_COUNT`),
     * so it counts the v2 categories too: a report whose only finding is an
     * applied salvage brand is very much worth what was paid for it. Service
     * records are included here and are not in the single-source formula only
     * because no single source has ever produced one — a merged report that
     * carries some should say so.
     */
    recordCount:
      input.owners.length +
      input.mileageRecords.length +
      input.damageRecords.length +
      input.registrations.length +
      input.recalls.length +
      input.inspections.length +
      input.insuranceRecords.length +
      input.brands.length +
      input.serviceRecords.length +
      (input.theft.stolen ? 1 : 0),
    /*
     * The length of the merged array, and not an attempt at a single ownership
     * chain. Two sources describing the same three owners are not reconcilable
     * without personal data we deliberately do not hold, so the sequences stay
     * as each source numbered them and the count stays derivable from the array
     * a reader can see. The alternative — renumbering — would invent one chain
     * out of two and hide that it had done so.
     */
    ownersCount: input.owners.length,
    countriesSeen: [
      ...new Set(
        input.registrations
          .map((r) => r?.countryCode)
          .filter((c): c is string => typeof c === 'string' && c !== ''),
      ),
    ],
    hasAccidentRecords: input.damageRecords.length > 0,
    hasSalvageOrTotalLoss:
      input.damageRecords.some((d) => d?.salvage === true || d?.severity === 'total_loss') ||
      input.insuranceRecords.some((i) => i?.totalLoss === true) ||
      input.brands.some((b) => b?.category === 'salvage'),
    // The merged ladder's verdict — see `mergeMileage`. This is the flag a second
    // source most often changes.
    hasOdometerRollback: input.mileageRecords.some((m) => m.suspicious),
    hasStolenRecord: input.theft.stolen,
    hasOpenRecalls: input.recalls.some((r) => r?.open === true),
    lastRecordedMileageKm: last ? last.mileageKm : null,
    firstRegistration,
    hasCommercialUse: input.brands.some((b) => b?.category === 'commercial'),
    hasTitleBrand: input.brands.length > 0,
    hasInsuranceTotalLoss: input.insuranceRecords.some((i) => i?.totalLoss === true),
    insuranceRecordCount: input.insuranceRecords.length,
    brandCount: input.brands.length,
    serviceRecordCount: input.serviceRecords.length,
  };
}

// ===========================================================================
// Views and helpers
// ===========================================================================

/**
 * One member's payload as a v2 view, whatever version it sent.
 *
 * The branch is `isVinHistoryPayloadV2` and never a probe for a v2 property: the
 * version field is the contract, and a v1 payload that happens to carry an extra
 * key from some future change must still be read as v1. A v1 member (the mock is
 * one, and it is what an e2e run merges) loses nothing — its seven arrays are
 * carried across unchanged, and the v2 sections it never had are empty and
 * `not_covered`, which is the true statement about them.
 */
function viewOf(name: string, payload: VinHistoryPayload): MemberView {
  const synthetic = payload.synthetic === true;

  if (isVinHistoryPayloadV2(payload)) {
    return { name, synthetic, payload };
  }

  const coverage = emptyCoverageMap();
  for (const id of V1_ANSWERED_SECTIONS) coverage[id] = 'covered';

  return {
    name,
    synthetic,
    payload: {
      schemaVersion: 2,
      vin: payload.vin,
      provider: payload.provider,
      synthetic,
      generatedAt: payload.generatedAt,
      summary: {
        ...payload.summary,
        hasCommercialUse: false,
        hasTitleBrand: false,
        hasInsuranceTotalLoss: false,
        insuranceRecordCount: 0,
        brandCount: 0,
        serviceRecordCount: 0,
      },
      vehicle: null,
      owners: asArray(payload.owners),
      mileageRecords: asArray(payload.mileageRecords),
      damageRecords: asArray(payload.damageRecords),
      registrations: asArray(payload.registrations),
      recalls: asArray(payload.recalls),
      theft: payload.theft,
      inspections: asArray(payload.inspections),
      insuranceRecords: [],
      brands: [],
      serviceRecords: [],
      equipment: null,
      marketValue: null,
      coverage,
      // A v1 payload names no datasets, so the member stands for itself. The
      // caller adds that entry — see `merge`.
      sources: [],
    },
  };
}

/** A well-formed report with nothing in it. The never-reached fallback. */
function emptyPayload(vin: string, provider: string, generatedAt: string): VinHistoryPayloadV2 {
  return {
    schemaVersion: 2,
    vin,
    provider,
    synthetic: false,
    generatedAt,
    summary: buildSummary({
      owners: [],
      mileageRecords: [],
      damageRecords: [],
      registrations: [],
      recalls: [],
      inspections: [],
      insuranceRecords: [],
      brands: [],
      serviceRecords: [],
      theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    }),
    vehicle: null,
    owners: [],
    mileageRecords: [],
    damageRecords: [],
    registrations: [],
    recalls: [],
    theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    inspections: [],
    insuranceRecords: [],
    brands: [],
    serviceRecords: [],
    equipment: null,
    marketValue: null,
    marketValues: [],
    timeToSell: null,
    inspectionValidity: null,
    theftCoverage: null,
    coverage: emptyCoverageMap(),
    sources: [],
  };
}

function concat<T>(views: MemberView[], pick: (payload: VinHistoryPayloadV2) => T[] | undefined): T[] {
  const out: T[] = [];
  for (const view of views) out.push(...asArray(pick(view.payload)).filter(isRecord));
  return out;
}

/** The first non-null value any member published for a single-valued section. */
function firstOf<T extends VinHistoryVehicle | VinHistoryEquipment | VinHistoryTimeToSell | VinHistoryInspectionValidity>(
  views: MemberView[],
  pick: (payload: VinHistoryPayloadV2) => T | null | undefined,
): T | null {
  for (const view of views) {
    const value = pick(view.payload);
    if (isRecord(value)) return value;
  }
  return null;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Guards every array element: a JSON column can hold a null where a record belongs. */
function isRecord<T>(value: T | null | undefined): value is T {
  return typeof value === 'object' && value !== null;
}

function isSource(value: unknown): value is VinHistorySource {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VinHistorySource>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.status === 'ok' || candidate.status === 'failed' || candidate.status === 'skipped')
  );
}
