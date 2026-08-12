/**
 * CarAPI's raw responses → `VinHistoryPayloadV2`.
 *
 * PURE. No network, no Nest, no clock — `generatedAt` is an argument precisely
 * so a test can assert the whole payload byte for byte. Everything the adapter
 * knows about CarAPI's shape lives here, so replacing the provider is this file
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
 * ✅ THE SHAPES HERE ARE OBSERVED, not documented. Every fixture in
 * `test/fixtures/carapi/` is a real body captured on 2026-08-12. That is why the
 * readers below are plain — one key name, checked — rather than the multi-
 * spelling probes the CarsXE mapper needs. The defence against a renamed key is
 * that every read is null-safe and every section is wrapped, not that we guessed
 * six names for each field.
 *
 * ⚠️ NOTHING IS IMPORTED FROM `carsxe.*`. Not for tidiness: the two providers
 * disagree about what a bare odometer number means, and sharing one line of that
 * code is how 239 556 km becomes 385 527 km on a document somebody paid for. See
 * `CARAPI_MILEAGE_UNIT`.
 */

import {
  VinHistoryDamageRecord,
  VinHistoryInspection,
  VinHistoryMileageRecord,
  VinHistoryOwner,
  VinHistoryRecall,
  VinHistoryRegistration,
  VinHistoryTheft,
} from '../vin-history-payload-v1';
import {
  emptyCoverageMap,
  VinHistoryCoverageMap,
  VinHistoryEquipment,
  VinHistoryInspectionValidity,
  VinHistoryMarketValue,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  VinHistorySource,
  VinHistorySummaryV2,
  VinHistoryTheftCoverage,
  VinHistoryTimeToSell,
  VinHistoryVehicle,
} from '../vin-history-payload-v2';
import { asArray, normalizeDate, toCents } from '../vin-history-normalize';
import {
  carapiDataset,
  CarapiEndpointId,
  CarapiRawBundle,
  CarapiSection,
  CarapiVinDecodeResponse,
} from './carapi.client';

// ===========================================================================
// The one constant that must never be got wrong
// ===========================================================================

/**
 * ⚠️ CARAPI MILEAGE IS KILOMETRES, AND NOTHING IN THE RESPONSE SAYS SO.
 *
 * `mileageHistory[].mileage` is a bare integer. There is no unit field, no
 * suffix, no header — the unit is knowledge about the provider, not data in the
 * response, so it is written down here as a constant rather than read.
 *
 * The evidence: the fixture VIN is a Czech- or Slovak-registered BMW X6 (the
 * readings fall on the biennial-May technical-inspection cadence of both) whose
 * newest reading is 239 556. As miles that is 385 527 km on a ten-year-old car —
 * possible only in theory. As kilometres it is an ordinary high-mileage diesel-
 * era SUV. Both markets record odometers in kilometres.
 *
 * ⚠️ AND THIS IS WHY `odometerKm()` FROM `carsxe.mapper.ts` MUST NEVER BE USED
 * HERE. That helper pairs a value with `odometerUnit()`, which reads a blank
 * unit as MILES — correct for a US title feed, where an unlabelled odometer
 * really is in miles, and exactly wrong here. Borrowing it inflates every CarAPI
 * reading by 61 %, silently, on the single number a buyer looks at hardest.
 * `carapi.mapper.spec.ts` pins 239 556 → 239 556.
 */
export const CARAPI_MILEAGE_UNIT = 'km' as const;

/** The decoder named on the report beside the vehicle it decoded. */
const DECODER = 'carapi-vin-decode';

/** Named on the theft record, so a disputed finding can be traced upstream. */
const SOURCE_STOLEN_CHECK = 'carapi.stolenCheck';

export interface CarapiMapperContext {
  vin: string;
  provider: string;
  generatedAt: string;
}

// ===========================================================================
// Readers
// ===========================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return isRecord(value) ? value : null;
}

