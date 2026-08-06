/**
 * The RAW response shape we expect from a real VIN-history provider, plus
 * fixtures covering what that provider will actually send us.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `MockVinHistoryProvider` is a pure function of the VIN that always returns a
 * well-formed, internally consistent, non-empty `VinHistoryPayloadV1`. That is
 * exactly right for a demo and exactly wrong for testing what happens when a
 * real API is wired in: a real provider answers in ITS OWN shape, with mixed
 * date formats, floating-point money, imperial units, unknown enum members,
 * nulls where we expect arrays, and occasionally nothing at all.
 *
 * These fixtures are a deliberate, documented GUESS at that shape — modelled on
 * the public documentation and sample reports of the shortlisted providers
 * (carVertical, autoDNA). Nobody has sent us a real response yet: DEN-64 is
 * still waiting on both, and question 4 of that enquiry asks for exactly the
 * sample body that would replace this file. Until it arrives, this is the most
 * honest thing available — a superset of the hazards every provider in this
 * category exhibits, so the mapper and the service are tested against the messy
 * case rather than the clean one.
 *
 * When the real contract lands: replace the fixtures, keep the hazards. Each is
 * labelled with the failure it would cause if the mapper ignored it.
 */

/** Money as providers actually send it: a decimal amount plus a currency. */
export interface RawAmount {
  amount: number | string | null;
  currency?: string | null;
}

export interface RawOwnershipRecord {
  seq?: number;
  /** Free-form: 'private', 'company', 'leasing', 'Privatperson', unknown values. */
  type?: string | null;
  country?: string | null;
  /** ISO 'YYYY-MM-DD' or German 'DD.MM.YYYY'. Both appear in real feeds. */
  from?: string | null;
  to?: string | null;
}

export interface RawMileageRecord {
  date?: string | null;
  value?: number | string | null;
  /** 'km' or 'mi'. UK-sourced records arrive in miles. */
  unit?: string | null;
  source?: string | null;
  country?: string | null;
}

export interface RawDamageRecord {
  date?: string | null;
  severity?: string | null;
  areas?: string[] | string | null;
  repair_cost?: RawAmount | null;
  salvage?: boolean | null;
  airbag?: boolean | null;
  description?: string | null;
  source?: string | null;
}

export interface RawRegistrationRecord {
  country?: string | null;
  region?: string | null;
  first_registration?: string | null;
  last_registration?: string | null;
  /** UNMASKED in the raw feed — masking is the mapper's job. */
  plate?: string | null;
  status?: string | null;
}

export interface RawRecallRecord {
  reference?: string | null;
  issued_at?: string | null;
  authority?: string | null;
  title?: string | null;
  description?: string | null;
  /** Providers disagree: boolean, 'open'/'closed', or a remedy date. */
  status?: boolean | string | null;
}

export interface RawTheftRecord {
  stolen?: boolean | null;
  reported_at?: string | null;
  country?: string | null;
  recovered_at?: string | null;
  source?: string | null;
}

export interface RawInspectionRecord {
  date?: string | null;
  country?: string | null;
  authority?: string | null;
  result?: string | null;
  mileage?: number | null;
  mileage_unit?: string | null;
  defects?: string[] | null;
  next_due?: string | null;
}

export interface RawProviderResponse {
  status?: string;
  /** Providers echo the VIN back — sometimes lowercase, sometimes padded. */
  vin?: string | null;
  generated_at?: string | null;
  vehicle?: {
    make?: string | null;
    model?: string | null;
    first_registration?: string | null;
  } | null;
  records?: {
    ownership?: RawOwnershipRecord[] | null;
    mileage?: RawMileageRecord[] | null;
    damages?: RawDamageRecord[] | null;
    registrations?: RawRegistrationRecord[] | null;
    recalls?: RawRecallRecord[] | null;
    theft?: RawTheftRecord | null;
    inspections?: RawInspectionRecord[] | null;
  } | null;
  /** Forward compatibility: a provider adding fields must not break us. */
  [extra: string]: unknown;
}

// ============================================================
// Fixtures
// ============================================================

/**
 * The happy path: a well-documented German car with a full history.
 *
 * Hazards embedded on purpose:
 *  - `repair_cost.amount` is a FLOAT in euros → must become integer cents, or
 *    the platform's money rule is violated the moment a real provider is wired.
 *  - one ownership record uses the German 'DD.MM.YYYY' date format.
 *  - `plate` is unmasked → leaking it would publish personal data.
 *  - mileage readings are NOT sorted by date, and one is lower than an earlier
 *    reading → rollback detection must sort first or it will miss it.
 */
