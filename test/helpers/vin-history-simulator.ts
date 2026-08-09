/**
 * A stand-in for the real VIN-history provider: a mapper from the raw shape in
 * `vin-history-raw.ts` into `VinHistoryPayloadV1`, plus a provider whose
 * behaviour each test drives directly.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * Two different things are under test here and they should not be confused:
 *
 *  1. **The mapper** — a working prototype of the adapter DEN-65 will ship.
 *     It cannot be written in `src/` yet because no provider has sent us their
 *     contract (DEN-64 question 4). Writing it here proves the hazards in the
 *     fixtures are handled and gives that ticket a tested starting point rather
 *     than a blank file.
 *  2. **The service** — `VinHistoryService` against a provider that misbehaves
 *     the way a real one will: timeouts, 401s, 429s, empty bodies, slow
 *     responses. The built-in mock can do none of that.
 *
 * The mapper is the deliberately conservative kind: unknown enum members become
 * 'unknown' rather than being dropped, because dropping a damage record with an
 * unrecognised severity turns "we don't know how bad" into "no damage" — the
 * exact inversion a buyer is paying to avoid.
 */

import {
  VinHistoryDamageRecord,
  VinHistoryDamageSeverity,
  VinHistoryInspection,
  VinHistoryInspectionResult,
  VinHistoryMileageRecord,
  VinHistoryMileageSource,
  VinHistoryOwner,
  VinHistoryOwnerType,
  VinHistoryPayloadV1,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistoryRegistrationStatus,
  VinHistorySummary,
  VinHistoryTheft,
} from '../../src/vin-history/vin-history-payload-v1';
import {
  VinHistoryPreviewSummary,
  VinHistoryProvider,
} from '../../src/vin-history/vin-history.provider';
import { RawAmount, RawProviderResponse } from './vin-history-raw';

const KM_PER_MILE = 1.609344;

// ============================================================
// Field-level normalisation
// ============================================================

/**
 * ISO 'YYYY-MM-DD', German 'DD.MM.YYYY', or nothing.
 *
 * Returns null rather than guessing on anything else: a wrong date on a damage
 * record is worse than a missing one, because the buyer will act on it.
 */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (german) return `${german[3]}-${german[2]}-${german[1]}`;
  return null;
}

/**
 * A decimal amount in euros as an integer number of cents.
 *
 * Accepts a JS number, an English string ('4317.37') and a German one
 * ('12.480,90'). The platform rule is integer cents everywhere; a provider
 * sending floats is not an excuse to start carrying them.
 */
export function toCents(raw: RawAmount | null | undefined): number | null {
  if (!raw || raw.amount === null || raw.amount === undefined) return null;
  let amount: number;
  if (typeof raw.amount === 'number') {
    amount = raw.amount;
  } else {
    const text = raw.amount.trim();
    // German grouping: '12.480,90' → thousands '.', decimal ','.
    const normalized = /,\d{1,2}$/.test(text)
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
    amount = Number.parseFloat(normalized);
  }
  if (!Number.isFinite(amount)) return null;
  // Round at the boundary, once. Float cents propagating into the DB is how a
  // money column starts disagreeing with itself.
  return Math.round(amount * 100);
}

/** A mileage reading in kilometres, whatever unit it arrived in. */
export function toKilometres(value: unknown, unit: unknown): number | null {
  const numeric = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  const isMiles = typeof unit === 'string' && /^mi(les)?$/i.test(unit.trim());
  return Math.round(isMiles ? numeric * KM_PER_MILE : numeric);
}

/** A full plate is personal data — only ever store the masked form. */
export function maskPlate(plate: unknown): string | null {
  if (typeof plate !== 'string' || plate.trim() === '') return null;
  const cleaned = plate.trim().toUpperCase();
  const head = cleaned.slice(0, 2);
  const tail = cleaned.slice(-2);
  return `${head}****${tail}`;
}

