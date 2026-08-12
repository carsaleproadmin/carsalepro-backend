// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no network, no Nest container.
/**
 * The CarAPI mapper.
 *
 * ✅ EVERY FIXTURE HERE IS A REAL RESPONSE, captured from the live API on
 * 2026-08-12 and stored unedited in `test/fixtures/carapi/`. That is the
 * opposite of the CarsXE mapper's tests next door, whose bodies are hand-written
 * from prose documentation. These assertions pin behaviour against the truth.
 *
 * One fixture is deliberately mismatched: `valuation.de.found.json` is a VW Golf
 * because the BMW X6 that every other fixture describes MISSED — coverage there
 * is per model, not merely per country, and both answers are worth testing.
 *
 * The tests that matter most are the ones about NUMBERS THAT LOOK FINE WHEN THEY
 * ARE WRONG: a mileage in the wrong unit, a rollback hidden by a sort, a build
 * country printed as a registration country, a float where cents belong.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { CarapiRawBundle, CarapiSection } from './carapi.client';
import { CARAPI_MILEAGE_UNIT, mapCarapiToPayloadV2, vehicleFromCarapiDecode } from './carapi.mapper';

const VIN = 'WBAKU210X00R62021';
const GENERATED_AT = '2026-08-12T09:00:00.000Z';

function fixture<T = Record<string, unknown>>(name: string): T {
  const path = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'carapi', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function ok<T>(body: T): CarapiSection<T> {
  return { status: 'ok', body };
}

const FAILED = { status: 'failed', reason: 'http_503' } as const;
const SKIPPED = { status: 'skipped', reason: 'not_requested' } as const;

/** Everything the six endpoints returned for the fixture VIN. */
function fullBundle(overrides: Partial<CarapiRawBundle> = {}): CarapiRawBundle {
  return {
    vinDecode: ok(fixture('vin-decode.eu-bmw-x6.json')),
    mileageHistory: ok(fixture('mileage-history.eu-bmw-x6.json')),
    stolenCheck: ok(fixture('stolen-check.eu-bmw-x6.json')),
    inspection: ok(fixture('inspection.cz.eu-bmw-x6.json')),
    valuation: ok(fixture('valuation.de.found.json')),
    timeToSell: ok(fixture('time-to-sell.de.json')),
    request: { inspectionCountry: 'CZ', marketCountry: 'DE' },
    ...overrides,
  };
}

function map(bundle: CarapiRawBundle = fullBundle()): VinHistoryPayloadV2 {
  return mapCarapiToPayloadV2(bundle, {
    vin: VIN,
    provider: 'carapi',
    generatedAt: GENERATED_AT,
  });
}

// ===========================================================================
// The decode
// ===========================================================================

