import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryOwner,
  VinHistoryOwnerType,
  VinHistoryPayloadV1,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistorySummary,
  VinHistoryTheft,
} from '../vin-history-payload-v1';
import { VinHistoryPreviewSummary, VinHistoryProvider } from '../vin-history.provider';

/**
 * Deterministic pseudo-random source seeded from a string.
 *
 * `Math.random()` would make the same VIN return a different history on every
 * call, which breaks three things at once: the e2e suite could not assert
 * anything about content, a demo would contradict itself between two page
 * loads, and the cached report would disagree with the free preview that sold
 * it. Bytes come from sha256(seed) and, once exhausted, sha256(seed || counter),
 * so the stream is unbounded and reproducible across processes and machines.
 */
class SeededRandom {
  private readonly seed: Buffer;
  private buffer: Buffer;
  private offset = 0;
  private counter = 0;

  constructor(seed: string) {
    this.seed = createHash('sha256').update(seed).digest();
    this.buffer = this.seed;
  }

  private nextByte(): number {
    if (this.offset >= this.buffer.length) {
      this.counter += 1;
      this.buffer = createHash('sha256').update(this.seed).update(String(this.counter)).digest();
      this.offset = 0;
    }
    return this.buffer[this.offset++];
  }

  /** Uniform-enough integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    // Two bytes keep the modulo bias negligible for the small ranges used here.
    const value = (this.nextByte() << 8) | this.nextByte();
    return value % maxExclusive;
  }

  intBetween(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }

  /** True with the given percentage probability. */
  chance(percent: number): boolean {
    return this.int(100) < percent;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

const COUNTRIES = ['DE', 'AT', 'CH', 'NL', 'BE', 'FR', 'PL', 'IT', 'CZ'] as const;
const OWNER_TYPES: VinHistoryOwnerType[] = ['private', 'private', 'private', 'company', 'lease', 'fleet'];
const DAMAGE_AREAS = ['front', 'rear', 'left', 'right', 'roof', 'underbody', 'interior'] as const;
const INSPECTION_AUTHORITIES = ['TÜV', 'DEKRA', 'GTÜ', 'KÜS'] as const;
const RECALL_TITLES = [
  'Airbag inflator replacement',
  'Fuel pump software update',
  'Brake booster inspection',
  'Seat belt pretensioner recall',
] as const;

function isoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, Math.min(day, 28)));
  return d.toISOString().slice(0, 10);
}

/**
 * The built-in provider. Generates a plausible, internally consistent history
 * that is a pure function of the VIN.
 *
 * It NEVER claims to be real: every payload carries `provider: 'mock'` and
 * `synthetic: true`, and `configured` is false in production so no one can be
 * charged for it. That is the whole contract — a demo and a test fixture that
 * cannot accidentally become a product.
 */
@Injectable()
export class MockVinHistoryProvider implements VinHistoryProvider {
  private readonly logger = new Logger(MockVinHistoryProvider.name);

  readonly name = 'mock';
  readonly synthetic = true;

  constructor(
    private readonly nodeEnv: string,
    /**
     * `VIN_HISTORY_ALLOW_SYNTHETIC_SALE`. Lets an operator run the product on
     * generated data in production — a launch decision, taken deliberately and
     * loudly. It does NOT touch `synthetic`, so the payload, the preview, the
     * report page and the PDF all still say what the buyer is looking at.
     */
    private readonly allowSyntheticSale = false,
  ) {
    if (nodeEnv !== 'production') {
      this.logger.warn(
        'VIN history runs on the MOCK provider — generated data, flagged synthetic. ' +
          'Paid unlocks are refused in production until a real provider is wired.',
      );
    } else if (allowSyntheticSale) {
      // Loud on purpose, once per boot: real money is about to be taken for
      // invented vehicle history. If this line is a surprise, the flag is a
      // mistake.
      this.logger.warn(
        'VIN_HISTORY_ALLOW_SYNTHETIC_SALE is ON in production — the MOCK provider will ' +
          'BACK PAID UNLOCKS. Buyers are charged for GENERATED data; every payload, preview, ' +
          'report page and PDF is marked synthetic. Unset the flag to refuse paid unlocks.',
      );
    }
  }

  /**
   * False in production unless an operator has explicitly opted in. Generated
   * history is fine for a demo and for the free preview; charging 19.99 EUR for
   * it is a decision someone has to make on purpose.
   */
  get configured(): boolean {
    return this.nodeEnv !== 'production' || this.allowSyntheticSale;
  }

