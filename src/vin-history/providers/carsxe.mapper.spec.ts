// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no network, no Nest container.
/**
 * The CarsXE mapper.
 *
 * ⚠️ EVERY FIXTURE IN THIS FILE IS HAND-AUTHORED FROM THE DOCUMENTED SCHEMA AND
 * IS THEREFORE UNVERIFIED. No live CarsXE call was made to produce any of them:
 * the account is on a Sandbox tier with ONE lifetime `/history` call, and it is
 * deliberately unspent. Key names, capitalisation and nesting are our best
 * reading of the published field list and of the description of a real response.
 *
 * That is exactly why several tests here are about SURVIVING the fixtures being
 * wrong — renamed keys, missing sections, scalars where objects were expected.
 * When a real body is finally captured, replace the fixtures and keep every
 * assertion: each one pins a decision, not a shape.
 */

import { VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { CarsxeRawBundle, CarsxeSection } from './carsxe.client';
import { mapCarsxeToPayloadV2, vehicleFromCarsxeSpecs } from './carsxe.mapper';

const VIN = 'WBAFR7C57CC811956';
const GENERATED_AT = '2026-08-12T09:00:00.000Z';

// ===========================================================================
// Fixtures
// ===========================================================================

/**
 * The provider's WHOLE brand-code dictionary, returned byte-identical for every
 * VIN — a pristine 2023 lease return and a crushed flood car get the same array.
 *
 * Shortened to fifty-odd of the real ~80 entries, and shaped the way a legend is
 * shaped: a code, a name, a definition, and NOTHING about any particular
 * vehicle. No date, no state, no applied flag.
 */
function brandDictionary(): Record<string, unknown>[] {
  const names = [
    'Clear: no brand exists',
    'Flood damage',
    'Fire damage',
    'Hail damage',
    'Salvage',
    'Junk',
    'Crushed',
    'Dismantled',
    'Scrapped',
    'Parts only',
    'Non-repairable',
    'Rebuilt',
    'Reconstructed',
    'Prior taxi',
    'Prior police',
    'Prior rental',
    'Prior lease',
    'Prior driver education',
    'Prior bus',
    'Prior ambulance',
    'Manufacturer buyback',
    'Lemon law buyback',
    'Warranty return',
    'Odometer tampering',
    'Odometer discrepancy',
    'Not actual mileage',
    'Exceeds mechanical limits',
    'Theft recovery',
    'Stolen',
    'Export only',
    'Imported vehicle',
    'Grey market',
    'Antique',
    'Classic',
    'Street rod',
    'Kit car',
    'Replica',
    'Refurbished',
    'Damaged',
    'Collision damage',
    'Vandalism',
    'Water damage',
    'Saltwater flood',
    'Owner retained',
    'Insurance loss',
    'Total loss',
    'Constructive total loss',
    'Undisclosed lien',
    'Agricultural use',
    'Municipal use',
    'Government use',
    'Test vehicle',
    'Show vehicle',
    'Dealer demo',
    'Bonded title',
    'Certificate of destruction',
    'Repaired and inspected',
    'Emissions exempt',
  ];
  return names.map((brand, index) => ({
    brandCode: String(index + 1).padStart(2, '0'),
    brand,
    definition: `${brand} — as defined by the reporting jurisdiction.`,
  }));
}

/** A rich, ordinary US car: four titles across two states, one recall, no brands. */
function fullUsHistory(): Record<string, unknown> {
  return {
    success: true,
    input: { vin: VIN },
    vinChanged: false,
    brandsInformation: brandDictionary(),
    currentTitleInformation: {
      state: 'CA',
      titleNumber: 'CA9911223344',
      titleIssueDate: '08/14/2021',
      odometer: '96500',
      odometerUnitOfMeasure: 'MI',
      licensePlate: '7ABC123',
      historicTitles: [
        {
          state: 'CA',
          titleIssueDate: '03/02/2018',
          odometer: 61000,
          odometerUnitOfMeasure: 'MI',
        },
        {
          state: 'NV',
          titleIssueDate: '11/20/2014',
          odometer: 24800,
          odometerUnitOfMeasure: 'MI',
        },
      ],
    },
    historyInformation: [
      {
        state: 'NV',
        titleIssueDate: '05/06/2012',
        odometer: 900,
        odometerUnitOfMeasure: 'MI',
      },
    ],
    junkAndSalvageInformation: [],
    insuranceInformation: [],
    events: [],
  };
}

/** The same car after a flood: a salvage yard, an insurer, and two real brands. */
function salvageHistory(): Record<string, unknown> {
  return {
    success: true,
    brandsInformation: brandDictionary(),
    currentTitleInformation: {
      state: 'TX',
      titleIssueDate: '02/11/2020',
      odometer: 88000,
      odometerUnitOfMeasure: 'MI',
      // ⚠️ The evidence: brands written ON the title, not in the legend.
      brands: ['Flood damage', 'Salvage'],
      historicTitles: [
        { state: 'LA', titleIssueDate: '06/01/2017', odometer: 41000, odometerUnitOfMeasure: 'MI' },
      ],
    },
    junkAndSalvageInformation: [
      {
        reportingEntityName: 'Gulf Coast Auto Salvage LLC',
        reportingEntityContact: '555-0100, 44 Industrial Way, Houston TX',
        obtainedDate: '09/22/2019',
        disposition: 'CRUSH',
        vehicleIntendedForExport: false,
        odometer: 87200,
        odometerUnitOfMeasure: 'MI',
      },
    ],
    insuranceInformation: [
      {
        reportingEntityName: 'Lone Star Mutual Insurance',
        insurancePolicyNumber: 'POL-99182',
        obtainedDate: '09/03/2019',
        disposition: 'TOTAL LOSS',
        odometer: 87000,
        odometerUnitOfMeasure: 'MI',
      },
    ],
    historyInformation: [],
    events: [],
  };
}

function specsResponse(): Record<string, unknown> {
  return {
    success: true,
    attributes: {
      year: '2012',
      make: 'BMW',
      model: '328i',
      style: 'SEDAN 4-DR',
      fuel_type: 'Gasoline',
      made_in: 'GERMANY',
      manufacturer_suggested_retail_price: '$36,750',
      invoice_price: '33900.50',
    },
    equipment: {
      'Air Conditioning': 'Standard',
      'Leather Seats': 'Standard',
      'Sunroof / Moonroof': 'N/A',
    },
    colors: [
      { category: 'Exterior', options: [{ name: 'Alpine White' }, { name: 'Jet Black' }] },
      { category: 'Interior', options: [{ name: 'Beige Dakota Leather' }] },
    ],
    warranties: [
      { type: 'Basic', months: 48, miles: 50000 },
      { type: 'Corrosion', months: 144, miles: 'Unlimited' },
    ],
  };
}

function marketValueResponse(): Record<string, unknown> {
  return {
    success: true,
    market_value: {
      currency: 'USD',
      mileage: 96500,
      mileage_unit: 'MI',
      as_of: '2026-07-31',
      retail: { excellent: 12400, clean: '11,250', average: 9800.5, rough: 7100 },
      trade_in: { clean: 8600, average: 7350, rough: 5100 },
      msrp: 36750,
    },
  };
}

function recallsResponse(): Record<string, unknown> {
  return {
    success: true,
    recalls: [
      {
        campaignNumber: '17V682000',
        component: 'AIR BAGS:FRONTAL:DRIVER SIDE INFLATOR MODULE',
        reportReceivedDate: '10/24/2017',
        consequence: 'An inflator explosion may result in sharp metal fragments.',
        remedy: 'Dealers will replace the driver frontal air bag inflator, free of charge.',
      },
      {
        campaignNumber: '13V115000',
        component: 'ENGINE AND ENGINE COOLING',
        reportReceivedDate: '04/01/2013',
        remedyDate: '08/09/2013',
      },
    ],
  };
}

function ok<T>(body: T): CarsxeSection<T> {
  return { status: 'ok', body };
}

function bundle(overrides: Partial<CarsxeRawBundle> = {}): CarsxeRawBundle {
  return {
    history: ok(fullUsHistory()),
    specs: ok(specsResponse()),
    marketValue: ok(marketValueResponse()),
    recalls: ok(recallsResponse()),
    lienTheft: ok({ success: true, events: [] }),
    ...overrides,
  };
}

function map(input: CarsxeRawBundle): VinHistoryPayloadV2 {
  return mapCarsxeToPayloadV2(input, {
    vin: VIN,
    provider: 'carsxe',
    generatedAt: GENERATED_AT,
    vehicle: vehicleFromCarsxeSpecs(input.specs),
  });
}

// ===========================================================================
// Invariants asserted on every payload this file produces
// ===========================================================================

const DATE_FIELDS = new Set([
  'date',
  'fromDate',
  'toDate',
  'firstRegistration',
  'lastRegistration',
  'issuedAt',
  'reportedAt',
  'recoveredAt',
  'nextDueDate',
  'asOf',
]);

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visit));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