describe('CarAPI mapper — the decoded vehicle', () => {
  it('names the car from the decode', () => {
    expect(map().vehicle).toEqual({
      make: 'BMW',
      model: 'X6',
      // No model year is published anywhere in this API — see below.
      modelYear: null,
      bodyClass: 'SUV',
      fuelType: 'petrol',
      plantCountry: 'Germany',
      source: 'carapi-vin-decode',
      // Paid content. The decode supplies all three and the contract had no
      // home for them until a second source made it worth adding one — a buyer
      // comparing two listings of the same model wants the gearbox, the driven
      // wheels and the power.
      transmission: 'automatic',
      drivetrain: 'ALL_WHEEL_DRIVE',
      // Kilowatts, the unit the source states and the unit we store.
      enginePowerKw: 225,
    });
  });

  it('keeps the equipment grouping the source supplied', () => {
    const equipment = map().equipment;
    expect(equipment?.standard).toHaveLength(51);

    // The same 51 items, carrying the source's own category labels. Fifty-one
    // options in one column is a wall of text; the grouping is what makes it
    // readable, and it arrives free with every decode.
    const groups = equipment?.groups ?? [];
    expect(groups.map((g) => g.category)).toEqual([
      'SAFETY_SYSTEM',
      'ASSISTANCE_SYSTEM',
      'VEHICLE_SECURITY',
      'INTERIOR_FEATURE',
    ]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(51);
    expect(groups[0].items).toContain('ABS');
  });

  it('⚠️ never turns the BUILD country into a registration or an owner country', () => {
    /*
     * The decode names Germany twice — `manufacturer.country` and
     * `manufacturer.region` — and neither means the car is German. Both come
     * from the world manufacturer identifier (BMW AG), and this API has no field
     * anywhere for the country a vehicle is registered in. The fixture vehicle's
     * mileage cadence says it is almost certainly Czech or Slovak.
     *
     * `plantCountry` is the only field that means what they mean.
     */
    const payload = map();

    expect(payload.vehicle?.plantCountry).toBe('Germany');
    expect(payload.registrations).toEqual([]);
    expect(payload.owners).toEqual([]);
    expect(payload.summary.countriesSeen).toEqual([]);
    expect(payload.mileageRecords.every((record) => record.countryCode === null)).toBe(true);
    expect(payload.theft.countryCode).toBeNull();
  });

  it('⚠️ carries the registration DATE without inventing a registration record', () => {
    /*
     * `specifications.registrationDate` is the one registration fact in the
     * response, and it is a date and nothing else. A `VinHistoryRegistration`
     * needs a non-null country, the only country available is the build country,
     * and "registered in Germany" for a Czech car is the most misleading thing
     * this mapper could say. So the date is carried and the record is not built.
     */
    const payload = map();
    expect(payload.summary.firstRegistration).toBe('2016-05-04');
    expect(payload.registrations).toHaveLength(0);
  });

  it('returns no vehicle at all rather than a block of nulls', () => {
    expect(vehicleFromCarapiDecode({ status: 'ok', body: { vin: VIN } })).toBeNull();
    expect(vehicleFromCarapiDecode(FAILED)).toBeNull();
  });
});

// ===========================================================================
// Equipment
// ===========================================================================

describe('CarAPI mapper — equipment', () => {
  it('carries all 51 features in the provider’s own words and order', () => {
    const equipment = map().equipment;

    expect(equipment?.standard).toHaveLength(51);
    expect(equipment?.standard[0]).toBe('ABS');
    expect(equipment?.standard[equipment.standard.length - 1]).toBe('REAR_ARMREST');
    // SCREAMING_SNAKE, exactly as sent. Prettifying here would be this file
    // re-wording an option, and 'ELECTRIC_TRUNK' → 'Electric boot' is a
    // translation, not a formatting choice.
    expect(equipment?.standard).toContain('ELECTRIC_TRUNK');
    expect(equipment?.standard.every((name) => /^[A-Z0-9_]+$/.test(name))).toBe(true);
  });

  it('puts the decoded colour where the contract keeps a colour', () => {
    expect(map().equipment?.exteriorColors).toEqual(['GRAY']);
  });

  it('reports no equipment section rather than an empty one', () => {
    const bundle = fullBundle({ vinDecode: ok({ vin: VIN, specifications: { make: 'BMW' } }) });
    const payload = map(bundle);

    expect(payload.equipment).toBeNull();
    // `not_covered`, never `covered` and empty: a decode without a feature list
    // is not a car with no equipment.
    expect(payload.coverage.equipment).toBe('not_covered');
  });
});

// ===========================================================================
// Mileage — the section where a mistake is invisible
// ===========================================================================

describe('CarAPI mapper — mileage is KILOMETRES', () => {
  it('⚠️ leaves 239 556 as 239 556', () => {
    /*
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR.
     *
     * CarAPI sends a bare integer with no unit field. Run through the CarsXE
     * mapper's `odometerKm()`, whose `odometerUnit()` reads a blank unit as
     * MILES — correct for a US title feed — this becomes 385 527 km: a 61 %
     * inflation of the single number a buyer looks at hardest, on a document
     * somebody paid for, with nothing anywhere looking wrong.
     */
    const payload = map();
    const newest = payload.mileageRecords[payload.mileageRecords.length - 1];

    expect(CARAPI_MILEAGE_UNIT).toBe('km');
    expect(newest.mileageKm).toBe(239_556);
    expect(payload.summary.lastRecordedMileageKm).toBe(239_556);
    expect(payload.mileageRecords.map((r) => r.mileageKm)).not.toContain(385_527);
  });

  it('keeps all eight readings and orders them oldest first', () => {
    const payload = map();

    expect(payload.mileageRecords).toHaveLength(8);
    expect(payload.mileageRecords.map((r) => r.mileageKm)).toEqual([
      83_176, 91_563, 91_553, 135_170, 192_457, 239_000, 239_491, 239_556,
    ]);
    const dates = payload.mileageRecords.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('⚠️ flags the same-day drop from 91 563 to 91 553 as suspicious', () => {
    /*
     * Both readings are dated 2020-05-25, so the date cannot order them and
     * sorting by date alone would hide the drop. The feed arrives NEWEST FIRST,
     * which makes the later array position the earlier reading — the provider's
     * own order is the only sequence evidence there is, and reversing it turns
     * this pair into the ten-kilometre rollback it is rather than a rise.
     */
    const payload = map();
    const suspicious = payload.mileageRecords.filter((r) => r.suspicious);

    expect(suspicious).toEqual([
      { date: '2020-05-25', mileageKm: 91_553, source: 'unknown', countryCode: null, suspicious: true },
    ]);
    expect(payload.summary.hasOdometerRollback).toBe(true);
  });

  it('leaves an already oldest-first feed alone', () => {
    // The direction is detected, not assumed: a feed that silently flipped order
    // one day would otherwise invert every same-day pair.
    const raw = fixture<{ mileageHistory: unknown[] }>('mileage-history.eu-bmw-x6.json');
    const reversed = { ...raw, mileageHistory: [...raw.mileageHistory].reverse() };
    const payload = map(fullBundle({ mileageHistory: ok(reversed) }));

    expect(payload.mileageRecords.map((r) => r.mileageKm)).toEqual([
      83_176, 91_563, 91_553, 135_170, 192_457, 239_000, 239_491, 239_556,
    ]);
  });

  it('⚠️ carries createdAt as the record date, calendar day only', () => {
    /*
     * `createdAt` is when the ROW was written, not when the odometer was read:
     * some entries carry a real clock, others are midnight CEST, which is the
     * signature of a bulk import. It is the only date the record has, so it
     * orders the series — but a report must say "recorded", never "measured",
     * and printing a time of day would imply a precision that is not there.
     */
    const payload = map();
    expect(payload.mileageRecords[payload.mileageRecords.length - 1].date).toBe('2026-06-01');
    expect(payload.mileageRecords.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))).toBe(true);
  });

  it('claims no provenance for a reading', () => {
    // The two-yearly May cadence is the Czech and Slovak inspection cycle, so
    // these are very probably inspection readings — but the API does not say so,
    // and a provenance inferred from a pattern is still a claim.
    expect(map().mileageRecords.every((r) => r.source === 'unknown')).toBe(true);
  });

  it('drops a reading that cannot be placed or cannot be believed', () => {
    const payload = map(
      fullBundle({
        mileageHistory: ok({
          mileageHistory: [
            { mileage: 120_000, createdAt: '2023-05-20T02:00:00.000Z' },
            { mileage: 130_000, createdAt: null },
            { mileage: 0, createdAt: '2022-05-20T02:00:00.000Z' },
            { mileage: -5, createdAt: '2021-05-20T02:00:00.000Z' },
          ],
        }),
      }),
    );

    // An undated reading cannot prove or disprove a rollback; a zero would be
    // the lowest number in the series and would flag every later reading.
    expect(payload.mileageRecords).toHaveLength(1);
    expect(payload.summary.hasOdometerRollback).toBe(false);
  });

  it('marks the section unavailable, not empty, when the call failed', () => {
    const payload = map(fullBundle({ mileageHistory: FAILED }));

    expect(payload.mileageRecords).toEqual([]);
    expect(payload.coverage.mileage).toBe('unavailable');
    expect(payload.summary.lastRecordedMileageKm).toBeNull();
  });
});

// ===========================================================================
// Theft
// ===========================================================================

describe('CarAPI mapper — theft, and the scope of "not stolen"', () => {
  it('⚠️ carries the five registers that were actually searched', () => {
    /*
     * `stolen: false` covers these five countries and no others — not Germany,
     * not Poland, not Austria, and not necessarily the country the car is
     * registered in. The boolean on its own reads as a clean bill of health for
     * a register nobody searched.
     */
    const payload = map();

    expect(payload.theft).toEqual({
      stolen: false,
      reportedAt: null,
      countryCode: null,
      recoveredAt: null,
      source: 'carapi.stolenCheck',
    });
    expect(payload.theftCoverage).toEqual({ countryCodes: ['SK', 'CZ', 'SI', 'HU', 'RO'] });
    expect(payload.coverage.theft).toBe('covered');
    expect(payload.summary.hasStolenRecord).toBe(false);
  });

  it('names the country when exactly one register reports the theft', () => {
    const payload = map(
      fullBundle({
        stolenCheck: ok({ vin: VIN, stolen: true, countries: { sk: false, cz: true, si: false } }),
      }),
    );

    expect(payload.theft.stolen).toBe(true);
    expect(payload.theft.countryCode).toBe('CZ');
    expect(payload.summary.hasStolenRecord).toBe(true);
    expect(payload.summary.recordCount).toBe(payload.mileageRecords.length + 1);
  });

  it('names no country when two registers report it', () => {
    // One theft seen twice. Picking one would name a country arbitrarily; the
    // full list stays in `theftCoverage`.
    const payload = map(
      fullBundle({ stolenCheck: ok({ stolen: true, countries: { sk: true, cz: true } }) }),
    );

    expect(payload.theft.countryCode).toBeNull();
    expect(payload.theftCoverage).toEqual({ countryCodes: ['SK', 'CZ'] });
  });

  it('publishes no scope rather than an empty one when the map is missing', () => {
    const payload = map(fullBundle({ stolenCheck: ok({ vin: VIN, stolen: false }) }));
    expect(payload.theftCoverage).toBeNull();
  });

  it('marks theft unavailable when the register did not answer', () => {
    const payload = map(fullBundle({ stolenCheck: FAILED }));

    expect(payload.theft.stolen).toBe(false);
    expect(payload.theft.source).toBeNull();
    // The pairing that stops the all-false object reading as "we checked".
    expect(payload.coverage.theft).toBe('unavailable');
    expect(payload.theftCoverage).toBeNull();
  });
});

// ===========================================================================
// Inspection validity
// ===========================================================================

describe('CarAPI mapper — inspection validity is not an inspection', () => {
  it('⚠️ carries the two expiry dates and leaves inspections[] empty', () => {
    /*
     * STK is the technical inspection, EK the emissions test, and both fields
     * are the date the CURRENT certificate runs out. They say nothing about when
     * the car was inspected or whether it passed, so they cannot become a
     * `VinHistoryInspection` — whose `result` would have to be filled with
     * something and whose `date` would be read as the date of a test.
     */
    const payload = map();

    expect(payload.inspectionValidity).toEqual({
      countryCode: 'CZ',
      technicalValidTo: '2028-05-20',
      emissionsValidTo: '2028-05-20',
    });
    expect(payload.inspections).toEqual([]);
  });

  it('⚠️ keeps coverage.inspections at not_covered even on a successful call', () => {
    /*
     * `covered` plus an empty array means "we looked and this car has no
     * inspection events" — which for a car whose certificate is valid to 2028
     * is nonsense, and worse, it is nonsense a buyer would believe. CarAPI holds
     * no inspection events for any VIN, ever. The call's own outcome is visible
     * in `sources[]` and its content in `inspectionValidity`.
     */
    const payload = map();

    expect(payload.coverage.inspections).toBe('not_covered');
    expect(payload.coverage.inspectionValidity).toBe('covered');
    expect(payload.sources).toContainEqual({
      id: 'carapi.inspection',
      status: 'ok',
      dataset: 'CarAPI Technical Inspection',
    });
  });

  it('falls back to the country we asked about when the body omits it', () => {
    const payload = map(
      fullBundle({
        inspection: ok({ vin: VIN, inspection: { stkValidTo: '2027-01-31', ekValidTo: null } }),
        request: { inspectionCountry: 'SK', marketCountry: 'DE' },
      }),
    );

    expect(payload.inspectionValidity).toEqual({
      countryCode: 'SK',
      technicalValidTo: '2027-01-31',
      emissionsValidTo: null,
    });
  });

  it('says unavailable when the register did not answer, and nothing when it was never asked', () => {
    expect(map(fullBundle({ inspection: FAILED })).coverage.inspectionValidity).toBe('unavailable');

    const skipped = map(fullBundle({ inspection: SKIPPED, request: { inspectionCountry: null, marketCountry: 'DE' } }));
    expect(skipped.inspectionValidity).toBeNull();
    expect(skipped.coverage.inspectionValidity).toBe('not_covered');
  });
});

// ===========================================================================
// Money
// ===========================================================================

describe('CarAPI mapper — valuation', () => {
  it('turns 10 975.00 EUR into integer cents and keeps the currency on the figure', () => {
    const payload = map();

    expect(payload.marketValue).toEqual({
      currency: 'EUR',
      // One scalar price and no condition ladder: the only band it can honestly
      // occupy is the middle one.
      retail: { excellentCents: null, cleanCents: null, averageCents: 1_097_500, roughCents: null },
      tradeIn: null,
      msrpCents: null,
      // The valuation was computed for a make, model and year — not at any
      // particular odometer reading.
      mileageKm: null,
      asOf: null,
    });
    expect(Number.isInteger(payload.marketValue?.retail?.averageCents)).toBe(true);
    expect(payload.coverage.marketValue).toBe('covered');
  });

  it('lists valuations one per source and never blends them', () => {
    const payload = map();
    expect(payload.marketValues).toEqual([payload.marketValue]);
  });

  it('⚠️ reports the miss as not_covered — coverage is per MODEL, not per country', () => {
    // The BMW X6 has no German valuation while the VW Golf does. `empty` from
    // the client, and an absent valuation is not a car worth nothing.
    const payload = map(fullBundle({ valuation: { status: 'empty', reason: 'not found' } }));

    expect(payload.marketValue).toBeNull();
    expect(payload.marketValues).toEqual([]);
    expect(payload.coverage.marketValue).toBe('not_covered');
  });

  it('says unavailable when the valuation endpoint broke', () => {
    expect(map(fullBundle({ valuation: FAILED })).coverage.marketValue).toBe('unavailable');
  });
});

describe('CarAPI mapper — time to sell', () => {
  it('carries the median and both quartiles for the market that was asked', () => {
    const payload = map();

    expect(payload.timeToSell).toEqual({
      countryCode: 'DE',
      medianDays: 28,
      p25Days: 14,
      p75Days: 63,
    });
    expect(payload.coverage.timeToSell).toBe('covered');
  });

  it('⚠️ counts for nothing towards the records the buyer paid for', () => {
    /*
     * It is a statistic about a MARKET, not a record about this car. A report
     * whose only content was "a BMW X6 sells in 28 days in Germany" would pass a
     * sellability check it should fail.
     */
    const payload = map(fullBundle({ mileageHistory: FAILED, stolenCheck: FAILED }));
    expect(payload.timeToSell).not.toBeNull();
    expect(payload.summary.recordCount).toBe(0);
  });

  it('drops the block when the median is missing, quartiles or not', () => {
    const payload = map(fullBundle({ timeToSell: ok({ country: 'DE', p25Days: 14, p75Days: 63 }) }));
    expect(payload.timeToSell).toBeNull();
    expect(payload.coverage.timeToSell).toBe('not_covered');
  });

  it('keeps a median with no spread around it', () => {
    // A thin cohort publishes a median alone, and null quartiles are not zeros.
    const payload = map(fullBundle({ timeToSell: ok({ country: 'AT', medianDaysToSell: 41 }) }));
    expect(payload.timeToSell).toEqual({ countryCode: 'AT', medianDays: 41, p25Days: null, p75Days: null });
  });
});

// ===========================================================================
// Coverage and sources
// ===========================================================================

describe('CarAPI mapper — coverage says what was asked and what was answered', () => {
  it('marks every section this provider simply does not have', () => {
    const payload = map();

    // Not incidents, and not empty findings: CarAPI holds none of these for any
    // VIN. A buyer reads "this source does not have it", never a blank table.
    for (const section of [
      'owners',
      'damages',
      'registrations',
      'recalls',
      'insurance',
      'brands',
      'service',
    ] as const) {
      expect(payload.coverage[section]).toBe('not_covered');
    }
  });

  it('names all six datasets with their outcome', () => {
    const payload = map(fullBundle({ valuation: FAILED, timeToSell: SKIPPED }));

    expect(payload.sources).toEqual([
      { id: 'carapi.vinDecode', status: 'ok', dataset: 'CarAPI VIN Decode' },
      { id: 'carapi.mileageHistory', status: 'ok', dataset: 'CarAPI Mileage History' },
      { id: 'carapi.stolenCheck', status: 'ok', dataset: 'CarAPI Stolen Check' },
      { id: 'carapi.inspection', status: 'ok', dataset: 'CarAPI Technical Inspection' },
      { id: 'carapi.valuation', status: 'failed', dataset: 'CarAPI Vehicle Valuation' },
      { id: 'carapi.timeToSell', status: 'skipped', dataset: 'CarAPI Time to Sell' },
    ]);
  });

  it('an empty answer is covered, a failure is not', () => {
    const payload = map(
      fullBundle({
        mileageHistory: { status: 'empty', reason: 'invalid_vin' },
        stolenCheck: FAILED,
      }),
    );

    // "We asked and there is nothing" and "we asked and it broke" are different
    // things to tell someone deciding whether to buy a car.
    expect(payload.coverage.mileage).toBe('covered');
    expect(payload.coverage.theft).toBe('unavailable');
  });
});

// ===========================================================================
// It must never throw
// ===========================================================================

describe('CarAPI mapper — a renamed or missing key degrades one field, never the report', () => {
  it('survives a bundle where every section was skipped', () => {
    const empty: CarapiRawBundle = {
      vinDecode: SKIPPED,
      mileageHistory: SKIPPED,
      stolenCheck: SKIPPED,
      inspection: SKIPPED,
      valuation: SKIPPED,
      timeToSell: SKIPPED,
      request: { inspectionCountry: null, marketCountry: null },
    };
    const payload = map(empty);

    expect(payload.summary.recordCount).toBe(0);
    expect(payload.vehicle).toBeNull();
    expect(payload.equipment).toBeNull();
    expect(payload.theft.stolen).toBe(false);
  });

  it('⚠️ survives every key being renamed, and still returns a valid payload', () => {
    /*
     * The fixtures are real, so these names are right TODAY. A provider that
     * renames a field must cost us one field — never a throw, because this
     * mapper runs inside `fulfill`, where a throw refunds the buyer AND pages
     * every admin. An undeliverable report is a normal outcome; a crash is an
     * incident, and mixing the two trains operators to ignore the channel.
     */
    const renamed: CarapiRawBundle = {
      vinDecode: ok({ vin: VIN, specs: { make: 'BMW' }, feature_list: [{ title: 'ABS' }] }),
      mileageHistory: ok({ vin: VIN, records: [{ km: 1000, date: '2020-01-01' }] }),
      stolenCheck: ok({ vin: VIN, is_stolen: false, registers: { cz: false } }),
      inspection: ok({ vin: VIN, validity: { technical: '2028-05-20' } }),
      valuation: ok({ price: 10975, currency: 'EUR' }),
      timeToSell: ok({ country: 'DE', median: 28 }),
      request: { inspectionCountry: 'CZ', marketCountry: 'DE' },
    };
    const payload = map(renamed);

    expect(payload.schemaVersion).toBe(2);
    expect(payload.vehicle).toBeNull();
    expect(payload.mileageRecords).toEqual([]);
    expect(payload.marketValue).toBeNull();
    expect(payload.timeToSell).toBeNull();
    expect(payload.inspectionValidity).toBeNull();
  });

  it('survives wrong TYPES where objects and arrays were expected', () => {
    const wrong: CarapiRawBundle = {
      vinDecode: ok({ specifications: 'BMW X6', features: 'ABS, ESP', manufacturer: [] }),
      mileageHistory: ok({ mileageHistory: { mileage: 'lots', createdAt: 42 } }),
      stolenCheck: ok({ stolen: 'no', countries: ['cz', 'sk'] }),
      inspection: ok({ inspection: 'valid until 2028' }),
      valuation: ok({ valuationPrice: 'ten thousand' }),
      timeToSell: ok({ medianDaysToSell: {} }),
      request: { inspectionCountry: 'CZ', marketCountry: 'DE' },
    };

    expect(() => map(wrong)).not.toThrow();
    const payload = map(wrong);
    expect(payload.mileageRecords).toEqual([]);
    // 'no' is a boolean the provider spelled out, and it still is not stolen.
    expect(payload.theft.stolen).toBe(false);
  });

  it('survives a body that is not an object at all', () => {
    const nonsense = ok(null as unknown as Record<string, unknown>);
    const bundle = fullBundle({
      vinDecode: nonsense,
      mileageHistory: nonsense,
      stolenCheck: nonsense,
      inspection: nonsense,
      valuation: nonsense,
      timeToSell: nonsense,
    });

    expect(() => map(bundle)).not.toThrow();
  });
});

// ===========================================================================
// Invariants
// ===========================================================================

describe('CarAPI mapper — invariants that hold for every payload', () => {
  const payload = map();

  it('is sourced, versioned and stamped with OUR vin', () => {
    // `synthetic: false` is never conditional: this data came from records.
    expect(payload.synthetic).toBe(false);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.provider).toBe('carapi');
    expect(payload.vin).toBe(VIN);
    expect(payload.generatedAt).toBe(GENERATED_AT);
  });

  it('agrees with itself about how many records it holds', () => {
    expect(payload.summary.recordCount).toBe(
      payload.mileageRecords.length + (payload.theft.stolen ? 1 : 0),
    );
    expect(payload.summary.ownersCount).toBe(payload.owners.length);
    expect(payload.summary.insuranceRecordCount).toBe(payload.insuranceRecords.length);
    expect(payload.summary.brandCount).toBe(payload.brands.length);
    expect(payload.summary.serviceRecordCount).toBe(payload.serviceRecords.length);
    expect(payload.summary.hasAccidentRecords).toBe(payload.damageRecords.length > 0);
  });

  it('carries every money figure as integer cents', () => {
    const money = [
      payload.marketValue?.retail?.averageCents,
      payload.marketValue?.msrpCents,
      payload.equipment?.msrpCents,
      ...(payload.marketValues ?? []).map((value) => value.retail?.averageCents),
    ];
    for (const amount of money) {
      if (amount === null || amount === undefined) continue;
      expect(Number.isInteger(amount)).toBe(true);
    }
  });

  it('writes every date as a plain ISO calendar day', () => {
    const dates = [
      payload.summary.firstRegistration,
      payload.inspectionValidity?.technicalValidTo,
      payload.inspectionValidity?.emissionsValidTo,
      ...payload.mileageRecords.map((record) => record.date),
    ];
    for (const date of dates) {
      if (date === null || date === undefined) continue;
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('survives a round trip through JSON, which is how it is stored', () => {
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
