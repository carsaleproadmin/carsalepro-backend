import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ListingVehicleV1Dto } from './listing-vehicle-v1.dto';

/**
 * Open a DRAFT listing for a car that has NOT been inspected (BE-S2).
 *
 * Everything is optional: a seller starts the form, saves, and comes back. The
 * completeness contract lives in `POST /listings/:id/publish`, which answers
 * with the exact list of what is still missing.
 */
export class CreateManualListingDto {
  @ApiPropertyOptional({ example: 1850000, description: 'Asking price in integer cents.' })
  @IsOptional()
  @IsInt()
  @Min(0)
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

  @ApiPropertyOptional({ example: 'seller@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  @ApiPropertyOptional({ type: ListingVehicleV1Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingVehicleV1Dto)
  vehicleData?: ListingVehicleV1Dto;
}