function textAt(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberAt(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[\s,](?=\d{3}\b)/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolAt(source: unknown, key: string): boolean | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(t)) return true;
    if (['false', 'no', 'n', '0'].includes(t)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return null;
}

/** A list from a key that may hold one object, a list, or nothing. */
function listAt(source: unknown, key: string): unknown[] {
  if (!isRecord(source)) return [];
  return asArray(source[key] as unknown);
}

function dateAt(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  return normalizeDate(source[key]);
}

/** An ISO-3166 alpha-2 code as we store it: upper case, or nothing. */
function countryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Build a section, or give up on it quietly.
 *
 * The mapper must not throw (see the file header). A section that blows up on an
 * unforeseen shape yields nothing rather than taking the others with it — the
 * buyer keeps a report missing one part instead of a refund plus an admin alert.
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
function coverageFor(section: CarapiSection<unknown>): VinHistorySectionCoverage {
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

function bodyOf<T>(section: CarapiSection<T>): T | null {
  return section.status === 'ok' ? section.body : null;
}

function sourceEntry(id: CarapiEndpointId, section: CarapiSection<unknown>): VinHistorySource {
  const status: VinHistorySource['status'] =
    section.status === 'failed' ? 'failed' : section.status === 'skipped' ? 'skipped' : 'ok';
  return { id: `carapi.${id}`, status, dataset: carapiDataset(id) };
}

// ===========================================================================
// The decoded vehicle
// ===========================================================================

/**
 * Which car this VIN is, from `/vin-decode`.
 *
 * ⚠️ `manufacturer.country` AND `manufacturer.region` ARE THE BUILD COUNTRY.
 * They come from the world manufacturer identifier — 'BMW AG', 'Germany',
 * 'Europe' — and describe who built the car, not where it lives. CarAPI has no
 * field anywhere for the country a vehicle is registered in. `plantCountry` is
 * the only place either may land, because that is the only field in the contract
 * that means what they mean. Neither may ever become an owner country, a
 * registration country or a `countriesSeen` entry: a German-built BMW registered
 * in Prague for its whole life would then be reported as a German car.
 *
 * `modelYear` stays null. The decode publishes no model year at all —
 * `registrationDate` is the only year in the response, and a car registered in
 * May 2016 may be a 2015 build. The client uses that year to LOOK UP a
 * valuation, which is a query; writing it here would be a claim.
 *
 * Exported so a provider can build the vehicle block for a free preview without
 * mapping a whole payload.
 */
export function vehicleFromCarapiDecode(
  section: CarapiSection<CarapiVinDecodeResponse>,
): VinHistoryVehicle | null {
  const body = bodyOf(section);
  if (!body) return null;

  const specs = recordAt(body, 'specifications');
  const manufacturer = recordAt(body, 'manufacturer');

  const vehicle: VinHistoryVehicle = {
    make: textAt(specs, 'make'),
    model: textAt(specs, 'model'),
    modelYear: null,
    bodyClass: textAt(specs, 'bodyStyle'),
    fuelType: textAt(specs, 'fuel'),
    // The BUILD country. See the warning above.
    plantCountry: textAt(manufacturer, 'country'),
    source: DECODER,
    // Paid content the decode supplies and the contract had no home for until
    // the second source arrived. Power is kW, the unit CarAPI states and the
    // unit the contract stores; converting for a reader is the renderer's job.
    transmission: textAt(specs, 'transmission'),
    drivetrain: textAt(specs, 'drivetrain'),
    enginePowerKw: numberAt(specs, 'enginePower'),
  };

  // Nothing decoded is not a vehicle — an object of six nulls would print an
  // empty vehicle block instead of omitting it.
  const known = [vehicle.make, vehicle.model, vehicle.bodyClass, vehicle.fuelType, vehicle.plantCountry];
  if (known.every((value) => value === null)) return null;
  return vehicle;
}

// ===========================================================================
// Equipment
// ===========================================================================

/**
 * `features[]` → `equipment.standard`, in the provider's own words.
 *
 * The names arrive SCREAMING_SNAKE ('BLIND_SPOT_MONITOR', 'REAR_ARMREST') and
 * are carried through exactly as sent. Prettifying them here would be this file
 * re-wording an option — and 'ELECTRIC_TRUNK' turned into 'Electric boot' is a
 * translation, not a formatting choice. Presentation belongs in the report
 * model, which resolves labels per locale; the payload keeps the raw token so
 * that resolution has something stable to key on.
 *
 * `category` (SAFETY_SYSTEM, ASSISTANCE_SYSTEM, VEHICLE_SECURITY,
 * INTERIOR_FEATURE) is kept in `equipment.groups`, which the contract gained for
 * it. `standard` stays the flat list every existing reader already understands;
 * the groups carry the SAME items with the source's own labels, because
 * fifty-one options in one column is a wall of text and the grouping is what
 * makes it readable. Category names are not re-worded — a wrong grouping is
 * worse than an unfamiliar one.
 */
function buildEquipment(section: CarapiSection<CarapiVinDecodeResponse>): VinHistoryEquipment | null {
  const body = bodyOf(section);
  if (!body) return null;

  const seen = new Set<string>();
  const standard: string[] = [];
  // Insertion-ordered, so the groups come out in the order the source sent them.
  const grouped = new Map<string, string[]>();
  for (const feature of listAt(body, 'features')) {
    const name = isRecord(feature) ? textAt(feature, 'name') : typeof feature === 'string' ? feature.trim() : null;
    if (name === null || name === '' || seen.has(name)) continue;
    seen.add(name);
    standard.push(name);

    const category = isRecord(feature) ? textAt(feature, 'category') : null;
    if (category === null) continue;
    const bucket = grouped.get(category);
    if (bucket) bucket.push(name);
    else grouped.set(category, [name]);
  }
  const groups = [...grouped].map(([category, items]) => ({ category, items }));

  /*
   * `specifications.color` is the colour this car actually is — CarAPI decodes
   * the built vehicle, not a brochure. `exteriorColors` is the only field in the
   * contract that holds a colour, so it goes there as a single-entry list, and
   * the report renders one colour rather than a palette of options.
   */
  const color = textAt(recordAt(body, 'specifications'), 'color');

  if (standard.length === 0 && color === null) return null;

  return {
    standard,
    // Omitted rather than empty: a source that grouped nothing should not make
    // the report print an empty grouping.
    ...(groups.length > 0 ? { groups } : {}),
    exteriorColors: color !== null ? [color] : [],
    // CarAPI decodes neither of these, and an empty array under a heading reads
    // as "none fitted" only if the report prints the heading — which it does not
    // for an empty list.
    interiorColors: [],
    warranties: [],
    msrpCents: null,
    invoiceCents: null,
    currency: null,
  };
}

// ===========================================================================
// Mileage
// ===========================================================================

interface MileageReading {
  /**
   * ⚠️ THE RECORD-CREATION DATE, NOT THE MEASUREMENT DATE.
   *
   * CarAPI calls it `createdAt`, and that is exactly what it is: when the row
   * was written into the provider's database. Some entries carry a real clock
   * (08:03:39.771Z), others are midnight CEST, which is the signature of a bulk
   * import of readings taken some earlier day. It is the only date the record
   * has, so it is carried as the record's date and used to order the series —
   * but it must never be presented to a buyer as "the odometer read X on this
   * day". The report wording says "recorded", never "measured".
   */
  date: string;
  km: number;
  /** Position in the provider's own array. The tie-break — see `readMileage`. */
  order: number;
}

/**
 * The readings, oldest first, with rollbacks computed.
 *
 * ⚠️ THE PROVIDER'S OWN ORDER IS EVIDENCE, AND SORTING BY DATE ALONE THROWS IT
 * AWAY. The fixture holds two readings dated the same day, 91 563 and 91 553, and
 * which of them came first decides whether this car has an odometer rollback on
 * its report or not. The array arrives NEWEST FIRST, so within a single date the
 * later array position is the earlier reading; reversing that order is the only
 * information available about the sequence, and it turns the pair into the drop
 * it is rather than a rise.
 *
 * The direction is detected rather than assumed: if the first dated entry is
 * older than the last, the feed is already oldest-first and is left alone. A feed
 * that silently flips order one day would otherwise invert every same-day pair.
 *
 * `suspicious` is OURS, not the provider's — it publishes readings and no
 * verdict. It is computed after the ordering, because a series compared in the
 * wrong order hides exactly the rollback it is meant to expose.
 */
function buildMileage(readings: MileageReading[]): VinHistoryMileageRecord[] {
  if (readings.length === 0) return [];

  const first = readings[0];
  const last = readings[readings.length - 1];
  const newestFirst = first.date > last.date;

  const ordered = [...readings].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    // Same day: fall back to the provider's order, reversed when the feed is
    // newest-first so that "later in the array" means "earlier in time".
    return newestFirst ? b.order - a.order : a.order - b.order;
  });

  let highestSoFar = 0;
  return ordered.map((reading) => {
    const record: VinHistoryMileageRecord = {
      date: reading.date,
      mileageKm: reading.km,
      /*
       * `unknown`, deliberately. The readings fall on a two-yearly May cadence,
       * which is the Czech and Slovak technical-inspection cycle, so they are
       * very probably inspection readings — but CarAPI does not say so, and
       * printing a provenance we inferred from a pattern is a claim about where
       * a number came from that nobody can back up.
       */
      source: 'unknown',
      // No country either: the decode names only the BUILD country, and putting
      // that here would report a German odometer reading for a Czech car.
      countryCode: null,
      suspicious: reading.km < highestSoFar,
    };
    highestSoFar = Math.max(highestSoFar, reading.km);
    return record;
  });
}

