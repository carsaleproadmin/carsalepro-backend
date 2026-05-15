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
