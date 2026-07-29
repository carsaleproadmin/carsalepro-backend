import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

/** Query strings have no booleans; only the literal 'true'/'1' opt in. */
const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

/** Query for the public showroom. All filters optional; verified listings only. */
export class ListingQueryDto {
  @IsOptional() @IsString() make?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() city?: string;
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

  @IsOptional() @IsIn(['recent', 'price_asc', 'price_desc']) sort?: 'recent' | 'price_asc' | 'price_desc';

  @IsOptional() @Transform(toInt) @IsInt() @Min(1) page?: number;
}