export const RAW_RICH_DE: RawProviderResponse = {
  status: 'ok',
  vin: 'WVWZZZ1KZAW123407',
  generated_at: '2026-08-06T09:00:00Z',
  vehicle: { make: 'Volkswagen', model: 'Golf VI 1.6 TDI', first_registration: '2010-05-14' },
  records: {
    ownership: [
      { seq: 1, type: 'private', country: 'DE', from: '2010-05-14', to: '2015-03-01' },
      // German date format, mid-feed.
      { seq: 2, type: 'Firmenwagen', country: 'DE', from: '01.03.2015', to: '19.11.2019' },
      { seq: 3, type: 'private', country: 'AT', from: '2019-11-20', to: null },
    ],
    mileage: [
      { date: '2011-06-01', value: 18420, unit: 'km', source: 'inspection', country: 'DE' },
      // Out of order AND lower than the 2013 reading below — the rollback.
      { date: '2015-02-11', value: 96500, unit: 'km', source: 'registration', country: 'DE' },
      { date: '2013-07-22', value: 121300, unit: 'km', source: 'service', country: 'DE' },
      { date: '2019-11-20', value: 184900, unit: 'km', source: 'registration', country: 'AT' },
      { date: '2024-04-02', value: 231770, unit: 'km', source: 'inspection', country: 'AT' },
    ],
    damages: [
      {
        date: '2018-03-04',
        severity: 'severe',
        areas: ['front', 'left'],
        // Float euros with cents that do NOT divide evenly — rounding must be
        // explicit, not accidental.
        repair_cost: { amount: 4317.37, currency: 'EUR' },
        salvage: false,
        airbag: true,
        description: 'Front-left collision, airbags deployed',
        source: 'insurance_claim',
      },
      {
        date: '2022-09-15',
        severity: 'minor',
        areas: 'rear',
        repair_cost: { amount: 612.5, currency: 'EUR' },
        salvage: false,
        airbag: false,
        description: 'Rear bumper scuff',
        source: 'workshop',
      },
    ],
    registrations: [
      {
        country: 'DE',
        region: 'Bayern',
        first_registration: '2010-05-14',
        last_registration: '2019-11-19',
        plate: 'M-XY 4823',
        status: 'exported',
      },
      {
        country: 'AT',
        region: 'Wien',
        first_registration: '2019-11-20',
        last_registration: null,
        plate: 'W-88213T',
        status: 'active',
      },
    ],
    recalls: [
      {
        reference: 'RC-2016-4471',
        issued_at: '2016-02-18',
        authority: 'KBA',
        title: 'EA189 emissions software update',
        description: null,
        status: 'closed',
      },
      {
        reference: 'RC-2021-0912',
        issued_at: '2021-06-03',
        authority: 'KBA',
        title: 'Brake booster inspection',
        description: null,
        status: 'open',
      },
    ],
    theft: {
      stolen: false,
      reported_at: null,
      country: null,
      recovered_at: null,
      source: null,
    },
    inspections: [
      {
        date: '2013-05-20',
        country: 'DE',
        authority: 'TÜV',
        result: 'pass',
        mileage: 118000,
        mileage_unit: 'km',
        defects: [],
        next_due: '2015-05-20',
      },
      {
        date: '2021-10-08',
        country: 'AT',
        authority: 'ÖAMTC',
        result: 'pass_with_defects',
        mileage: 201400,
        mileage_unit: 'km',
        defects: ['brake wear', 'headlight adjustment'],
        next_due: '2023-10-08',
      },
      {
        date: '2024-04-02',
        country: 'AT',
        authority: 'ÖAMTC',
        result: 'fail',
        mileage: 231770,
        mileage_unit: 'km',
        defects: ['corrosion — subframe'],
        next_due: '2024-10-02',
      },
    ],
  },
  // A field we have never seen before. Adding one must not break the mapper.
  provider_internal_score: { risk: 0.42, band: 'medium' },
};

/**
 * A UK import.
 *
 * Hazard: mileage and MOT readings arrive in MILES. Treating 92,000 miles as
 * kilometres understates the car by ~56,000 km — the single most consequential
 * unit bug this feature can have, since mileage is what the buyer is paying to
 * check.
 */
export const RAW_UK_IMPORT: RawProviderResponse = {
  status: 'ok',
  // Lowercase echo — real feeds are inconsistent about this.
  vin: 'sajaa51d8ymc12345',
  generated_at: '2026-08-06T09:00:00Z',
  vehicle: { make: 'Jaguar', model: 'S-Type', first_registration: '2000-08-11' },
  records: {
    ownership: [
      { seq: 1, type: 'private', country: 'GB', from: '2000-08-11', to: '2012-01-30' },
      { seq: 2, type: 'private', country: 'DE', from: '2012-02-14', to: null },
    ],
    mileage: [
      { date: '2010-06-01', value: 74210, unit: 'mi', source: 'mot', country: 'GB' },
      { date: '2011-06-04', value: 81950, unit: 'mi', source: 'mot', country: 'GB' },
      { date: '2013-09-19', value: 139400, unit: 'km', source: 'inspection', country: 'DE' },
    ],
    damages: null,
    registrations: [
      {
        country: 'GB',
        region: null,
        first_registration: '2000-08-11',
        last_registration: '2012-01-30',
        plate: 'YB51 KJC',
        status: 'exported',
      },
      {
        country: 'DE',
        region: 'Hessen',
        first_registration: '2012-02-14',
        last_registration: null,
        plate: 'F-AB 1234',
        status: 'active',
      },
    ],
    recalls: [],
    theft: null,
    inspections: [
      {
        date: '2011-06-04',
        country: 'GB',
        authority: 'MOT',
        result: 'pass',
        mileage: 81950,
        mileage_unit: 'mi',
        defects: [],
        next_due: '2012-06-04',
      },
    ],
  },
};