function readMileage(section: CarapiSection<unknown>): VinHistoryMileageRecord[] {
  const body = bodyOf(section);
  if (!body) return [];

  const readings: MileageReading[] = [];
  listAt(body, 'mileageHistory').forEach((entry, order) => {
    if (!isRecord(entry)) return;
    const km = numberAt(entry, 'mileage');
    const date = dateAt(entry, 'createdAt');
    /*
     * An undated reading is dropped: it cannot be placed in the sequence, so it
     * can neither prove nor disprove a rollback, and `date` is non-nullable on
     * the record for exactly that reason. A zero or negative reading is dropped
     * too — it is a placeholder, and as the lowest number in the series it would
     * flag every later reading as a rollback.
     */
    if (km === null || date === null || km <= 0) return;
    // The unit is not read from anywhere. It is CARAPI_MILEAGE_UNIT — see the
    // warning at the top of this file — so the number is used as it arrived,
    // rounded only to keep the field an integer.
    readings.push({ date, km: Math.round(km), order });
  });

  return buildMileage(readings);
}

// ===========================================================================
// Theft
// ===========================================================================

const NO_THEFT: VinHistoryTheft = {
  stolen: false,
  reportedAt: null,
  countryCode: null,
  recoveredAt: null,
  source: null,
};

/**
 * The stolen-vehicle registers that were searched, upper-cased.
 *
 * ⚠️ THIS IS THE FINDING, NOT THE BOOLEAN. `stolen: false` covers the five
 * countries in the map and no others — not Germany, not Poland, not Austria, and
 * not necessarily the country the car is registered in. Rendered without this
 * list the report tells a buyer the car is not stolen, on the strength of five
 * registers that may all be the wrong ones.
 *
 * Every key is returned, whatever its value: `false` for Slovakia means Slovakia
 * was searched and came back clean, which is precisely the scope being reported.
 * Provider order is kept — it is the only order there is.
 */
