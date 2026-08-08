import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ListingVehicleV1Dto } from './listing-vehicle-v1.dto';

export class UpdateListingDto {
  @ApiPropertyOptional({ example: 1850000, description: 'Asking price in integer cents (> 0).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @ApiPropertyOptional({ example: 'Berlin' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: '10115' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  plz?: string;

  @ApiPropertyOptional({ example: 'One owner, full service history.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '+49 30 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  /**
   * Seller contact e-mail. Optional everywhere in the UI, so it must be
   * possible to leave blank AND to clear once set.
   *
   * `@IsOptional()` skips only `null` and `undefined` — **not** `''`. With a
   * bare `@IsEmail()` a blank field therefore failed the whole PATCH with
   * `contactEmail must be an email`, which the seller form renders as a generic
   * "something went wrong": step 2 of the Report ID claim flow and the listing
   * edit page were both dead ends for anyone who did not fill it in.
   *
   * So `''` is normalised to `null` (the column is nullable) and validation is
   * skipped for `null`, which is what makes clearing work. Omitting the key
   * still means "leave unchanged" — `update()` keys off `!== undefined`.
   */
  @ApiPropertyOptional({
    example: 'seller@example.com',
    nullable: true,
    description: 'Send null or an empty string to clear it. Omit the key to leave it unchanged.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? null : value))
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  /**
   * Seller-declared vehicle data. Accepted ONLY on a `source: 'manual'` listing
   * — an inspected listing's vehicle data comes from its report, and editing it
   * here would let a seller contradict the inspector (400 `vehicle_immutable`).
   *
   * DEEP-MERGED into the stored payload: objects merge key by key, **arrays are
   * replaced wholesale**, and an explicit `null` deletes the key. Arrays replace
   * because a merge cannot express "remove the second damage" — element-wise
   * merging would leave the client with no way to delete from a list at all.
   */
  @ApiPropertyOptional({ type: ListingVehicleV1Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingVehicleV1Dto)
  vehicleData?: ListingVehicleV1Dto;
}
