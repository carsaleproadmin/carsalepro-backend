/**
 * VIN history payload, contract version 2.
 *
 * v2 is v1 plus the categories v1 had no field for: the decoded vehicle, factory
 * equipment, insurance write-offs as their own record type, title brands, a
 * market valuation, dealer service history, and a statement of which sources
 * were queried. Everything v1 carried is carried here unchanged and with the
 * same meaning, so a reader that understands v1 needs no new logic for the parts
 * it already knew.
 *
 * WHY A NEW VERSION AND NOT NEW FIELDS ON v1.
 *
 * `VinHistoryPayloadV1` is written into `VinHistoryPurchase.payload` at the
 * moment of sale and never rewritten — it is the artefact a buyer paid for.
 * Every one of those rows says `schemaVersion: 1` and will say so for ever.
 * Widening v1 in place would make every stored payload retroactively invalid
 * against its own declared version. So v1 stays frozen, v2 is a separate type,
 * `VinHistoryPayload` is the union, and every reader branches on
 * `schemaVersion`. `isVinHistoryPayloadV2` is that branch.
 *
 * THREE FACTS ARE DISTINCT, AND THE TYPES KEEP THEM DISTINCT.
 *
 * "We asked and there is nothing", "we asked and the source broke", and "this
 * source does not hold this kind of data at all" are three different things to
 * tell someone deciding whether to buy a car. An empty array alone cannot say
 * which, and the difference is not cosmetic: printing "no accident records"
 * under a category nobody queried is the strongest possible claim made out of an
 * absence of data. `coverage` carries the answer per section — it is the same
 * rule as `null`-is-not-`0` on the free preview, applied one level up.
 *
 * Service history is permanently `not_covered` with today's provider. The array
 * and the type exist anyway, so the day a provider does supply it the change is
 * a mapper, not a schema.
 *
 * NO PERSONAL DATA, unchanged from v1. Owner records carry a type and a country,
 * never a name or an address; plates are masked at the mapper; brand records
 * name the issuing authority, never a person. A VIN history is a record of the
 * CAR. The provider does sell owner names through a separate product; it is
 * deliberately not bought and must not be.
 *
 * Money is integer cents throughout, in line with the platform rule.
 */

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

export const VIN_HISTORY_SCHEMA_VERSION_V2 = 2 as const;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * What happened when this section's source was consulted.
 *
 * - `covered`     — queried, answered. An empty array here IS a finding.
 * - `unavailable` — queried, the source failed this time. Transient; the buyer
 *   keeps everything else, and the section says so rather than reading empty.
 * - `not_covered` — the source holds no such data, ever. Not an incident.
 */
export type VinHistorySectionCoverage = 'covered' | 'unavailable' | 'not_covered';

export const VIN_HISTORY_V2_SECTION_IDS = [
  'owners',
  'mileage',
  'damages',
  'registrations',
  'recalls',
  'theft',
  'inspections',
  'insurance',
  'brands',
  'service',
  'equipment',
  'marketValue',
] as const;

export type VinHistoryV2SectionId = (typeof VIN_HISTORY_V2_SECTION_IDS)[number];

export type VinHistoryCoverageMap = Record<VinHistoryV2SectionId, VinHistorySectionCoverage>;

/**
 * One upstream source behind this report.
 *
 * The reference reports name their registries; ours held `provider` and a
 * per-record `source` and showed neither. `id` is stable and machine-readable —
 * the wording a reader sees is resolved per locale in the report model, never
 * stored here, or the same payload would print English inside a German PDF.
 */
export interface VinHistorySource {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  /** The provider's own name for this dataset, when it publishes one. */
  dataset: string | null;
}

// ---------------------------------------------------------------------------
// The decoded vehicle
// ---------------------------------------------------------------------------

/**
 * Which car this VIN is, from the FREE decode.
 *
 * It exists because the preview used to show eight counters against a bare
 * seventeen-character string and never named the car the visitor had typed. It
 * costs nothing: the decode is already cached in Postgres and is the same one
 * the mobile app has always used.
 *
 * Fields are individually nullable because the decoder is US-centric and
 * answers less for a European VIN. A field it does not know is omitted from the
 * report rather than printed empty.
 */