  /**
   * The free probe.
   *
   * Counts come from the arrays this provider just built. It used to return the
   * summary alone and throw the arrays away, which is why five counters reached
   * the preview page as hardcoded zeros: there was nothing else to give them.
   *
   * A real provider's free probe returns counts and nothing else, so this must
   * stay cheap and must NOT warm the report cache — a cached free probe could
   * later be sold as a full report.
   */
  async preview(vin: string): Promise<VinHistoryPreviewSummary> {
    const payload = await this.fetch(vin);
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
    const normalized = vin.toUpperCase();
    const rng = new SeededRandom(normalized);

    const firstRegYear = rng.intBetween(2008, 2021);
    const firstRegMonth = rng.intBetween(1, 12);
    const firstRegDay = rng.intBetween(1, 28);
    const firstRegistration = isoDate(firstRegYear, firstRegMonth, firstRegDay);
    const ageYears = Math.max(1, 2026 - firstRegYear);

    const homeCountry = rng.pick(COUNTRIES);
    const exported = rng.chance(25);
    const secondCountry = exported ? rng.pick(COUNTRIES.filter((c) => c !== homeCountry)) : null;

    const owners = this.buildOwners(rng, firstRegYear, ageYears, homeCountry, secondCountry);
    const { mileageRecords, hasRollback } = this.buildMileage(
      rng,
      firstRegYear,
      ageYears,
      homeCountry,
    );
    const damageRecords = this.buildDamages(rng, firstRegYear, ageYears);
    const registrations = this.buildRegistrations(
      rng,
      firstRegistration,
      firstRegYear,
      ageYears,
      homeCountry,
      secondCountry,
    );
    const recalls = this.buildRecalls(rng, firstRegYear);
    const theft = this.buildTheft(rng, firstRegYear, ageYears, homeCountry);
    const inspections = this.buildInspections(rng, firstRegYear, ageYears, homeCountry, mileageRecords);

    const last = mileageRecords[mileageRecords.length - 1] ?? null;
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
      hasOdometerRollback: hasRollback,
      hasStolenRecord: theft.stolen,
      hasOpenRecalls: recalls.some((r) => r.open),
      lastRecordedMileageKm: last ? last.mileageKm : null,
      firstRegistration,
    };

    return {
      schemaVersion: 1,
      vin: normalized,
      provider: this.name,
      synthetic: true,
      // Derived from the VIN, not from the clock: a payload that changed every
      // call would break the "deterministic" guarantee the cache relies on.
      generatedAt: `${isoDate(2026, 1, 1)}T00:00:00.000Z`,
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

  private buildOwners(
    rng: SeededRandom,
    firstRegYear: number,
    ageYears: number,
    homeCountry: string,
    secondCountry: string | null,
  ): VinHistoryOwner[] {
    const count = rng.intBetween(1, Math.min(4, Math.max(1, Math.ceil(ageYears / 3))));
    const owners: VinHistoryOwner[] = [];
    let year = firstRegYear;
    for (let i = 0; i < count; i += 1) {
      const isLast = i === count - 1;
      const span = isLast ? Math.max(1, firstRegYear + ageYears - year) : rng.intBetween(1, 4);
      const from = isoDate(year, rng.intBetween(1, 12), rng.intBetween(1, 28));
      const to = isLast ? null : isoDate(year + span, rng.intBetween(1, 12), rng.intBetween(1, 28));
      owners.push({
        sequence: i + 1,
        type: rng.pick(OWNER_TYPES),
        countryCode: i > 0 && secondCountry ? secondCountry : homeCountry,
        fromDate: from,
        toDate: to,
        durationMonths: span * 12,
      });
      year += span;
    }
    return owners;
  }

  private buildMileage(
    rng: SeededRandom,
    firstRegYear: number,
    ageYears: number,
    country: string,
  ): { mileageRecords: VinHistoryMileageRecord[]; hasRollback: boolean } {
    const records: VinHistoryMileageRecord[] = [];
    let km = rng.intBetween(0, 500);
    const rollbackAt = rng.chance(12) ? rng.intBetween(1, Math.max(1, ageYears - 1)) : -1;
    let hasRollback = false;

    for (let i = 0; i < ageYears; i += 1) {
      const annual = rng.intBetween(6000, 26000);
      km += annual;
      let reading = km;
      let suspicious = false;
      if (i === rollbackAt) {
        // A rollback shows up as a reading LOWER than the previous one.
        reading = Math.max(1000, km - rng.intBetween(20000, 60000));
        suspicious = true;
        hasRollback = true;
      }
      records.push({
        date: isoDate(firstRegYear + i + 1, rng.intBetween(1, 12), rng.intBetween(1, 28)),
        mileageKm: reading,
        source: rng.pick(['inspection', 'service', 'registration', 'auction'] as const),
        countryCode: country,
        suspicious,
      });
    }
    return { mileageRecords: records, hasRollback };
  }

  private buildDamages(
    rng: SeededRandom,
    firstRegYear: number,
    ageYears: number,
  ): VinHistoryDamageRecord[] {
    if (!rng.chance(38)) return [];
    const count = rng.intBetween(1, 3);
    const out: VinHistoryDamageRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const severity = rng.pick(['minor', 'minor', 'moderate', 'severe', 'total_loss'] as const);
      const salvage = severity === 'total_loss' || (severity === 'severe' && rng.chance(30));
      const areaCount = rng.intBetween(1, 3);
      const areas = [...new Set(Array.from({ length: areaCount }, () => rng.pick(DAMAGE_AREAS)))];
      out.push({
        date: isoDate(
          firstRegYear + rng.intBetween(1, Math.max(1, ageYears)),
          rng.intBetween(1, 12),
          rng.intBetween(1, 28),
        ),
        severity,
        areas,
        estimatedRepairCostCents: rng.intBetween(30, 1400) * 10_000,
        currency: 'EUR',
        salvage,
        airbagDeployed: severity === 'minor' ? false : rng.chance(60),
        description: `${severity} damage recorded (${areas.join(', ')})`,
        source: 'insurance_claim',
      });
    }
    return out;
  }

