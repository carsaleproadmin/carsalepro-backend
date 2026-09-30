import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { COLOURS, FUEL_TYPES, TRANSMISSIONS } from '../../listings/vehicle-vocabulary';
import {
  LISTING_EMISSION_STANDARDS,
  LISTING_EQUIPMENT_OPTIONS,
  LISTING_FEATURES,
  LISTING_TECHNICAL_CONDITIONS,
  LISTING_VEHICLE_TYPES,
} from '../../listings/dto/listing-vehicle-v1.dto';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

/**
 * A multi-value filter travels as ONE comma-separated parameter
 * (`fuelType=petrol,diesel`), not as a repeated key.
 *
 * Both shapes are accepted on the way in, because Express parses a repeated key
 * into an array and there is no reason to refuse a caller who writes one. The
 * website emits the comma form: its filter bar rebuilds the whole query string
 * from a flat `Record<string, string>` on every submit, and a repeated key
 * cannot be expressed in one.
 *
 * An empty element is dropped rather than rejected. A trailing comma is what a
 * UI produces when the last chip is removed, and answering that with a 400
 * shows the reader an error panel instead of cars.
 */
const toSlugList = ({ value }: { value: unknown }): string[] | undefined => {
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return out.length ? [...new Set(out)] : undefined;
};

/**
 * DEN-402. The same list shape as `toSlugList`, but the case is kept. The
 * declared-vehicle vocabularies are camelCase (`climateMulti`, `carPlay`), so
 * a lower-cased value would never match.
 */
const toList = ({ value }: { value: unknown }): string[] | undefined => {
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return out.length ? [...new Set(out)] : undefined;
};

const toNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

/** Owner-count buckets. `4plus` is four or more. */
export const OWNER_BUCKETS = ['1', '2', '3', '4plus'] as const;

/**
 * DEN-406. How recently the listing was published. `today` starts at 00:00
 * Berlin time; all other values are a window that ends now.
 */
export const PUBLISHED_PERIODS = [
  '1h',
  '3h',
  '6h',
  '12h',
  'today',
  '24h',
  '2d',
  '3d',
  '7d',
  '30d',
  '90d',
] as const;
export type PublishedPeriod = (typeof PUBLISHED_PERIODS)[number];

/** The 12 equipment selects, in the order of the seller editor. */
export const EQUIPMENT_FILTER_KEYS = Object.keys(
  LISTING_EQUIPMENT_OPTIONS,
) as (keyof typeof LISTING_EQUIPMENT_OPTIONS)[];

/** Query strings have no booleans; only the literal 'true'/'1' opt in. */
const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export const PAGE_SIZES = [10, 20, 30, 50, 100] as const;

export const LISTING_SORTS = [
  'default',
  'price_asc',
  'price_desc',
  'recent',
  'year_asc',
  'year_desc',
  'mileage_asc',
  'mileage_desc',
] as const;

export type ListingSort = (typeof LISTING_SORTS)[number];

/** Query for the public showroom. All filters optional; verified listings only. */
export class ListingQueryDto {
  @IsOptional() @IsString() make?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() city?: string;

  /** ISO 3166-1 alpha-2, upper case. Matched exactly. */
  @IsOptional()
  @IsString()
  @Length(2, 2)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;
  /*
   * MULTI-VALUE since DEN-355, and deliberately NOT validated against a closed
   * list.
   *
   * A body type reaches the column as free text from three writers and is
   * matched case-insensitively rather than as a slug, so a roster here would
   * refuse a value the database really holds. The filter is an OR over
   * whatever is asked for; an unknown member simply matches nothing.
   *
   * A single value still parses, as a one-element list, so every link shared
   * before this change keeps working.
   */
  @IsOptional()
  @Transform(toSlugList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  bodyType?: string[];

  @IsOptional()
  @Transform(toSlugList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  driveType?: string[];

  /*
   * These three ARE validated against the vocabulary, because unlike the two
   * above they are stored folded (`listings/vehicle-vocabulary.ts`): the column
   * can only hold a slug or a value no filter was ever going to match. A typo
   * is therefore a 400 that names the offending value, rather than an empty
   * showroom the visitor has to explain to themselves.
   */
  @IsOptional()
  @Transform(toSlugList)
  @IsArray()
  @ArrayMaxSize(FUEL_TYPES.length)
  @IsIn([...FUEL_TYPES], { each: true })
  fuelType?: string[];

  @IsOptional()
  @Transform(toSlugList)
  @IsArray()
  @ArrayMaxSize(TRANSMISSIONS.length)
  @IsIn([...TRANSMISSIONS], { each: true })
  transmission?: string[];

  @IsOptional()
  @Transform(toSlugList)
  @IsArray()
  @ArrayMaxSize(COLOURS.length)
  @IsIn([...COLOURS], { each: true })
  color?: string[];

  /*
   * DEN-401. The vehicle category from the seller editor. One value, not a
   * list: a buyer looks for a car OR a motorbike, not both in one search.
   */
  @IsOptional()
  @IsIn([...LISTING_VEHICLE_TYPES])
  vehicleType?: string;

  /*
   * DEN-402. Filters over the declared vehicle data (`vehicleData` JSON). The
   * seller fills these in the manual editor. A listing that does not state a
   * value is left out when the filter is set.
   */
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(20) engineVolumeFrom?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(20) engineVolumeTo?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelCityFrom?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelCityTo?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelHighwayFrom?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelHighwayTo?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelCombinedFrom?: number;
  @IsOptional() @Transform(toNumber) @IsNumber() @Min(0) @Max(50) fuelCombinedTo?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(60) seatsFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(60) seatsTo?: number;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn(['2', '3', '4', '5'], { each: true })
  doors?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_TECHNICAL_CONDITIONS], { each: true })
  technicalCondition?: string[];