function readTheftCoverage(section: CarapiSection<unknown>): VinHistoryTheftCoverage | null {
  const body = bodyOf(section);
  const countries = recordAt(body, 'countries');
  if (!countries) return null;

  const codes = Object.keys(countries)
    .map((key) => countryCode(key))
    .filter((code): code is string => code !== null);

  // No recognisable countries is not an empty scope, it is an unknown one, and
  // an empty list would render as "0 registers searched" rather than silence.
  return codes.length > 0 ? { countryCodes: codes } : null;
}

function readTheft(section: CarapiSection<unknown>): VinHistoryTheft {
  const body = bodyOf(section);
  if (!body) return NO_THEFT;

  const stolen = boolAt(body, 'stolen');
  if (stolen !== true) {
    // Not stolen ACCORDING TO THOSE REGISTERS. The source is recorded even for a
    // negative, so the report can name who was asked.
    return { ...NO_THEFT, source: SOURCE_STOLEN_CHECK };
  }

  const countries = recordAt(body, 'countries');
  const flagged = countries
    ? Object.entries(countries)
        .filter(([, value]) => value === true)
        .map(([key]) => countryCode(key))
        .filter((code): code is string => code !== null)
    : [];

  return {
    stolen: true,
    // CarAPI publishes no theft date and no recovery date — only the flag.
    reportedAt: null,
    /*
     * Only when exactly one register reports it. Two registers reporting the
     * same theft is one event seen twice, and picking one of them would name a
     * country arbitrarily; the full list stays in `theftCoverage`.
     */
    countryCode: flagged.length === 1 ? flagged[0] : null,
    recoveredAt: null,
    source: SOURCE_STOLEN_CHECK,
  };
}

