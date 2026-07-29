/**
 * VIN history payload, contract version 1.
 *
 * This is OUR normalised shape, not any provider's. It is deliberately designed
 * as a realistic SUPERSET of what carVertical, CARFAX EU and autoDNA return, so
 * swapping the provider is one mapper — never a schema migration and never a
 * change to the website. Where the three disagree on granularity we take the
 * finest one; where a provider has nothing to say, the field is null or the
 * array is empty. A missing field must never be inferred as a negative finding:
 * "no damage records" and "we have no data" are different answers, which is why
 * `summary.recordCount` exists alongside the booleans.
 *
 * Deliberately NOT here: anything that identifies a person. Owner records carry
 * a type and a country, never a name or an address, and plates are masked at the
 * mapper. A VIN history is a record of the CAR.
 *
 * Money inside this payload is integer cents (`estimatedRepairCostCents`), in
 * line with the platform rule — unlike archival `reportData`, this figure is
 * shown next to a price the buyer is deciding on.
 */

export type VinHistoryOwnerType =
  | 'private'
  | 'company'
  | 'lease'
  | 'rental'
  | 'fleet'
  | 'government'
  | 'unknown';

export interface VinHistoryOwner {
  /** 1-based order of ownership, oldest first. */
  sequence: number;
  type: VinHistoryOwnerType;
  countryCode: string | null;
  fromDate: string | null;
  toDate: string | null;
  durationMonths: number | null;
}

export type VinHistoryMileageSource =
  | 'inspection'
  | 'service'
  | 'registration'
  | 'auction'
  | 'insurance'
  | 'unknown';

export interface VinHistoryMileageRecord {
  date: string;
  mileageKm: number;
  source: VinHistoryMileageSource;
  countryCode: string | null;
  /** True when this reading is LOWER than an earlier one — rollback evidence. */
  suspicious: boolean;
}

export type VinHistoryDamageSeverity =
  | 'minor'
  | 'moderate'
  | 'severe'
  | 'total_loss'
  | 'unknown';

export interface VinHistoryDamageRecord {
  date: string | null;
  severity: VinHistoryDamageSeverity;
  /** Coarse areas: front | rear | left | right | roof | underbody | interior. */
  areas: string[];
  /** Integer cents. Null when the provider reports damage without a valuation. */
  estimatedRepairCostCents: number | null;
  currency: string | null;
  salvage: boolean;
  airbagDeployed: boolean | null;
  description: string | null;
  source: string | null;
}

export type VinHistoryRegistrationStatus =
  | 'active'
  | 'deregistered'
  | 'exported'
  | 'scrapped'
  | 'unknown';

export interface VinHistoryRegistration {
  countryCode: string;
  region: string | null;
  firstRegistration: string | null;
  lastRegistration: string | null;
  /** Masked at the mapper — a full plate is personal data. */
  plateMasked: string | null;
  status: VinHistoryRegistrationStatus;
}

export interface VinHistoryRecall {
  reference: string;
  issuedAt: string | null;
  authority: string | null;
  title: string;
  description: string | null;
  /** False once the manufacturer records the remedy as applied. */
  open: boolean;
}

export interface VinHistoryTheft {
  stolen: boolean;
  reportedAt: string | null;
  countryCode: string | null;
  recoveredAt: string | null;
  source: string | null;
}

export type VinHistoryInspectionResult = 'pass' | 'pass_with_defects' | 'fail' | 'unknown';

export interface VinHistoryInspection {
  date: string;
  countryCode: string | null;
  /** TÜV, DEKRA, GTÜ, MOT, … */
  authority: string | null;
  result: VinHistoryInspectionResult;
  mileageKm: number | null;
  defects: string[];
  nextDueDate: string | null;
}

/**
 * The headline block. Everything in here except `countriesSeen` and
 * `firstRegistration` is a count or a boolean, which is what makes it safe to
 * derive the free preview from — see `VinHistoryService.preview`.
 */
export interface VinHistorySummary {
  recordCount: number;
  ownersCount: number;
  countriesSeen: string[];
  hasAccidentRecords: boolean;
  hasSalvageOrTotalLoss: boolean;
  hasOdometerRollback: boolean;
  hasStolenRecord: boolean;
  hasOpenRecalls: boolean;
  lastRecordedMileageKm: number | null;
  firstRegistration: string | null;
}

export interface VinHistoryPayloadV1 {
  schemaVersion: 1;
  vin: string;
  /** Which provider produced this. 'mock' is never passed off as real. */
  provider: string;
  /** TRUE when the data is GENERATED, not sourced. Never omitted, never guessed. */
  synthetic: boolean;
  generatedAt: string;
  summary: VinHistorySummary;
  owners: VinHistoryOwner[];
  mileageRecords: VinHistoryMileageRecord[];
  damageRecords: VinHistoryDamageRecord[];
  registrations: VinHistoryRegistration[];
  recalls: VinHistoryRecall[];
  theft: VinHistoryTheft;
  inspections: VinHistoryInspection[];
}

export const VIN_HISTORY_SCHEMA_VERSION = 1 as const;
