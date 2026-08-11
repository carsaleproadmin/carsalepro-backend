const TRANSLITERATE: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function isVinFormat(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin.toUpperCase());
}

/**
 * NHTSA-style VIN checksum verification.
 * Note: many EU/Asian VINs intentionally violate this checksum; we treat
 * checksum failure as a soft warning, not a 400, in the API layer.
 *
 * That violation is also a SIGNAL, and the paid VIN history feature reads it as
 * one — see `vinHistoryCoverage` below.
 */
export function vinChecksumValid(vin: string): boolean {
  const v = vin.toUpperCase();
  if (!isVinFormat(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    const value = /[0-9]/.test(ch) ? parseInt(ch, 10) : TRANSLITERATE[ch];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i];
  }
  const mod = sum % 11;
  const expected = mod === 10 ? 'X' : String(mod);
  return v[8] === expected;
}

export function normalizeVin(vin: string): string {
  return vin.toUpperCase();
}

/**
 * Whether a paid history lookup for this VIN is worth attempting.
 *
 * - `supported`   — the VIN is well-formed and its check digit computes.
 * - `not_covered` — well-formed, check digit does not compute.
 * - `invalid_vin` — not a VIN at all.
 *
 * WHY THE CHECK DIGIT, AND NOT THE REGION.
 *
 * The obvious gate is the first character, which encodes where the car was
 * BUILT: 1-5 North America, S-Z Europe. It is the wrong question. The BMW that
 * came back from the provider with seven salvage records, an insurance write-off
 * and a full California title ladder is `WBAFR7C57CC811956` — a `W`, the German
 * WMI, because a German-built car sold in the United States carries a German VIN
 * and a complete US history. A region gate refuses precisely the US imports this
 * product exists to check.
 *
 * The check digit asks the question that actually matters — was this car built
 * for the US market — because 49 CFR 565 makes position 9 mandatory for vehicles
 * manufactured for sale in the United States and optional everywhere else. Our
 * history source is NMVTIS, which holds US titles, so a VIN with records is
 * almost always a VIN with a valid check digit. The same BMW computes `7` and
 * carries `7`; a European domestic VIN typically does not compute at all.
 *
 * IT IS A HEURISTIC AND NOT A GUARANTEE, in both directions:
 *
 * - False negative: a European car later imported and titled in the US is
 *   refused here, and the visitor is told to order a real inspection instead.
 * - False positive: a valid check digit is not a promise that any records exist.
 *   That case survives to the billable lookup and is caught by
 *   `MIN_SELLABLE_RECORD_COUNT`, which refunds the buyer in full.
 *
 * What it buys is the thing that has to hold: no visitor is ever offered a paid
 * report the source plainly cannot produce, and finding that out costs nothing.
 */
export type VinHistoryCoverage = 'supported' | 'not_covered' | 'invalid_vin';

export function vinHistoryCoverage(vin: string): VinHistoryCoverage {
  const v = normalizeVin(vin);
  if (!isVinFormat(v)) return 'invalid_vin';
  return vinChecksumValid(v) ? 'supported' : 'not_covered';
}