function mapOwnerType(value: unknown): VinHistoryOwnerType {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('privat')) return 'private';
  if (text.includes('firmen') || text.includes('company')) return 'company';
  if (text.includes('leas')) return 'lease';
  if (text.includes('rental') || text.includes('miet')) return 'rental';
  if (text.includes('fleet') || text.includes('flotte')) return 'fleet';
  if (text.includes('gov') || text.includes('behörde')) return 'government';
  return 'unknown';
}

function mapSeverity(value: unknown): VinHistoryDamageSeverity {
  const text = String(value ?? '').toLowerCase();
  if (['minor', 'light', 'gering'].includes(text)) return 'minor';
  if (['moderate', 'mittel'].includes(text)) return 'moderate';
  if (['severe', 'heavy', 'schwer'].includes(text)) return 'severe';
  if (['total_loss', 'total', 'totalschaden', 'write_off'].includes(text)) return 'total_loss';
  return 'unknown';
}

function mapMileageSource(value: unknown): VinHistoryMileageSource {
  const text = String(value ?? '').toLowerCase();
  if (['inspection', 'mot', 'tuv', 'tüv'].includes(text)) return 'inspection';
  if (text === 'service') return 'service';
  if (text === 'registration') return 'registration';
  if (text === 'auction') return 'auction';
  if (text === 'insurance') return 'insurance';
  return 'unknown';
}

function mapRegistrationStatus(value: unknown): VinHistoryRegistrationStatus {
  const text = String(value ?? '').toLowerCase();
  if (['active', 'aktiv'].includes(text)) return 'active';
  if (['deregistered', 'abgemeldet'].includes(text)) return 'deregistered';
  if (['exported', 'export'].includes(text)) return 'exported';
  if (['scrapped', 'verschrottet'].includes(text)) return 'scrapped';
  return 'unknown';
}

function mapInspectionResult(value: unknown): VinHistoryInspectionResult {
  const text = String(value ?? '').toLowerCase();
  if (text === 'pass' || text === 'bestanden') return 'pass';
  if (text === 'pass_with_defects' || text === 'mängel') return 'pass_with_defects';
  if (text === 'fail' || text === 'durchgefallen') return 'fail';
  return 'unknown';
}

