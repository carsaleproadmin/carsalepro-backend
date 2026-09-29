import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  COLOURS,
  FUEL_TYPES,
  TRANSMISSIONS,
} from '../../listings/vehicle-vocabulary';
import { LISTING_VEHICLE_TYPES } from '../../listings/dto/listing-vehicle-v1.dto';

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
