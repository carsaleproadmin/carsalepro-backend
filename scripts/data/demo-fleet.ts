/**
 * The catalogue the demo showroom is built from - DEN-216.
 *
 * TWO KINDS OF FACT live in this file, and the difference matters legally.
 *
 *   1. MODEL facts (make, model, body, fuel, power, drive). These are real, and
 *      they come from sources that can be reused without permission:
 *
 *        - EEA, monitoring of CO2 emissions from new passenger cars under
 *          Regulation (EU) 2019/631 - https://www.eea.europa.eu/en/datahub
 *          Free reuse WITH ATTRIBUTION TO THE EEA. That attribution is the
 *          reason this header exists; do not delete it when editing the table.
 *        - Wikidata (CC0) for model generations and production years.
 *        - NHTSA vPIC (US federal, public domain) for body and drive vocabulary.
 *
 *      No commercial catalogue was used. cardatabases.com, teoalida.com,
 *      databaseatlas.com and the `vbalagovic/cars-dataset` repository are all
 *      proprietary or of undisclosed provenance, and a licence problem in the
 *      seed data of a public showroom is not a thing worth saving an hour over.
 *
 *   2. INSTANCE facts (mileage, colour, price, first registration, HU date).
 *      No catalogue on earth has these - they are properties of one physical
 *      car. They are GENERATED, deterministically, by the importer. They are
 *      plausible; they are not true of any car that exists.
 *
 * What is NOT here, and must never be added: inspection findings, paint
 * thickness, damage lists, quality scores. Those are the one thing this
 * platform sells, and a fabricated one is a claim about a car nobody looked at.
 * Demo listings are self-declared (`source: 'manual'`, no report) for that
 * reason alone.
 */

/** A model as the catalogue knows it, before any one car is imagined. */
export interface FleetModel {
  make: string;
  model: string;
  /** Production years of the generation named above - the importer picks within. */
  years: [number, number];
  bodyType: string;
  fuelType: string;
  transmission: 'manual' | 'automatic';
  powerKw: number;
  driveType: 'fwd' | 'rwd' | 'awd';
  /**
   * Approximate LIST price when new, in EUR cents, German market, at the launch
   * of the generation named above.
   *
   * The new price and not a used one, because the importer depreciates from the
   * car's year of manufacture: anchoring on a second-hand figure and then
   * depreciating again priced a 2013 Golf at 3 200 EUR, roughly a third of
   * what one costs. It is a rough figure for a plausible curve, not a
   * valuation, and no demo advert should be read as a market price.
   */
  newPriceCents: number;
}

