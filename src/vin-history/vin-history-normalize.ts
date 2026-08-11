/**
 * Field-level normalisation shared by every VIN-history provider mapper.
 *
 * These four functions were prototyped in `test/helpers/vin-history-simulator.ts`
 * while no provider had sent us a contract. They are production code now, for
 * the plain reason that a mapper in `src/` must not import from `test/` — and
 * because the rules they encode are decisions, not utilities: a date we cannot
 * parse becomes null rather than a guess, money crosses into integer cents once
 * and at the boundary, a mileage reading is stored in kilometres whatever unit
 * it arrived in, and a plate is masked before it is ever written down.
 *
 * The simulator re-exports them so its own tests keep pinning the same code the
 * real mappers run.
 */

const KM_PER_MILE = 1.609344;

/** Money as providers actually send it: a decimal amount plus a currency. */
export interface NormalizableAmount {
  amount: number | string | null | undefined;
  currency?: string | null;
}

/**
 * ISO 'YYYY-MM-DD', an ISO timestamp, German 'DD.MM.YYYY', US 'M/D/YYYY', or
 * nothing.
 *
 * Returns null rather than guessing on anything else: a wrong date on a damage
 * record is worse than a missing one, because the buyer will act on it.
 *
 * The slash form is read as MONTH FIRST. That is ambiguous in the abstract and
 * unambiguous in practice for the source we have — CarsXE serves NMVTIS, a US
 * federal database whose dates are US-formatted. Reading '03/04/2019' as 4 March
 * would silently move a title event by nine months.
 */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // An ISO timestamp: keep the calendar day and drop the clock. The time of day
  // a title was issued is never meaningful and printing it implies a precision
  // the record does not have.
  const isoTimestamp = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}/.exec(trimmed);
  if (isoTimestamp) return isoTimestamp[1];

  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (german) return `${german[3]}-${german[2]}-${german[1]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (us) {
    const month = Number.parseInt(us[1], 10);
    const day = Number.parseInt(us[2], 10);
    // Refuse an impossible date instead of rolling it over. '13/05/2019' is a
    // day-first feed we were not told about, and inventing 2020-01-05 from it
    // would be the exact wrong-date-is-worse-than-no-date failure.
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${us[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

/**
 * A decimal amount as an integer number of cents.
 *
 * Accepts a JS number, an English string ('4317.37') and a German one
 * ('12.480,90'). The platform rule is integer cents everywhere; a provider
 * sending floats is not an excuse to start carrying them.
 */
export function toCents(raw: NormalizableAmount | null | undefined): number | null {
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

/**
 * A mileage reading in kilometres, whatever unit it arrived in.
 *
 * Thousands separators are stripped first, and that is not cosmetic: US title
 * feeds write an odometer as '55,000', and `parseFloat` stops at the comma and
 * returns 55. A car with 55 000 miles on it would have printed as having done
 * 55 kilometres, which is the single number a buyer looks at hardest. Only a
 * comma followed by exactly three digits is removed, so a German decimal comma
 * ('55,5') is left alone.
 */
export function toKilometres(value: unknown, unit: unknown): number | null {
  const numeric =
    typeof value === 'string' ? Number.parseFloat(value.replace(/,(?=\d{3}\b)/g, '')) : value;
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

/**
 * One value, a list of them, or nothing, as a list.
 *
 * Providers collapse a single-element array to the bare object often enough that
 * every mapper needs this on the way in. Without it a car with exactly one
 * salvage record reads as a car with none, because `.map` is not a function on
 * an object and the section would be dropped.
 */
export function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}
