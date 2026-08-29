import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

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
  @IsOptional() @IsString() bodyType?: string;
  @IsOptional() @IsString() driveType?: string;

  @IsOptional() @Transform(toInt) @IsInt() @Min(1900) @Max(2100) yearFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(1900) @Max(2100) yearTo?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) priceFrom?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) priceTo?: number;
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) mileageTo?: number;

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