export interface VinHistoryVehicle {
  make: string | null;
  model: string | null;
  modelYear: number | null;
  bodyClass: string | null;
  fuelType: string | null;
  plantCountry: string | null;
  /** Which decoder produced this — named on the report beside the value. */
  source: string;
}

// ---------------------------------------------------------------------------
// New record types
// ---------------------------------------------------------------------------

/**
 * An insurance event, kept apart from `damageRecords` on purpose.
 *
 * A total loss is an insurer's commercial decision about a car's value, not a
 * description of its damage, and the two answer different questions. Merging
 * them would also double-count: the same event routinely appears as a salvage
 * auction entry AND an insurance write-off, and a buyer reading "2 damage
 * records" for one crash is being misled about how much is known.
 */
export interface VinHistoryInsuranceRecord {
  date: string | null;
  /** The insurer, when published. Never a policyholder. */
  insurer: string | null;
  countryCode: string | null;
  totalLoss: boolean;
  /** The provider's own wording for the loss type, rendered verbatim. */
  reason: string | null;
  source: string | null;
}

/**
 * Coarse grouping for a title brand, so the report can rank and explain them
 * without hardcoding the provider's whole code table.
 */
export type VinHistoryBrandCategory =
  | 'salvage'
  | 'flood'
  | 'fire'
  | 'odometer'
  | 'commercial'
  | 'theft'
  | 'lemon'
  | 'export'
  | 'other';

/**
 * A title brand that was ACTUALLY APPLIED to this vehicle.
 *
 * ⚠️ THE PROVIDER RETURNS ITS ENTIRE BRAND DICTIONARY ON EVERY LOOKUP.
 *
 * `brandsInformation` in the raw response is roughly eighty entries — Flood
 * damage, Fire damage, Salvage, Junk, Crushed, Prior Taxi, Odometer tampering
 * and the rest — and it comes back byte-identical for a pristine car and a
 * write-off. It is a legend for the reader, not a list of findings. Mapping it
 * straight through would report every car as flood-damaged, burned, stolen and
 * crushed simultaneously, on the document someone paid for.
 *
 * Only codes the response marks as APPLIED reach this array. The mapper owns
 * that filter and its tests pin it.
 */
export interface VinHistoryBrand {
  /** The provider's code, kept so a disputed brand can be traced upstream. */
  code: string;
  category: VinHistoryBrandCategory;
  /** The provider's own wording. Rendered verbatim — we do not re-word a brand. */
  label: string;
  reportedAt: string | null;
  /** The issuing state or agency. Never a person. */
  authority: string | null;
  countryCode: string | null;
}

/**
 * A dealer service or maintenance visit.
 *
 * Typed but never populated by today's provider — its schema has no such field,
 * whatever the marketing copy says. The section is declared `not_covered` and
 * the report says so in as many words, because a buyer who asked for service
 * history deserves "this source does not have it" rather than a blank space
 * that reads as "this car was never serviced".
 */
export interface VinHistoryServiceRecord {
  date: string | null;
  mileageKm: number | null;
  /** The garage or dealership, when published. */
  facility: string | null;
  countryCode: string | null;
  items: string[];
  source: string | null;
}

export interface VinHistoryWarranty {
  /** e.g. Basic, Powertrain, Corrosion. The provider's own wording. */
  type: string;
  months: number | null;
  distanceKm: number | null;
}

/**
 * Factory configuration as delivered.
 *
 * Available for US-market vehicles only. For anything else the section is
 * `not_covered` and this is null — the decoder returns dimensions and emissions
 * but no options list, and an options list is what "equipment" means to a buyer.
 */
export interface VinHistoryEquipment {
  /** Standard equipment as delivered, in the provider's order. */
  standard: string[];
  exteriorColors: string[];
  interiorColors: string[];
  warranties: VinHistoryWarranty[];
  msrpCents: number | null;
  invoiceCents: number | null;
  currency: string | null;
}

