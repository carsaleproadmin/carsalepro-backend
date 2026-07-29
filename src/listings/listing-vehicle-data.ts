import { ListingVehicleV1Dto } from './dto/listing-vehicle-v1.dto';

export type JsonObject = Record<string, unknown>;

/**
 * Fields that ride along on the reused `ReportDamageDto` and must never survive
 * on a seller-declared listing.
 *
 * AW/AZT repair estimation is a trained discipline: an inspector prices a dent
 * from a labour-unit catalogue and a country hourly rate. A seller pricing their
 * own car's damage is the one party with a motive to understate it, and a
 * plausible-looking "repair cost: €120" next to an asking price is exactly the
 * number a buyer would rely on. The fields are STRIPPED rather than rejected —
 * a client may legitimately be replaying a payload it read from a report.
 */
const DAMAGE_COST_FIELDS = ['materialsEur', 'hours', 'hourlyRate', 'manualCostEur'] as const;

/**
 * Blocks that only an inspection can produce. They are not declared on
 * `ListingVehicleV1Dto`, so the global ValidationPipe (`forbidNonWhitelisted`)
 * already rejects them with a 400. Stripped here as well so the invariant
 * survives someone relaxing the pipe.
 */
const INSPECTOR_ONLY_BLOCKS = ['scores', 'signoff'] as const;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * DTO instance → plain JSON. `JSON.stringify` drops `undefined` values and keeps
 * explicit `null`s, which is exactly the distinction the merge below depends on:
 * an absent key means "leave alone", a null means "delete".
 */
export function toPlainJson(dto: unknown): JsonObject {
  return JSON.parse(JSON.stringify(dto ?? {})) as JsonObject;
}

/** Remove everything a seller is not allowed to assert. Mutates a copy. */
export function sanitizeVehicleData(input: JsonObject): JsonObject {
  const out: JsonObject = { ...input };

  for (const block of INSPECTOR_ONLY_BLOCKS) delete out[block];

  if (Array.isArray(out.damages)) {
    out.damages = out.damages.map((damage) => {
      if (!isPlainObject(damage)) return damage;
      const clean: JsonObject = { ...damage };
      for (const field of DAMAGE_COST_FIELDS) delete clean[field];
      return clean;
    });
  }

  out.schemaVersion = 1;
  return out;
}

/**
 * Deep-merge a patch into the stored payload.
 *
 *   - plain objects   → merged key by key (recursively)
 *   - arrays          → REPLACED wholesale
 *   - explicit `null` → deletes the key
 *   - absent key      → left untouched
 *
 * Arrays replace rather than merge because element-wise merging gives the client
 * no way to express a deletion: `damages` could only ever grow.
 */
export function mergeVehicleData(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeVehicleData(out[key] as JsonObject, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The denormalised listing columns projected out of a vehicleData payload. */
export interface ProjectedVehicleColumns {
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  mileageKm: number | null;
  fuelType: string | null;
  transmission: string | null;
  powerKw: number | null;
  firstRegistration: Date | null;
  huValidUntil: string | null;
  color: string | null;
  bodyType: string | null;
  driveType: string | null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Project the searchable columns out of the JSON payload.
 *
 * Showroom search reads listing columns, never the JSON blob — a query planner
 * cannot use an index inside jsonb the way `(make, model, year)` is indexed, and
 * report-backed and manual listings must be filterable through one code path.
 */
export function projectVehicleColumns(data: JsonObject): ProjectedVehicleColumns {
  const vehicle = isPlainObject(data.vehicle) ? data.vehicle : {};
  const operational = isPlainObject(data.operational) ? data.operational : {};

  const vinRaw = str(vehicle.vin, 17);
  const firstReg = str(vehicle.firstRegistration, 32);
  const parsedFirstReg = firstReg ? new Date(firstReg) : null;

  return {
    vin: vinRaw ? vinRaw.toUpperCase() : null,
    make: str(vehicle.make, 64),
    model: str(vehicle.model, 64),
    year: int(vehicle.year),
    mileageKm: int(operational.mileageKm),
    fuelType: str(vehicle.fuelType, 32),
    transmission: str(vehicle.transmission, 32),
    powerKw: int(vehicle.powerKw),
    firstRegistration:
      parsedFirstReg && !Number.isNaN(parsedFirstReg.getTime()) ? parsedFirstReg : null,
    // The mobile contract calls it `tuvDate` and treats it as free text
    // ("2027-06"), so it lands in a text column, not a date one.
    huValidUntil: str(vehicle.tuvDate, 16),
    color: str(vehicle.colour, 64),
    bodyType: str(vehicle.bodyType, 32),
    driveType: str(vehicle.driveType, 32),
  };
}

/** Convenience: DTO → sanitised plain payload. */
export function normalizeVehicleDataDto(dto: ListingVehicleV1Dto): JsonObject {
  return sanitizeVehicleData(toPlainJson(dto));
}