/**
 * The properties every payload must hold whatever the input was.
 *
 * Called from every test rather than sitting in one of its own, because these
 * are invariants: the point is that no fixture, however broken, can produce a
 * payload that violates them.
 */
function assertInvariants(payload: VinHistoryPayloadV2): void {
  expect(payload.schemaVersion).toBe(2);
  // Never conditional, never omitted: this data is sourced, not generated.
  expect(payload.synthetic).toBe(false);
  expect(payload.provider).toBe('carsxe');
  expect(payload.vin).toBe(VIN);
  expect(payload.generatedAt).toBe(GENERATED_AT);

  // Summary counts ARE array lengths. If these can drift, the free preview and
  // the paid report can disagree about how much is in the report.
  expect(payload.summary.ownersCount).toBe(payload.owners.length);
  expect(payload.summary.insuranceRecordCount).toBe(payload.insuranceRecords.length);
  expect(payload.summary.brandCount).toBe(payload.brands.length);
  expect(payload.summary.serviceRecordCount).toBe(payload.serviceRecords.length);
  expect(payload.summary.recordCount).toBe(
    payload.owners.length +
      payload.mileageRecords.length +
      payload.damageRecords.length +
      payload.registrations.length +
      payload.recalls.length +
      payload.inspections.length +
      payload.insuranceRecords.length +
      payload.brands.length +
      (payload.theft.stolen ? 1 : 0),
  );

  // Every boolean derivable from the arrays beside it.
  expect(payload.summary.hasAccidentRecords).toBe(payload.damageRecords.length > 0);
  expect(payload.summary.hasOdometerRollback).toBe(
    payload.mileageRecords.some((m) => m.suspicious),
  );
  expect(payload.summary.hasStolenRecord).toBe(payload.theft.stolen);
  expect(payload.summary.hasOpenRecalls).toBe(payload.recalls.some((r) => r.open));
  expect(payload.summary.hasTitleBrand).toBe(payload.brands.length > 0);
  expect(payload.summary.hasCommercialUse).toBe(
    payload.brands.some((b) => b.category === 'commercial'),
  );
  expect(payload.summary.hasInsuranceTotalLoss).toBe(
    payload.insuranceRecords.some((i) => i.totalLoss),
  );

  walk(payload, (key, value) => {
    // Money is integer cents. No floats reach the database, ever.
    if (key.endsWith('Cents') && value !== null) {
      expect(Number.isInteger(value)).toBe(true);
    }
    // Dates are plain ISO calendar days, or null. Never a timestamp, never a
    // provider's own '08/14/2021'.
    if (DATE_FIELDS.has(key) && value !== null) {
      expect(typeof value).toBe('string');
      expect(value as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    if (key === 'mileageKm' && value !== null) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
}

// ===========================================================================
// ⚠️ The brand dictionary — the single most important test in this file
// ===========================================================================

describe('CarsXE mapper — the brand dictionary is a legend, not a finding', () => {
  it('reports NO brands when the response carries only the dictionary', () => {
    /*
     * THE ONE THAT MATTERS.
     *
     * `brandsInformation` comes back identical for every VIN — fifty-plus lines
     * here, about eighty in production, Flood damage through Crushed and Prior
     * Taxi. Map it straight through and every single car we sell a report on is
     * flood-damaged, burned, stolen and crushed at the same time, on a PDF
     * somebody paid 19.99 EUR for.
     */
    const payload = map(bundle());

    expect(payload.brands).toEqual([]);
    expect(payload.summary.brandCount).toBe(0);
    expect(payload.summary.hasTitleBrand).toBe(false);
    expect(payload.summary.hasCommercialUse).toBe(false);
    expect(payload.summary.hasSalvageOrTotalLoss).toBe(false);
    assertInvariants(payload);
  });

  it('emits only the brands a title record actually carries', () => {
    const payload = map(bundle({ history: ok(salvageHistory()) }));

    expect(payload.brands.map((b) => b.label).sort()).toEqual(['Flood damage', 'Salvage']);
    expect(payload.brands.map((b) => b.category).sort()).toEqual(['flood', 'salvage']);
    // The evidence came off the title, so the brand carries that title's date
    // and issuing state — never a person.
    expect(payload.brands[0].reportedAt).toBe('2020-02-11');
    expect(payload.brands[0].authority).toBe('TX');
    expect(payload.brands.every((b) => b.countryCode === 'US')).toBe(true);
    assertInvariants(payload);
  });

  it('never emits the "Clear: no brand exists" line, even when it looks applied', () => {
    // A "no brand" entry is the ABSENCE of a brand. Printing it as one would
    // both read as a finding and set `hasTitleBrand`.
    const history = {
      ...fullUsHistory(),
      brandsInformation: [
        { brandCode: '01', brand: 'Clear: no brand exists', brandDate: '01/02/2020', brandState: 'CA' },
      ],
    };
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.brands).toEqual([]);
    expect(payload.summary.hasTitleBrand).toBe(false);
    assertInvariants(payload);
  });

  it('discards inline evidence wholesale when the whole dictionary claims to be applied', () => {
    /*
     * The backstop, for the day the real dictionary turns out to carry some
     * constant field this mapper reads as evidence. Rule 1 would pass all
     * fifty-odd entries; the shape rule catches it, because a car with fifty
     * title brands does not exist.
     */
    const history = {
      ...fullUsHistory(),
      brandsInformation: brandDictionary().map((entry) => ({
        ...entry,
        // A field that looks per-vehicle and is in fact constant.
        brandState: 'US',
      })),
    };
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.brands).toEqual([]);
    assertInvariants(payload);
  });

  it('still trusts inline evidence at a plausible scale', () => {
    const history = {
      ...fullUsHistory(),
      brandsInformation: [
        { brandCode: '02', brand: 'Flood damage', brandDate: '05/06/2019', brandState: 'LA' },
        { brandCode: '14', brand: 'Prior taxi', brandDate: '01/09/2016', brandState: 'NV' },
      ],
    };
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.brands.map((b) => b.label)).toEqual(['Flood damage', 'Prior taxi']);
    expect(payload.summary.hasCommercialUse).toBe(true);
    expect(payload.brands[0].reportedAt).toBe('2019-05-06');
    assertInvariants(payload);
  });
});

// ===========================================================================
// A full US response
// ===========================================================================

describe('CarsXE mapper — a full US response', () => {
  it('builds a complete, internally consistent payload', () => {
    const payload = map(bundle());
    assertInvariants(payload);

    expect(payload.registrations).toHaveLength(4);
    expect(payload.owners).toHaveLength(4);
    expect(payload.mileageRecords).toHaveLength(4);
    expect(payload.summary.countriesSeen).toEqual(['US']);
    expect(payload.summary.firstRegistration).toBe('2012-05-06');
  });

  it('converts US miles to kilometres', () => {
    // 96 500 mi is 155 300 km. Reading a US odometer as kilometres understates
    // the car by 38 % on the number a buyer looks at hardest.
    const payload = map(bundle());
    expect(payload.summary.lastRecordedMileageKm).toBe(155_302);
    expect(payload.mileageRecords[0].mileageKm).toBe(1448);
  });

  it('reads the provider s US date format month first', () => {
    // '08/14/2021' is 14 August. Read day-first it becomes an impossible date;
    // '03/02/2018' read day-first silently moves a title by eleven months.
    const payload = map(bundle());
    expect(payload.registrations.map((r) => r.firstRegistration)).toEqual([
      '2021-08-14',
      '2018-03-02',
      '2014-11-20',
      '2012-05-06',
    ]);
  });

  it('masks the plate', () => {
    const payload = map(bundle());
    const plates = payload.registrations.map((r) => r.plateMasked).filter(Boolean);
    expect(plates).toEqual(['7A****23']);
    expect(JSON.stringify(payload)).not.toContain('7ABC123');
  });

  it('marks the current title active and superseded ones unknown, never deregistered', () => {
    // 'deregistered' would tell the buyer the car was taken off the road. A
    // prior title only means it was re-titled — usually a move or a sale.
    const payload = map(bundle());
    expect(payload.registrations.map((r) => r.status)).toEqual([
      'active',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('derives owners with no name, no address and no assumed type', () => {
    /*
     * CarsXE sells owner identity as a separate product which we deliberately
     * do not buy. What survives is the SHAPE of the ownership: how many
     * transfers, when, for how long.
     */
    const payload = map(bundle());

    expect(payload.owners.map((o) => o.sequence)).toEqual([1, 2, 3, 4]);
    expect(payload.owners.every((o) => o.type === 'unknown')).toBe(true);
    expect(payload.owners.every((o) => o.countryCode === 'US')).toBe(true);
    expect(payload.owners[0].fromDate).toBe('2012-05-06');
    expect(payload.owners[0].toDate).toBe('2014-11-20');
    expect(payload.owners[0].durationMonths).toBe(30);
    // The last keeper has no end date — they still hold the car.
    expect(payload.owners[3].toDate).toBeNull();

    for (const owner of payload.owners) {
      expect(Object.keys(owner).sort()).toEqual([
        'countryCode',
        'durationMonths',
        'fromDate',
        'sequence',
        'toDate',
        'type',
      ]);
    }
  });

  it('maps recalls, defaulting an unstated one to open and a remedied one to closed', () => {
    const payload = map(bundle());

    expect(payload.recalls).toHaveLength(2);
    expect(payload.recalls[0].reference).toBe('17V682000');
    expect(payload.recalls[0].authority).toBe('NHTSA');
    expect(payload.recalls[0].issuedAt).toBe('2017-10-24');
    // Open by default: a recall is a call to action for the buyer, and staying
    // silent about a live airbag defect costs more than a wasted phone call.
    expect(payload.recalls[0].open).toBe(true);
    // An explicit remedy date closes it.
    expect(payload.recalls[1].open).toBe(false);
    expect(payload.summary.hasOpenRecalls).toBe(true);
  });

  it('maps equipment and the market valuation as integer cents', () => {
    const payload = map(bundle());

    expect(payload.equipment).not.toBeNull();
    // 'N/A' is not equipment the car has.
    expect(payload.equipment!.standard).toEqual(['Air Conditioning', 'Leather Seats']);
    expect(payload.equipment!.exteriorColors).toEqual(['Alpine White', 'Jet Black']);
    expect(payload.equipment!.interiorColors).toEqual(['Beige Dakota Leather']);
    expect(payload.equipment!.msrpCents).toBe(3_675_000);
    expect(payload.equipment!.invoiceCents).toBe(3_390_050);
    expect(payload.equipment!.warranties[0]).toEqual({
      type: 'Basic',
      months: 48,
      distanceKm: 80_467,
    });
    // 'Unlimited' is not a distance.
    expect(payload.equipment!.warranties[1].distanceKm).toBeNull();

    expect(payload.marketValue).not.toBeNull();
    expect(payload.marketValue!.currency).toBe('USD');
    expect(payload.marketValue!.retail).toEqual({
      excellentCents: 1_240_000,
      cleanCents: 1_125_000,
      averageCents: 980_050,
      roughCents: 710_000,
    });
    expect(payload.marketValue!.tradeIn!.excellentCents).toBeNull();
    expect(payload.marketValue!.mileageKm).toBe(155_302);
    expect(payload.marketValue!.asOf).toBe('2026-07-31');
  });

  it('names the vehicle from the specs it already paid for', () => {
    const payload = map(bundle());
    expect(payload.vehicle).toEqual({
      make: 'BMW',
      model: '328i',
      modelYear: 2012,
      bodyClass: 'SEDAN 4-DR',
      fuelType: 'Gasoline',
      plantCountry: 'GERMANY',
      source: 'carsxe-specs',
    });
  });

  it('never carries service records and always says the source has none', () => {
    // A buyer who asked for service history deserves "this source does not have
    // it" rather than a blank that reads as "this car was never serviced".
    const payload = map(bundle());
    expect(payload.serviceRecords).toEqual([]);
    expect(payload.coverage.service).toBe('not_covered');
    expect(payload.coverage.inspections).toBe('not_covered');
    expect(payload.inspections).toEqual([]);
  });

  it('names every source it consulted', () => {
    const payload = map(bundle());
    expect(payload.sources).toEqual([
      { id: 'carsxe.history', status: 'ok', dataset: 'NMVTIS' },
      { id: 'carsxe.specs', status: 'ok', dataset: 'CarsXE Vehicle Specifications' },
      { id: 'carsxe.marketvalue', status: 'ok', dataset: 'CarsXE Market Value' },
      { id: 'carsxe.recalls', status: 'ok', dataset: 'NHTSA' },
      { id: 'carsxe.lienTheft', status: 'ok', dataset: 'CarsXE Lien & Theft' },
    ]);
  });
});

// ===========================================================================
// Salvage and total loss
// ===========================================================================

describe('CarsXE mapper — salvage and total loss', () => {
  it('maps a junk/salvage entry to a damage record and an insurance entry to its own', () => {
    /*
     * ⚠️ NOT BOTH TO `damageRecords`. One crash is routinely reported twice —
     * once by the salvage yard, once by the insurer — and "2 damage records"
     * for one event misleads a buyer about how much is actually known.
     */
    const payload = map(bundle({ history: ok(salvageHistory()) }));
    assertInvariants(payload);

    expect(payload.damageRecords).toHaveLength(1);
    expect(payload.insuranceRecords).toHaveLength(1);

    expect(payload.damageRecords[0].salvage).toBe(true);
    expect(payload.damageRecords[0].severity).toBe('total_loss'); // 'CRUSH'
    expect(payload.damageRecords[0].date).toBe('2019-09-22');
    expect(payload.damageRecords[0].source).toBe('Gulf Coast Auto Salvage LLC');

    expect(payload.insuranceRecords[0].insurer).toBe('Lone Star Mutual Insurance');
    expect(payload.insuranceRecords[0].totalLoss).toBe(true);
    expect(payload.insuranceRecords[0].reason).toBe('TOTAL LOSS');

    expect(payload.summary.hasSalvageOrTotalLoss).toBe(true);
    expect(payload.summary.hasInsuranceTotalLoss).toBe(true);
    expect(payload.summary.hasAccidentRecords).toBe(true);
  });

  it('leaves severity unknown when the provider only says the car was salvaged', () => {
    // NMVTIS records that a vehicle entered a salvage database. It does not
    // describe the damage, and inventing 'severe' would be us making it up.
    const history = salvageHistory();
    (history.junkAndSalvageInformation as Record<string, unknown>[])[0].disposition = 'SOLD';
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.damageRecords[0].severity).toBe('unknown');
    expect(payload.damageRecords[0].salvage).toBe(true);
    // Still a salvage finding — `salvage` carries it, not the severity.
    expect(payload.summary.hasSalvageOrTotalLoss).toBe(true);
  });

  it('never emits the reporting entity s contact details or a policy number', () => {
    const payload = map(bundle({ history: ok(salvageHistory()) }));
    const json = JSON.stringify(payload);

    expect(json).not.toContain('44 Industrial Way');
    expect(json).not.toContain('555-0100');
    expect(json).not.toContain('POL-99182');
    // The reporting business itself is kept — it is an authority, not a person.
    expect(json).toContain('Gulf Coast Auto Salvage LLC');
  });

  it('does not claim a total loss the provider never stated', () => {
    // Most NMVTIS insurance entries are total-loss reports, and defaulting to
    // true on that reasoning would be a claim about someone's car derived from
    // a statistic. The provider's wording is carried instead.
    const history = salvageHistory();
    (history.insuranceInformation as Record<string, unknown>[])[0].disposition = 'CLAIM SETTLED';
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.insuranceRecords[0].totalLoss).toBe(false);
    expect(payload.insuranceRecords[0].reason).toBe('CLAIM SETTLED');
    expect(payload.summary.hasInsuranceTotalLoss).toBe(false);
  });
});

// ===========================================================================
// Odometer rollback
// ===========================================================================

describe('CarsXE mapper — odometer rollback', () => {
  it('flags a reading lower than an earlier one, after sorting', () => {
    /*
     * The provider gives readings and never a verdict. `suspicious` is ours,
     * and it has to be computed after the sort: this fixture arrives with the
     * rolled-back title FIRST, which is how a feed hides a rollback from a
     * mapper that trusts the order it was sent in.
     */
    const history = {
      success: true,
      brandsInformation: brandDictionary(),
      currentTitleInformation: {
        state: 'FL',
        titleIssueDate: '01/15/2023',
        odometer: 130000,
        odometerUnitOfMeasure: 'MI',
        historicTitles: [
          // Out of order on purpose, and 62 000 comes AFTER 118 000 in time.
          { state: 'GA', titleIssueDate: '04/02/2021', odometer: 62000, odometerUnitOfMeasure: 'MI' },
          { state: 'GA', titleIssueDate: '07/19/2019', odometer: 118000, odometerUnitOfMeasure: 'MI' },
        ],
      },
      historyInformation: [],
      junkAndSalvageInformation: [],
      insuranceInformation: [],
    };
    const payload = map(bundle({ history: ok(history) }));
    assertInvariants(payload);

    expect(payload.mileageRecords.map((m) => m.date)).toEqual([
      '2019-07-19',
      '2021-04-02',
      '2023-01-15',
    ]);
    expect(payload.mileageRecords.map((m) => m.suspicious)).toEqual([false, true, false]);
    expect(payload.summary.hasOdometerRollback).toBe(true);
  });

  it('drops an undated reading rather than guessing where it belongs', () => {
    // An odometer with no date can neither prove nor disprove a rollback.
    const history = {
      success: true,
      currentTitleInformation: {
        state: 'FL',
        titleIssueDate: '01/15/2023',
        odometer: 130000,
        historicTitles: [{ state: 'GA', odometer: 62000 }],
      },
    };
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.mileageRecords).toHaveLength(1);
    expect(payload.summary.hasOdometerRollback).toBe(false);
    assertInvariants(payload);
  });

  it('compares title, salvage and insurance readings in one series', () => {
    // A rollback is only visible when readings from different sources are
    // compared against each other, so all three feed one sorted series.
    const history = {
      success: true,
      currentTitleInformation: {
        state: 'TX',
        titleIssueDate: '05/01/2021',
        odometer: 40000,
        odometerUnitOfMeasure: 'MI',
      },
      insuranceInformation: [
        { reportingEntityName: 'Acme', obtainedDate: '02/02/2020', odometer: 90000, odometerUnitOfMeasure: 'MI' },
      ],
    };
    const payload = map(bundle({ history: ok(history) }));

    expect(payload.mileageRecords.map((m) => m.source)).toEqual(['insurance', 'registration']);
    expect(payload.mileageRecords[1].suspicious).toBe(true);
    expect(payload.summary.hasOdometerRollback).toBe(true);
  });
});

// ===========================================================================
// Empty, skipped and failed sections
// ===========================================================================

describe('CarsXE mapper — coverage', () => {
  it('reports an empty history as covered with nothing in it', () => {
    // `empty` means the source was asked and holds nothing. That IS a finding,
    // so the section is `covered` — and the record count is zero, which is what
    // `MIN_SELLABLE_RECORD_COUNT` reads to refund the buyer.
    const payload = map(
      bundle({
        history: { status: 'empty', reason: 'report_not_found' },
        specs: { status: 'empty', reason: 'report_not_found' },
        marketValue: { status: 'empty', reason: 'report_not_found' },
        recalls: { status: 'empty', reason: 'report_not_found' },
        lienTheft: { status: 'empty', reason: 'report_not_found' },
      }),
    );
    assertInvariants(payload);

    expect(payload.summary.recordCount).toBe(0);
    expect(payload.owners).toEqual([]);
    expect(payload.registrations).toEqual([]);
    expect(payload.brands).toEqual([]);
    expect(payload.vehicle).toBeNull();
    expect(payload.coverage.owners).toBe('covered');
    expect(payload.coverage.theft).toBe('covered');
    expect(payload.theft.stolen).toBe(false);
    expect(payload.sources.every((s) => s.status === 'ok')).toBe(true);
  });

  it('marks a failed secondary source unavailable, never empty', () => {
    /*
     * The distinction the coverage map exists for. A market-value endpoint that
     * timed out must not render as "no valuation", and a theft database that
     * did not answer must not render as "not stolen" — that is a false clean
     * bill of health.
     */
    const payload = map(
      bundle({
        marketValue: { status: 'failed', reason: 'http_502' },
        lienTheft: { status: 'failed', reason: 'transport:ECONNABORTED' },
        specs: { status: 'failed', reason: 'http_500' },
      }),
    );
    assertInvariants(payload);

    expect(payload.coverage.marketValue).toBe('unavailable');
    expect(payload.coverage.theft).toBe('unavailable');
    expect(payload.coverage.equipment).toBe('unavailable');
    expect(payload.marketValue).toBeNull();
    expect(payload.equipment).toBeNull();
    expect(payload.theft.stolen).toBe(false);
    // The history still came back, so the report is worth what was paid.
    expect(payload.coverage.owners).toBe('covered');
    expect(payload.sources.filter((s) => s.status === 'failed').map((s) => s.id)).toEqual([
      'carsxe.specs',
      'carsxe.marketvalue',
      'carsxe.lienTheft',
    ]);
  });

  it('marks a skipped source not_covered and says so in sources[]', () => {
    const payload = map(
      bundle({
        recalls: { status: 'skipped', reason: 'vin_not_us_market' },
        lienTheft: { status: 'skipped', reason: 'vin_not_us_market' },
      }),
    );
    assertInvariants(payload);

    expect(payload.coverage.recalls).toBe('not_covered');
    expect(payload.coverage.theft).toBe('not_covered');
    expect(payload.recalls).toEqual([]);
    expect(payload.theft).toEqual({
      stolen: false,
      reportedAt: null,
      countryCode: null,
      recoveredAt: null,
      source: null,
    });
    expect(payload.sources.filter((s) => s.status === 'skipped').map((s) => s.id)).toEqual([
      'carsxe.recalls',
      'carsxe.lienTheft',
    ]);
  });

  it('reports equipment as not_covered when specs answered without an options list', () => {
    // `/specs` answers for a non-US vehicle with dimensions and emissions and no
    // options. An "Equipment" heading over nothing reads as "this car has none".
    const payload = map(
      bundle({ specs: ok({ success: true, attributes: { make: 'BMW', model: '320d' } }) }),
    );

    expect(payload.equipment).toBeNull();
    expect(payload.coverage.equipment).toBe('not_covered');
    // The decode still worked, so the report can still name the car.
    expect(payload.vehicle?.make).toBe('BMW');
  });
});

// ===========================================================================
// Theft
// ===========================================================================

describe('CarsXE mapper — theft', () => {
  it('reports a theft record and keeps it true after recovery', () => {
    const payload = map(
      bundle({
        lienTheft: ok({
          success: true,
          events: [
            {
              type: 'THEFT',
              reportDate: '06/12/2018',
              recoveryDate: '07/02/2018',
              reportingEntityName: 'NICB',
            },
            { type: 'LIEN', reportDate: '01/03/2019', lienholder: 'First National Bank' },
          ],
        }),
      }),
    );
    assertInvariants(payload);

    expect(payload.theft.stolen).toBe(true);
    expect(payload.theft.reportedAt).toBe('2018-06-12');
    expect(payload.theft.recoveredAt).toBe('2018-07-02');
    expect(payload.theft.countryCode).toBe('US');
    expect(payload.summary.hasStolenRecord).toBe(true);
    // Liens have no field in the contract and are dropped rather than folded
    // into damages to avoid losing them.
    expect(JSON.stringify(payload)).not.toContain('First National Bank');
  });

  it('reports no theft when the endpoint answered with no theft events', () => {
    const payload = map(bundle({ lienTheft: ok({ success: true, events: [{ type: 'LIEN' }] }) }));
    expect(payload.theft.stolen).toBe(false);
    expect(payload.coverage.theft).toBe('covered');
  });
});

// ===========================================================================
// Broken input
// ===========================================================================

describe('CarsXE mapper — a response that does not match the documented schema', () => {
  /*
   * A first-class requirement, not defensive noise. Every fixture in this file
   * is hand-authored from prose documentation, so the real key names may differ
   * — and this mapper runs inside `fulfill`, where a throw refunds the buyer AND
   * pages every admin.
   */

  it('does not throw when every key is renamed', () => {
    const renamed = {
      success: true,
      TITLE_RECORDS: [{ ST: 'CA', WHEN: '2020-01-01' }],
      salvage_records: [{ who: 'someone' }],
      brand_legend: brandDictionary(),
    };
    const payload = map(bundle({ history: ok(renamed) }));

    // Nothing from the history survives — but the OTHER four endpoints are
    // untouched, so the buyer still gets recalls, equipment and a valuation.
    expect(payload.owners).toEqual([]);
    expect(payload.registrations).toEqual([]);
    expect(payload.damageRecords).toEqual([]);
    expect(payload.mileageRecords).toEqual([]);
    expect(payload.brands).toEqual([]);
    expect(payload.recalls).toHaveLength(2);
    assertInvariants(payload);
  });

  it('does not throw on scalars where objects were documented', () => {
    const nonsense = {
      success: true,
      currentTitleInformation: 'CA-2021',
      historyInformation: 'none',
      junkAndSalvageInformation: 42,
      insuranceInformation: true,
      brandsInformation: 'Flood damage, Salvage',
      events: null,
    };
    const payload = map(bundle({ history: ok(nonsense) }));

    expect(payload.owners).toEqual([]);
    expect(payload.registrations).toEqual([]);
    expect(payload.damageRecords).toEqual([]);
    expect(payload.insuranceRecords).toEqual([]);
    // A comma-separated string where the dictionary was documented is NOT a
    // list of applied brands.
    expect(payload.brands).toEqual([]);
    assertInvariants(payload);
  });

  it('does not throw on a single object where a list was documented', () => {
    // Providers collapse one-element arrays often enough that a car with
    // exactly one salvage record would otherwise read as a car with none.
    const collapsed = {
      success: true,
      junkAndSalvageInformation: {
        reportingEntityName: 'Solo Salvage',
        obtainedDate: '2019-04-04',
        disposition: 'SOLD',
      },
      insuranceInformation: { reportingEntityName: 'Solo Mutual', disposition: 'TOTAL LOSS' },
    };
    const payload = map(bundle({ history: ok(collapsed) }));

    expect(payload.damageRecords).toHaveLength(1);
    expect(payload.insuranceRecords).toHaveLength(1);
    assertInvariants(payload);
  });

  it('does not throw on unparsable dates, units or money', () => {
    const messy = {
      success: true,
      currentTitleInformation: {
        state: 'CA',
        titleIssueDate: 'sometime in March',
        odometer: 'not a number',
        historicTitles: [{ state: 'NV', titleIssueDate: '2018-06-01', odometer: '55,000', odometerUnitOfMeasure: 'KM' }],
      },
    };
    const payload = map(
      bundle({
        history: ok(messy),
        marketValue: ok({ success: true, market_value: { retail: 'about twelve grand' } }),
      }),
    );
    assertInvariants(payload);

    // The unparsable title survives as a registration with a null date; only
    // its odometer is lost.
    expect(payload.registrations).toHaveLength(2);
    expect(payload.registrations[0].firstRegistration).toBeNull();
    expect(payload.mileageRecords).toHaveLength(1);
    // 'KM' is honoured — the default is miles, not an override of a stated unit.
    expect(payload.mileageRecords[0].mileageKm).toBe(55_000);
    expect(payload.marketValue).toBeNull();
  });

  it('does not throw when the whole bundle is empty objects', () => {
    const payload = map({
      history: ok({}),
      specs: ok({}),
      marketValue: ok({}),
      recalls: ok({}),
      lienTheft: ok({}),
    });

    expect(payload.summary.recordCount).toBe(0);
    expect(payload.vehicle).toBeNull();
    expect(payload.equipment).toBeNull();
    expect(payload.marketValue).toBeNull();
    assertInvariants(payload);
  });
});