/** One valuation ladder. Every band is nullable — providers publish partial sets. */
export interface VinHistoryValueBand {
  excellentCents: number | null;
  cleanCents: number | null;
  averageCents: number | null;
  roughCents: number | null;
}

/**
 * A market valuation.
 *
 * `mileageKm` is the mileage the valuation was computed AT, and it is recorded
 * because a price without it is not a fact about anything. It is not necessarily
 * the car's mileage.
 */
export interface VinHistoryMarketValue {
  currency: string;
  retail: VinHistoryValueBand | null;
  tradeIn: VinHistoryValueBand | null;
  msrpCents: number | null;
  mileageKm: number | null;
  /** When the provider published this valuation. */
  asOf: string | null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * The v1 headline block plus the flags the new categories raise.
 *
 * `VinHistorySummary` is deliberately extended rather than edited: it is stored
 * inside every payload already sold, and adding a required field to it would
 * invalidate all of them. A v1 payload simply has the narrower summary; a reader
 * that wants a v2 flag checks the schema version first.
 *
 * Everything here stays a count or a boolean, which is what makes the free
 * preview derivable from it without leaking the paid answer.
 */
export interface VinHistorySummaryV2 extends VinHistorySummary {
  /** Prior taxi, police, rental or other commercial use, from an applied brand. */
  hasCommercialUse: boolean;
  /** Any applied title brand at all. */
  hasTitleBrand: boolean;
  /** An insurer wrote this car off at least once. */
  hasInsuranceTotalLoss: boolean;
  insuranceRecordCount: number;
  brandCount: number;
  serviceRecordCount: number;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export interface VinHistoryPayloadV2 {
  schemaVersion: 2;
  vin: string;
  /** Which provider produced this. Frozen per row — never rewritten. */
  provider: string;
  /** TRUE when the data is GENERATED, not sourced. Never omitted, never guessed. */
  synthetic: boolean;
  generatedAt: string;

  summary: VinHistorySummaryV2;
  vehicle: VinHistoryVehicle | null;

  // Carried from v1, unchanged in meaning.
  owners: VinHistoryOwner[];
  mileageRecords: VinHistoryMileageRecord[];
  damageRecords: VinHistoryDamageRecord[];
  registrations: VinHistoryRegistration[];
  recalls: VinHistoryRecall[];
  theft: VinHistoryTheft;
  inspections: VinHistoryInspection[];

  // New in v2.
  insuranceRecords: VinHistoryInsuranceRecord[];
  brands: VinHistoryBrand[];
  serviceRecords: VinHistoryServiceRecord[];
  equipment: VinHistoryEquipment | null;
  marketValue: VinHistoryMarketValue | null;

  /** Per-section: queried and answered, queried and failed, or never held. */
  coverage: VinHistoryCoverageMap;
  /** Which upstream datasets were consulted, so the report can name them. */
  sources: VinHistorySource[];
}

export type VinHistoryPayload = VinHistoryPayloadV1 | VinHistoryPayloadV2;

/**
 * The one branch every reader takes.
 *
 * Written against the version field rather than by probing for a v2 property,
 * because a v1 payload that happens to carry an extra key from some future
 * change must still be read as v1. The version is the contract; the shape is
 * what the contract promises.
 */
export function isVinHistoryPayloadV2(
  payload: VinHistoryPayload,
): payload is VinHistoryPayloadV2 {
  return payload.schemaVersion === VIN_HISTORY_SCHEMA_VERSION_V2;
}

/**
 * Every section marked `not_covered`. The starting point for a mapper, which
 * then marks what it actually managed to read.
 *
 * A fresh object each call — a shared constant would let one report's coverage
 * be mutated into another's.
 */
export function emptyCoverageMap(): VinHistoryCoverageMap {
  return VIN_HISTORY_V2_SECTION_IDS.reduce((map, id) => {
    map[id] = 'not_covered';
    return map;
  }, {} as VinHistoryCoverageMap);
}