/**
 * Exactly one record — the boundary of MIN_SELLABLE_RECORD_COUNT.
 *
 * This must SELL. The threshold refuses only the genuinely empty answer, and a
 * single registration is a real, if thin, finding: "this car exists and is
 * registered in Poland" is not nothing.
 */
export const RAW_MINIMAL: RawProviderResponse = {
  status: 'ok',
  vin: 'TMBJJ7NE5G0123456',
  generated_at: '2026-08-06T09:00:00Z',
  vehicle: { make: 'Škoda', model: 'Octavia', first_registration: '2016-03-02' },
  records: {
    ownership: [],
    mileage: [],
    damages: [],
    registrations: [
      {
        country: 'PL',
        region: null,
        first_registration: '2016-03-02',
        last_registration: null,
        plate: 'WA 12345',
        status: 'active',
      },
    ],
    recalls: [],
    theft: { stolen: false, reported_at: null, country: null, recovered_at: null, source: null },
    inspections: [],
  },
};

/**
 * A successful HTTP call that holds nothing.
 *
 * This is NOT an error the client can catch — status is 'ok', the body parses,
 * every array is simply empty. It is the single most common complaint in
 * consumer reviews of every provider on the shortlist, and the reason
 * MIN_SELLABLE_RECORD_COUNT exists.
 */
export const RAW_EMPTY: RawProviderResponse = {
  status: 'ok',
  vin: 'WBA8E9G50HNU12345',
  generated_at: '2026-08-06T09:00:00Z',
  vehicle: { make: null, model: null, first_registration: null },
  records: {
    ownership: [],
    mileage: [],
    damages: [],
    registrations: [],
    recalls: [],
    theft: null,
    inspections: [],
  },
};

/**
 * Everything a real feed does wrong, in one body.
 *
 * Hazards, each of which would produce a different defect if unhandled:
 *  - `records.ownership` is null rather than an empty array → `.map` on null.
 *  - an unknown severity ('catastrophic') and owner type ('Erbengemeinschaft')
 *    → must degrade to 'unknown', never be dropped and never crash.
 *  - `value` as a numeric STRING → arithmetic on a string silently concatenates.
 *  - `repair_cost.amount` as a string with a comma decimal separator (German).
 *  - a duplicated damage record → must not be silently de-duplicated (two
 *    claims on the same day are a real thing) but must not be double-counted in
 *    the booleans either.
 *  - a null date on a damage → the record is still a finding.
 *  - recall `status` as a boolean rather than a string.
 *  - `theft.stolen` true with no other detail.
 */
export const RAW_DIRTY: RawProviderResponse = {
  status: 'ok',
  vin: 'YV1RS58D542345678',
  generated_at: '2026-08-06T09:00:00Z',
  vehicle: { make: 'Volvo', model: 'S60', first_registration: null },
  records: {
    ownership: null,
    mileage: [
      { date: '2014-01-01', value: '88000', unit: 'km', source: 'auction', country: 'SE' },
      { date: '2016-05-05', value: null, unit: 'km', source: null, country: 'SE' },
    ],
    damages: [
      {
        date: null,
        severity: 'catastrophic',
        areas: ['front', 'roof'],
        repair_cost: { amount: '12.480,90', currency: 'EUR' },
        salvage: true,
        airbag: null,
        description: 'Total loss declared by insurer',
        source: 'insurance_claim',
      },
      {
        date: null,
        severity: 'catastrophic',
        areas: ['front', 'roof'],
        repair_cost: { amount: '12.480,90', currency: 'EUR' },
        salvage: true,
        airbag: null,
        description: 'Total loss declared by insurer',
        source: 'insurance_claim',
      },
    ],
    registrations: [
      {
        country: 'SE',
        region: null,
        first_registration: null,
        last_registration: null,
        plate: null,
        status: 'scrapped',
      },
    ],
    recalls: [
      {
        reference: 'RC-UNKNOWN',
        issued_at: null,
        authority: null,
        title: 'Unspecified safety action',
        description: null,
        status: true,
      },
    ],
    theft: { stolen: true, reported_at: null, country: null, recovered_at: null, source: null },
    inspections: [],
  },
};