/** Providers express an open recall as a boolean, a word, or a remedy date. */
function mapRecallOpen(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').toLowerCase();
  if (text === 'open' || text === 'offen') return true;
  return false;
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

// ============================================================
// The mapper
// ============================================================

/**
 * Raw provider response → `VinHistoryPayloadV1`.
 *
 * `synthetic` is a parameter rather than a constant: a payload built from a real
 * provider's records must say `false`, and one built from a fixture in a test
 * must be able to say either, so the "never pass generated data off as real"
 * rule can itself be tested.
 */
export function mapRawToPayloadV1(
  raw: RawProviderResponse,
  opts: { vin: string; provider: string; synthetic: boolean },
): VinHistoryPayloadV1 {
  const records = raw.records ?? {};

  const owners: VinHistoryOwner[] = asArray(records.ownership).map((o, index) => {
    const fromDate = normalizeDate(o.from);
    const toDate = normalizeDate(o.to);
    let durationMonths: number | null = null;
    if (fromDate && toDate) {
      const from = new Date(fromDate);
      const to = new Date(toDate);
      durationMonths = Math.max(
        0,
        Math.round((to.getTime() - from.getTime()) / (30.44 * 86_400_000)),
      );
    }
    return {
      sequence: typeof o.seq === 'number' ? o.seq : index + 1,
      type: mapOwnerType(o.type),
      countryCode: o.country ?? null,
      fromDate,
      toDate,
      durationMonths,
    };
  });

  // Sort BEFORE the rollback scan. A feed that arrives out of order (they do)
  // would otherwise hide a rollback behind a later-but-earlier-dated reading.
  const mileageRecords: VinHistoryMileageRecord[] = asArray(records.mileage)
    .map((m) => ({
      date: normalizeDate(m.date),
      mileageKm: toKilometres(m.value, m.unit),
      source: mapMileageSource(m.source),
      countryCode: m.country ?? null,
    }))
    .filter((m): m is typeof m & { date: string; mileageKm: number } =>
      m.date !== null && m.mileageKm !== null,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m, index, all) => {
      const highestBefore = all.slice(0, index).reduce((max, r) => Math.max(max, r.mileageKm), 0);
      return { ...m, suspicious: m.mileageKm < highestBefore };
    });

  const damageRecords: VinHistoryDamageRecord[] = asArray(records.damages).map((d) => {
    const severity = mapSeverity(d.severity);
    return {
      date: normalizeDate(d.date),
      severity,
      areas: asArray(d.areas).filter((a): a is string => typeof a === 'string'),
      estimatedRepairCostCents: toCents(d.repair_cost),
      currency: d.repair_cost?.currency ?? null,
      // An explicit salvage flag wins; otherwise a total loss implies it.
      salvage: d.salvage === true || severity === 'total_loss',
      airbagDeployed: typeof d.airbag === 'boolean' ? d.airbag : null,
      description: d.description ?? null,
      source: d.source ?? null,
    };
  });

  const registrations: VinHistoryRegistration[] = asArray(records.registrations).map((r) => ({
    countryCode: r.country ?? 'XX',
    region: r.region ?? null,
    firstRegistration: normalizeDate(r.first_registration),
    lastRegistration: normalizeDate(r.last_registration),
    plateMasked: maskPlate(r.plate),
    status: mapRegistrationStatus(r.status),
  }));

  const recalls: VinHistoryRecall[] = asArray(records.recalls).map((r) => ({
    reference: r.reference ?? 'UNKNOWN',
    issuedAt: normalizeDate(r.issued_at),
    authority: r.authority ?? null,
    title: r.title ?? 'Unspecified recall',
    description: r.description ?? null,
    open: mapRecallOpen(r.status),
  }));

  const rawTheft = records.theft ?? null;
  const theft: VinHistoryTheft = {
    stolen: rawTheft?.stolen === true,
    reportedAt: normalizeDate(rawTheft?.reported_at),
    countryCode: rawTheft?.country ?? null,
    recoveredAt: normalizeDate(rawTheft?.recovered_at),
    source: rawTheft?.source ?? null,
  };

  const inspections: VinHistoryInspection[] = asArray(records.inspections)
    .map((i) => ({
      date: normalizeDate(i.date),
      countryCode: i.country ?? null,
      authority: i.authority ?? null,
      result: mapInspectionResult(i.result),
      mileageKm: toKilometres(i.mileage, i.mileage_unit),
      defects: asArray(i.defects).filter((d): d is string => typeof d === 'string'),
      nextDueDate: normalizeDate(i.next_due),
    }))
    .filter((i): i is VinHistoryInspection => i.date !== null);

  const lastMileage = mileageRecords[mileageRecords.length - 1] ?? null;

  const summary: VinHistorySummary = {
    recordCount:
      owners.length +
      mileageRecords.length +
      damageRecords.length +
      registrations.length +
      recalls.length +
      inspections.length +
      (theft.stolen ? 1 : 0),
    ownersCount: owners.length,
    countriesSeen: [...new Set(registrations.map((r) => r.countryCode))],
    hasAccidentRecords: damageRecords.length > 0,
    hasSalvageOrTotalLoss: damageRecords.some((d) => d.salvage || d.severity === 'total_loss'),
    hasOdometerRollback: mileageRecords.some((m) => m.suspicious),
    hasStolenRecord: theft.stolen,
    hasOpenRecalls: recalls.some((r) => r.open),
    lastRecordedMileageKm: lastMileage ? lastMileage.mileageKm : null,
    firstRegistration:
      normalizeDate(raw.vehicle?.first_registration) ??
      registrations.map((r) => r.firstRegistration).filter(Boolean)[0] ??
      null,
  };

  return {
    schemaVersion: 1,
    // OUR normalised VIN, never the provider's echo — it arrives lowercase,
    // padded, or occasionally belonging to a different car.
    vin: opts.vin.toUpperCase(),
    provider: opts.provider,
    synthetic: opts.synthetic,
    generatedAt: raw.generated_at ?? new Date().toISOString(),
    summary,
    owners,
    mileageRecords,
    damageRecords,
    registrations,
    recalls,
    theft,
    inspections,
  };
}

