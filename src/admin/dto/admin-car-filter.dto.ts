import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

/**
 * The showroom filters, for the admin Listings and Orders lists (DEN-316).
 *
 * The names and units are the same as on `GET /api/v1/public/listings`, so the
 * admin panel can use the showroom filter controls without a second mapping.
 * Money is integer cents, as in the showroom query.
 */
export class AdminCarFilterQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Make. Case, diacritics and separators are ignored.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  make?: string;

  @ApiPropertyOptional({ description: 'Model. Case, diacritics and separators are ignored.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @ApiPropertyOptional({ description: 'City. Any spelling or alias of the city matches.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2 country code. Exact match.' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;

  @ApiPropertyOptional({ minimum: 1900, maximum: 2100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  yearFrom?: number;

  @ApiPropertyOptional({ minimum: 1900, maximum: 2100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  yearTo?: number;

  @ApiPropertyOptional({ description: 'Lowest price, integer cents.', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceFrom?: number;

  @ApiPropertyOptional({ description: 'Highest price, integer cents.', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceTo?: number;

  @ApiPropertyOptional({ description: 'Highest mileage, km.', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mileageTo?: number;
}

/** A `gte`/`lte` range, or undefined when neither bound is set. `0` is a real bound. */
export function intRange(from?: number, to?: number): { gte?: number; lte?: number } | undefined {
  if (from == null && to == null) return undefined;
  return { gte: from ?? undefined, lte: to ?? undefined };
}