export const FLEET: FleetModel[] = [
  { make: 'Volkswagen', model: 'Golf VII 1.6 TDI', years: [2013, 2019], bodyType: 'hatchback', fuelType: 'diesel', transmission: 'manual', powerKw: 85, driveType: 'fwd', newPriceCents: 2_550_000 },
  { make: 'Volkswagen', model: 'Golf VIII 1.5 TSI', years: [2020, 2024], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'automatic', powerKw: 110, driveType: 'fwd', newPriceCents: 3_200_000 },
  { make: 'Volkswagen', model: 'Passat B8 2.0 TDI', years: [2015, 2022], bodyType: 'estate', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'fwd', newPriceCents: 4_100_000 },
  { make: 'Volkswagen', model: 'Tiguan II 2.0 TDI', years: [2016, 2023], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 110, driveType: 'awd', newPriceCents: 4_300_000 },
  { make: 'Volkswagen', model: 'Polo VI 1.0 TSI', years: [2018, 2024], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'manual', powerKw: 70, driveType: 'fwd', newPriceCents: 1_950_000 },
  { make: 'Skoda', model: 'Octavia III 1.6 TDI', years: [2013, 2019], bodyType: 'estate', fuelType: 'diesel', transmission: 'manual', powerKw: 85, driveType: 'fwd', newPriceCents: 2_450_000 },
  { make: 'Skoda', model: 'Octavia IV 2.0 TDI', years: [2020, 2024], bodyType: 'estate', fuelType: 'diesel', transmission: 'automatic', powerKw: 110, driveType: 'fwd', newPriceCents: 3_300_000 },
  { make: 'Skoda', model: 'Superb III 2.0 TSI', years: [2016, 2023], bodyType: 'sedan', fuelType: 'petrol', transmission: 'automatic', powerKw: 140, driveType: 'fwd', newPriceCents: 4_200_000 },
  { make: 'Skoda', model: 'Kodiaq 2.0 TDI', years: [2017, 2023], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 110, driveType: 'awd', newPriceCents: 4_100_000 },
  { make: 'Audi', model: 'A4 B9 2.0 TDI', years: [2016, 2023], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'fwd', newPriceCents: 4_600_000 },
  { make: 'Audi', model: 'A6 C7 3.0 TDI', years: [2012, 2018], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 200, driveType: 'awd', newPriceCents: 6_400_000 },
  { make: 'Audi', model: 'Q5 FY 2.0 TDI', years: [2017, 2023], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'awd', newPriceCents: 5_500_000 },
  { make: 'Audi', model: 'A3 8V 1.4 TFSI', years: [2013, 2020], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'manual', powerKw: 92, driveType: 'fwd', newPriceCents: 3_000_000 },
  { make: 'BMW', model: '320d F30', years: [2012, 2019], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'rwd', newPriceCents: 4_400_000 },
  { make: 'BMW', model: '520d G30', years: [2017, 2023], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'rwd', newPriceCents: 5_600_000 },
  { make: 'BMW', model: 'X3 G01 xDrive20d', years: [2018, 2024], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'awd', newPriceCents: 5_800_000 },
  { make: 'BMW', model: '118i F20', years: [2015, 2019], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'manual', powerKw: 100, driveType: 'rwd', newPriceCents: 2_900_000 },
  { make: 'Mercedes-Benz', model: 'C 220 d W205', years: [2014, 2021], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 143, driveType: 'rwd', newPriceCents: 4_500_000 },
  { make: 'Mercedes-Benz', model: 'E 220 d W213', years: [2016, 2023], bodyType: 'sedan', fuelType: 'diesel', transmission: 'automatic', powerKw: 143, driveType: 'rwd', newPriceCents: 5_400_000 },
  { make: 'Mercedes-Benz', model: 'A 180 W177', years: [2018, 2024], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'automatic', powerKw: 100, driveType: 'fwd', newPriceCents: 3_300_000 },
  { make: 'Mercedes-Benz', model: 'GLC 220 d X253', years: [2016, 2022], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 143, driveType: 'awd', newPriceCents: 5_400_000 },
  { make: 'Opel', model: 'Astra K 1.6 CDTI', years: [2016, 2021], bodyType: 'hatchback', fuelType: 'diesel', transmission: 'manual', powerKw: 81, driveType: 'fwd', newPriceCents: 2_400_000 },
  { make: 'Ford', model: 'Focus IV 1.0 EcoBoost', years: [2019, 2024], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'manual', powerKw: 92, driveType: 'fwd', newPriceCents: 2_400_000 },
  { make: 'Ford', model: 'Kuga III 1.5 EcoBlue', years: [2020, 2024], bodyType: 'suv', fuelType: 'diesel', transmission: 'manual', powerKw: 88, driveType: 'fwd', newPriceCents: 3_400_000 },
  { make: 'Renault', model: 'Megane IV 1.5 dCi', years: [2016, 2022], bodyType: 'hatchback', fuelType: 'diesel', transmission: 'manual', powerKw: 85, driveType: 'fwd', newPriceCents: 2_400_000 },
  { make: 'Peugeot', model: '308 II 1.5 BlueHDi', years: [2018, 2021], bodyType: 'hatchback', fuelType: 'diesel', transmission: 'manual', powerKw: 96, driveType: 'fwd', newPriceCents: 2_600_000 },
  { make: 'Toyota', model: 'Corolla XII 1.8 Hybrid', years: [2019, 2024], bodyType: 'hatchback', fuelType: 'hybrid', transmission: 'automatic', powerKw: 90, driveType: 'fwd', newPriceCents: 2_900_000 },
  { make: 'Toyota', model: 'RAV4 V 2.5 Hybrid', years: [2019, 2024], bodyType: 'suv', fuelType: 'hybrid', transmission: 'automatic', powerKw: 163, driveType: 'awd', newPriceCents: 4_100_000 },
  { make: 'Kia', model: 'Ceed III 1.6 CRDi', years: [2018, 2023], bodyType: 'estate', fuelType: 'diesel', transmission: 'manual', powerKw: 100, driveType: 'fwd', newPriceCents: 2_600_000 },
  { make: 'Hyundai', model: 'Tucson III 1.6 CRDi', years: [2018, 2020], bodyType: 'suv', fuelType: 'diesel', transmission: 'manual', powerKw: 85, driveType: 'fwd', newPriceCents: 2_900_000 },
  { make: 'Volvo', model: 'XC60 II D4', years: [2018, 2022], bodyType: 'suv', fuelType: 'diesel', transmission: 'automatic', powerKw: 140, driveType: 'awd', newPriceCents: 5_600_000 },
  { make: 'Volvo', model: 'V60 II D3', years: [2019, 2022], bodyType: 'estate', fuelType: 'diesel', transmission: 'automatic', powerKw: 110, driveType: 'fwd', newPriceCents: 4_600_000 },
  { make: 'Seat', model: 'Leon III 1.4 TSI', years: [2014, 2020], bodyType: 'hatchback', fuelType: 'petrol', transmission: 'manual', powerKw: 92, driveType: 'fwd', newPriceCents: 2_400_000 },
  { make: 'Mazda', model: 'CX-5 II 2.0 Skyactiv-G', years: [2017, 2023], bodyType: 'suv', fuelType: 'petrol', transmission: 'manual', powerKw: 121, driveType: 'fwd', newPriceCents: 3_100_000 },
  { make: 'Nissan', model: 'Qashqai II 1.5 dCi', years: [2017, 2021], bodyType: 'suv', fuelType: 'diesel', transmission: 'manual', powerKw: 85, driveType: 'fwd', newPriceCents: 2_900_000 },
  { make: 'Tesla', model: 'Model 3 Long Range', years: [2019, 2023], bodyType: 'sedan', fuelType: 'electric', transmission: 'automatic', powerKw: 258, driveType: 'awd', newPriceCents: 5_500_000 },
];