  /** DEN-405. Emission standards, any of them. */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EMISSION_STANDARDS], { each: true })
  emissionStandard?: string[];

  /** DEN-405. Countries the car was imported from (ISO alpha-2), any of them. */
  @IsOptional()
  @Transform(({ value }) => toList({ value })?.map((code) => code.toUpperCase()))
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[A-Z]{2}$/, { each: true })
  importedFrom?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...OWNER_BUCKETS], { each: true })
  owners?: string[];

  /** The seller claims no accidents. */
  @IsOptional() @Transform(toBool) @IsBoolean() accidentFree?: boolean;
  /** The seller claims a complete service history. */
  @IsOptional() @Transform(toBool) @IsBoolean() serviceHistory?: boolean;
  /** The seller agrees to a check at a service station. */
  @IsOptional() @Transform(toBool) @IsBoolean() serviceCheckReady?: boolean;

  /** DEN-406. Only listings published in this period. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn([...PUBLISHED_PERIODS])
  publishedPeriod?: PublishedPeriod;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.climate], { each: true })
  climate?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.powerWindows], { each: true })
  powerWindows?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.interiorMaterial], { each: true })
  interiorMaterial?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.interiorColour], { each: true })
  interiorColour?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.powerSteering], { each: true })
  powerSteering?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.steeringAdjust], { each: true })
  steeringAdjust?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.spareWheel], { each: true })
  spareWheel?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.headlights], { each: true })
  headlights?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.seatAdjust], { each: true })
  seatAdjust?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.seatMemory], { each: true })
  seatMemory?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.seatHeating], { each: true })
  seatHeating?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn([...LISTING_EQUIPMENT_OPTIONS.seatVentilation], { each: true })
  seatVentilation?: string[];

  /** Equipment the car must have. ALL of them, not any one. */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(LISTING_FEATURES.length)
  @IsIn([...LISTING_FEATURES], { each: true })
  features?: string[];

  @IsOptional() @Transform(toInt) @IsInt() @Min(1900) @Max(2100) yearFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(1900) @Max(2100) yearTo?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) priceFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) priceTo?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) mileageFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) mileageTo?: number;

  /*
   * Power in KILOWATTS, which is what the column holds. The website shows and
   * takes PS and converts on the way in - one conversion point, the same rule
   * the price filter follows for euros and cents.
   *
   * The ceiling matches `ListingVehicleDeclaredDto.powerKw` (2000 kW). A bound
   * higher than the one the writer enforces would accept a query no row can
   * ever satisfy.
   */
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) @Max(2000) powerFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) @Max(2000) powerTo?: number;

  /**
   * Show ONLY inspection-backed listings. Defaults to FALSE: manual listings
   * appear in the showroom badged as self-declared, because excluding them by
   * default would empty the showroom for the seller segment BE-S2 exists for.
   */
  @IsOptional() @Transform(toBool) @IsBoolean() verifiedOnly?: boolean;

  /**
   * DEN-211. The orders the showroom offers.
   *
   * `default` is the ranking the site has always had and stays the default.
   * `recent` is now the reader ASKING for newest first, which is a different
   * statement even though the two agree today - the default is free to change
   * and `recent` is not.
   *
   * The list is closed on purpose. An unknown value is refused rather than
   * quietly answered with the default, because a sort silently ignored looks
   * to the reader like the data is wrong.
   */
  @IsOptional() @IsIn([...LISTING_SORTS]) sort?: ListingSort;

  @IsOptional() @Transform(toInt) @IsInt() @Min(1) page?: number;

  /**
   * How many cards one page carries. Closed set, because the value decides how
   * much work one request costs and an open integer is an invitation to ask
   * for ten thousand.
   */
  @IsOptional() @Transform(toInt) @IsInt() @IsIn([...PAGE_SIZES]) perPage?: number;
}