// ============================================================
// The provider
// ============================================================

/** How the simulated provider should answer the next call. */
export type SimulatedBehaviour =
  | { kind: 'respond'; raw: RawProviderResponse }
  | { kind: 'throw'; error: Error }
  | { kind: 'slow'; raw: RawProviderResponse; delayMs: number };

/** Errors shaped like the ones an HTTP client surfaces from a real provider. */
export const providerErrors = {
  timeout: () => new Error('ETIMEDOUT: provider did not respond within 30000ms'),
  unauthorized: () => new Error('Provider responded 401 Unauthorized — API key rejected'),
  rateLimited: () => new Error('Provider responded 429 Too Many Requests — quota exceeded'),
  serverError: () => new Error('Provider responded 502 Bad Gateway'),
  malformed: () => new SyntaxError('Unexpected token < in JSON at position 0'),
};

/**
 * A `VinHistoryProvider` a test drives directly.
 *
 * Counts both entry points separately, which is what makes "the cache stops us
 * paying the provider twice" and "the free preview never triggers a billable
 * fetch" assertable rather than assumed — at real per-lookup prices those two
 * properties are the difference between a margin and a loss.
 */
export class SimulatedProvider implements VinHistoryProvider {
  readonly name = 'simulated';
  readonly synthetic = false;

  private behaviour: SimulatedBehaviour = { kind: 'throw', error: new Error('no behaviour set') };
  private configuredFlag = true;
  private publishesCounts = true;

  /** Billable full lookups. */
  fetchCalls: string[] = [];
  /** Free availability probes. */
  previewCalls: string[] = [];

  get configured(): boolean {
    return this.configuredFlag;
  }

  setConfigured(value: boolean): void {
    this.configuredFlag = value;
  }

  /**
   * Simulate a provider whose FREE probe does not publish per-array counts.
   *
   * Not a hypothetical: a free probe that answered "0 damage records" for a car
   * it holds three of would be a claim it cannot make for free. Those counters
   * are then `null`, which is a different answer from `0` all the way to the
   * wire.
   */
  withholdPreviewCounts(value = true): void {
    this.publishesCounts = !value;
  }

  /** Answer with this body until told otherwise. */
  respondWith(raw: RawProviderResponse): void {
    this.behaviour = { kind: 'respond', raw };
  }

  failWith(error: Error): void {
    this.behaviour = { kind: 'throw', error };
  }

  respondSlowly(raw: RawProviderResponse, delayMs: number): void {
    this.behaviour = { kind: 'slow', raw, delayMs };
  }

  resetCounters(): void {
    this.fetchCalls = [];
    this.previewCalls = [];
  }

  async preview(vin: string): Promise<VinHistoryPreviewSummary> {
    this.previewCalls.push(vin);
    const payload = await this.produce(vin);
    if (!this.publishesCounts) {
      return {
        ...payload.summary,
        mileageRecordCount: null,
        damageRecordCount: null,
        registrationCount: null,
        recallCount: null,
        inspectionCount: null,
      };
    }
    return {
      ...payload.summary,
      mileageRecordCount: payload.mileageRecords.length,
      damageRecordCount: payload.damageRecords.length,
      registrationCount: payload.registrations.length,
      recallCount: payload.recalls.length,
      inspectionCount: payload.inspections.length,
    };
  }

  async fetch(vin: string): Promise<VinHistoryPayloadV1> {
    this.fetchCalls.push(vin);
    return this.produce(vin);
  }

  private async produce(vin: string): Promise<VinHistoryPayloadV1> {
    const behaviour = this.behaviour;
    if (behaviour.kind === 'throw') throw behaviour.error;
    if (behaviour.kind === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      return mapRawToPayloadV1(behaviour.raw, {
        vin,
        provider: this.name,
        synthetic: this.synthetic,
      });
    }
    return mapRawToPayloadV1(behaviour.raw, {
      vin,
      provider: this.name,
      synthetic: this.synthetic,
    });
  }
}