/**
 * Where the demo cars stand.
 *
 * The city is what DEN-205 made searchable in any script, so the set is
 * deliberately mixed-alphabet: a Cyrillic city here is what proves the
 * transliteration works on production data rather than only in a test.
 *
 * `countryCode` is set on EVERY row. Three of the five real production
 * listings have none, which is exactly the hole that made the country filter
 * look broken, and a hundred new rows must not widen it.
 */
export interface FleetPlace {
  city: string;
  countryCode: string;
  plz: string;
}

export const PLACES: FleetPlace[] = [
  { city: 'Berlin', countryCode: 'DE', plz: '10119' },
  { city: 'München', countryCode: 'DE', plz: '80331' },
  { city: 'Hamburg', countryCode: 'DE', plz: '20095' },
  { city: 'Köln', countryCode: 'DE', plz: '50667' },
  { city: 'Frankfurt am Main', countryCode: 'DE', plz: '60311' },
  { city: 'Stuttgart', countryCode: 'DE', plz: '70173' },
  { city: 'Düsseldorf', countryCode: 'DE', plz: '40213' },
  { city: 'Leipzig', countryCode: 'DE', plz: '04109' },
  { city: 'Wien', countryCode: 'AT', plz: '1010' },
  { city: 'Graz', countryCode: 'AT', plz: '8010' },
  { city: 'Zürich', countryCode: 'CH', plz: '8001' },
  { city: 'Amsterdam', countryCode: 'NL', plz: '1011' },
  { city: 'Rotterdam', countryCode: 'NL', plz: '3011' },
  { city: 'Warszawa', countryCode: 'PL', plz: '00-001' },
  { city: 'Kraków', countryCode: 'PL', plz: '30-001' },
  { city: 'Praha', countryCode: 'CZ', plz: '11000' },
  { city: 'Київ', countryCode: 'UA', plz: '01001' },
  { city: 'Львів', countryCode: 'UA', plz: '79000' },
  { city: 'Одеса', countryCode: 'UA', plz: '65000' },
  { city: 'Paris', countryCode: 'FR', plz: '75001' },
  { city: 'Lyon', countryCode: 'FR', plz: '69001' },
  { city: 'Milano', countryCode: 'IT', plz: '20121' },
  { city: 'Madrid', countryCode: 'ES', plz: '28001' },
  { city: 'Vilnius', countryCode: 'LT', plz: '01100' },
];

/** Paint, in the vocabulary the seller editor offers. */
export const COLORS = [
  'black', 'white', 'silver', 'grey', 'blue', 'red', 'green', 'brown', 'beige',
];