// ===========================================================================
// Inspection validity
// ===========================================================================

/**
 * `{stkValidTo, ekValidTo}` → the validity block, never an inspection event.
 *
 * STK is *stanice technické kontroly*, the Czech and Slovak technical inspection;
 * EK is *emisní kontrola*, the emissions test. Both fields are the date the
 * current certificate RUNS OUT. They do not say when the car was inspected, by
 * whom, or whether it passed — so they cannot become a `VinHistoryInspection`,
 * whose `result` field would have to be filled with something, and whose `date`
 * would be read as the date of a test that this response never described.
 *
 * A validity date in the past is left exactly as it is. "The certificate expired
 * in 2024" is a fact about the car; deciding what that means for a buyer is the
 * report's job, not the mapper's.
 */
function readInspectionValidity(
  section: CarapiSection<unknown>,
  requestedCountry: string | null,
): VinHistoryInspectionValidity | null {
  const body = bodyOf(section);
  if (!body) return null;

  const inspection = recordAt(body, 'inspection');
  const technicalValidTo = dateAt(inspection, 'stkValidTo');
  const emissionsValidTo = dateAt(inspection, 'ekValidTo');
  if (technicalValidTo === null && emissionsValidTo === null) return null;

  // The country the answer is about: what the body says, or failing that what we
  // asked. A validity date with no jurisdiction on it is not usable.
  const code = countryCode(textAt(body, 'country')) ?? countryCode(requestedCountry);
  if (code === null) return null;

  return { countryCode: code, technicalValidTo, emissionsValidTo };
}

// ===========================================================================
// Valuation and time to sell
// ===========================================================================

/**
 * `valuationPrice` → one market value, in integer cents.
 *
 * The response carries a single scalar — 10975 EUR — and no condition ladder, so
 * the only band it can honestly occupy is the middle one. `excellent`, `clean`
 * and `rough` stay null rather than being spread around one number, and the
 * currency is carried per figure because the endpoint is asked per country and a
 * euro figure behind a dollar sign is the one mistake here that costs real
 * money.
 *
 * `mileageKm` is null: this valuation is for a make, model and year, and was not
 * computed at any particular odometer reading. Filling it in from the mileage
 * history would tie a price to a number the valuation never saw.
 */
function readMarketValue(section: CarapiSection<unknown>): VinHistoryMarketValue | null {
  const body = bodyOf(section);
  if (!body) return null;

  const price = numberAt(body, 'valuationPrice');
  const priceCents = toCents({ amount: price });
  if (priceCents === null) return null;

  return {
    currency: textAt(body, 'currency') ?? 'EUR',
    retail: {
      excellentCents: null,
      cleanCents: null,
      averageCents: priceCents,
      roughCents: null,
    },
    tradeIn: null,
    msrpCents: null,
    mileageKm: null,
    asOf: null,
  };
}