  private buildRegistrations(
    rng: SeededRandom,
    firstRegistration: string,
    firstRegYear: number,
    ageYears: number,
    homeCountry: string,
    secondCountry: string | null,
  ): VinHistoryRegistration[] {
    const out: VinHistoryRegistration[] = [
      {
        countryCode: homeCountry,
        region: null,
        firstRegistration,
        lastRegistration: secondCountry
          ? isoDate(firstRegYear + Math.max(1, Math.floor(ageYears / 2)), rng.intBetween(1, 12), 15)
          : null,
        plateMasked: `${homeCountry}-****${rng.intBetween(10, 99)}`,
        status: secondCountry ? 'exported' : 'active',
      },
    ];
    if (secondCountry) {
      out.push({
        countryCode: secondCountry,
        region: null,
        firstRegistration: isoDate(
          firstRegYear + Math.max(1, Math.floor(ageYears / 2)),
          rng.intBetween(1, 12),
          20,
        ),
        lastRegistration: null,
        plateMasked: `${secondCountry}-****${rng.intBetween(10, 99)}`,
        status: 'active',
      });
    }
    return out;
  }

  private buildRecalls(rng: SeededRandom, firstRegYear: number): VinHistoryRecall[] {
    const count = rng.chance(45) ? rng.intBetween(1, 2) : 0;
    return Array.from({ length: count }, (_, i) => ({
      reference: `RC-${firstRegYear}-${1000 + rng.int(9000)}`,
      issuedAt: isoDate(firstRegYear + rng.intBetween(1, 6), rng.intBetween(1, 12), 10),
      authority: 'KBA',
      title: RECALL_TITLES[(i + rng.int(RECALL_TITLES.length)) % RECALL_TITLES.length],
      description: null,
      open: rng.chance(35),
    }));
  }

  private buildTheft(
    rng: SeededRandom,
    firstRegYear: number,
    ageYears: number,
    country: string,
  ): VinHistoryTheft {
    if (!rng.chance(4)) {
      return { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null };
    }
    const year = firstRegYear + rng.intBetween(1, Math.max(1, ageYears));
    return {
      stolen: true,
      reportedAt: isoDate(year, rng.intBetween(1, 12), 5),
      countryCode: country,
      recoveredAt: rng.chance(50) ? isoDate(year, rng.intBetween(1, 12), 20) : null,
      source: 'police_registry',
    };
  }

  private buildInspections(
    rng: SeededRandom,
    firstRegYear: number,
    ageYears: number,
    country: string,
    mileage: VinHistoryMileageRecord[],
  ): VinHistoryInspection[] {
    const out: VinHistoryInspection[] = [];
    for (let year = firstRegYear + 3; year <= firstRegYear + ageYears; year += 2) {
      const result = rng.pick(['pass', 'pass', 'pass_with_defects', 'fail'] as const);
      const nearest = mileage.find((m) => m.date.startsWith(String(year)));
      out.push({
        date: isoDate(year, rng.intBetween(1, 12), rng.intBetween(1, 28)),
        countryCode: country,
        authority: rng.pick(INSPECTION_AUTHORITIES),
        result,
        mileageKm: nearest ? nearest.mileageKm : null,
        defects:
          result === 'pass'
            ? []
            : [rng.pick(['brake wear', 'headlight adjustment', 'corrosion', 'tyre depth'] as const)],
        nextDueDate: isoDate(year + 2, rng.intBetween(1, 12), 15),
      });
    }
    return out;
  }
}