/**
 * `time-to-sell` → how long this model takes to sell in one market.
 *
 * It is a statistic about a MARKET, not a record about this car, which is why it
 * sits in its own block and contributes nothing to `recordCount`: a buyer who
 * paid for a history and received nothing but "a BMW X6 sells in 28 days in
 * Germany" has not been sold a history.
 *
 * `medianDays` is required — without it the quartiles describe nothing — while
 * both quartiles are nullable, because a thin market may publish a median alone.
 */
function readTimeToSell(
  section: CarapiSection<unknown>,
  requestedCountry: string | null,
): VinHistoryTimeToSell | null {
  const body = bodyOf(section);
  if (!body) return null;

  const medianDays = numberAt(body, 'medianDaysToSell');
  if (medianDays === null) return null;

  const country = countryCode(textAt(body, 'country')) ?? countryCode(requestedCountry);
  if (country === null) return null;

  return {
    countryCode: country,
    medianDays: Math.round(medianDays),
    p25Days: numberAt(body, 'p25Days'),
    p75Days: numberAt(body, 'p75Days'),
  };
}

// ===========================================================================
// The mapper
// ===========================================================================

export function mapCarapiToPayloadV2(
  input: CarapiRawBundle,
  context: CarapiMapperContext,
): VinHistoryPayloadV2 {
  const vehicle = safely<VinHistoryVehicle | null>(null, () => vehicleFromCarapiDecode(input.vinDecode));
  const equipment = safely<VinHistoryEquipment | null>(null, () => buildEquipment(input.vinDecode));
  const mileageRecords = safely<VinHistoryMileageRecord[]>([], () => readMileage(input.mileageHistory));
  const theftCoverage = safely<VinHistoryTheftCoverage | null>(null, () =>
    readTheftCoverage(input.stolenCheck),
  );
  const theft = safely<VinHistoryTheft>(NO_THEFT, () => readTheft(input.stolenCheck));
  const inspectionValidity = safely<VinHistoryInspectionValidity | null>(null, () =>
    readInspectionValidity(input.inspection, input.request.inspectionCountry),
  );
  const marketValue = safely<VinHistoryMarketValue | null>(null, () => readMarketValue(input.valuation));
  const timeToSell = safely<VinHistoryTimeToSell | null>(null, () =>
    readTimeToSell(input.timeToSell, input.request.marketCountry),
  );

  /*
   * CarAPI holds none of these, for any VIN. They are empty arrays with a
   * `not_covered` coverage, which is a statement — "this source does not have
   * it" — and not the blank that would read as "this car has none".
   */
  const owners: VinHistoryOwner[] = [];
  const damageRecords: VinHistoryDamageRecord[] = [];
  const registrations: VinHistoryRegistration[] = [];
  const recalls: VinHistoryRecall[] = [];
  const inspections: VinHistoryInspection[] = [];

  /*
   * The one registration fact in the decode, and it is a DATE and nothing else.
   *
   * `specifications.registrationDate` is carried as the summary's
   * `firstRegistration` because that is what it is — the earliest registration
   * date the source publishes for this vehicle. It deliberately does NOT become
   * a `VinHistoryRegistration`: that type requires a non-null `countryCode`, the
   * decode names no registration country anywhere, and the only country in the
   * response is the country the car was BUILT in. Filling it with 'DE' for a
   * Czech-registered BMW is the single most misleading thing this mapper could
   * do, so the record is not created at all.
   */
  const firstRegistration = safely<string | null>(null, () =>
    dateAt(recordAt(bodyOf(input.vinDecode), 'specifications'), 'registrationDate'),
  );

  const decodeCoverage = coverageFor(input.vinDecode);
  const coverage: VinHistoryCoverageMap = {
    ...emptyCoverageMap(),
    mileage: coverageFor(input.mileageHistory),
    theft: coverageFor(input.stolenCheck),
    /*
     * `covered` only when something actually came back. A decode that answered
     * without a feature list is not a car with no equipment.
     */
    equipment: decodeCoverage === 'unavailable' ? 'unavailable' : equipment ? 'covered' : 'not_covered',
    marketValue:
      input.valuation.status === 'failed' ? 'unavailable' : marketValue ? 'covered' : 'not_covered',
    /*
     * ⚠️ `inspections` STAYS `not_covered` EVEN WHEN THE INSPECTION CALL
     * SUCCEEDED. The section means inspection EVENTS — a test, a date, a result —
     * and CarAPI holds none, ever. Marking it `covered` because two validity
     * dates came back would put an empty events table under a "covered" heading,
     * which reads as "this car has never been inspected" for a car whose
     * certificate is valid to 2028. The outcome of the call is visible in
     * `sources[]`, and its content in `inspectionValidity`.
     *
     * Everything else below is `not_covered` from `emptyCoverageMap()`: owners,
     * damages, registrations, recalls, insurance, brands and service are not
     * datasets this provider has.
     */
    inspections: 'not_covered',
    /*
     * The two sections the second source added. Both follow the same rule as
     * equipment and marketValue: `unavailable` when the call broke, `covered`
     * only when a block was actually built, `not_covered` otherwise.
     *
     * An answer we could not read counts as `not_covered` rather than `covered`
     * and empty, deliberately. "The register was searched and this car has no
     * valid certificate" is a real finding and a serious one — it must come from
     * a body we understood, never from one we failed to parse.
     */
    inspectionValidity:
      input.inspection.status === 'failed'
        ? 'unavailable'
        : inspectionValidity
          ? 'covered'
          : 'not_covered',
    timeToSell:
      input.timeToSell.status === 'failed' ? 'unavailable' : timeToSell ? 'covered' : 'not_covered',
  };

  const sources: VinHistorySource[] = [
    sourceEntry('vinDecode', input.vinDecode),
    sourceEntry('mileageHistory', input.mileageHistory),
    sourceEntry('stolenCheck', input.stolenCheck),
    sourceEntry('inspection', input.inspection),
    sourceEntry('valuation', input.valuation),
    sourceEntry('timeToSell', input.timeToSell),
  ];

  const lastMileage = mileageRecords[mileageRecords.length - 1] ?? null;

  const summary: VinHistorySummaryV2 = {
    /*
     * What the buyer actually received, and the number
     * `MIN_SELLABLE_RECORD_COUNT` reads to decide whether this report is worth
     * what was paid for it.
     *
     * Records only. The valuation, the time-to-sell statistic and the equipment
     * list are all excluded: none of them is a record of anything that happened
     * to this car, and a report whose only content was a market average would
     * pass a sellability check it should fail.
     */
    recordCount: mileageRecords.length + (theft.stolen ? 1 : 0),
    ownersCount: 0,
    /*
     * Empty, and never the theft registers. A register that was searched is not
     * a country the car was seen in — and the build country is not either.
     */
    countriesSeen: [],
    hasAccidentRecords: false,
    hasSalvageOrTotalLoss: false,
    hasOdometerRollback: mileageRecords.some((record) => record.suspicious),
    hasStolenRecord: theft.stolen,
    hasOpenRecalls: false,
    lastRecordedMileageKm: lastMileage ? lastMileage.mileageKm : null,
    firstRegistration,
    hasCommercialUse: false,
    hasTitleBrand: false,
    hasInsuranceTotalLoss: false,
    insuranceRecordCount: 0,
    brandCount: 0,
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
    vehicle,
    owners,
    mileageRecords,
    damageRecords,
    registrations,
    recalls,
    theft,
    inspections,
    insuranceRecords: [],
    brands: [],
    serviceRecords: [],
    equipment,
    marketValue,
    coverage,
    sources,

    /*
     * The four optional v2 fields the second source brought with it. Every one
     * of them exists because forcing this data into an older field would change
     * what that field means: a certificate expiry filed as an inspection EVENT,
     * five searched registers collapsed into one `countryCode`, a second
     * valuation averaged into the first.
     */
    timeToSell,
    inspectionValidity,
    theftCoverage,
    // One source today, an array because two sources disagreeing is information
    // and their average is a number neither of them published.
    marketValues: marketValue ? [marketValue] : [],
  };
}
