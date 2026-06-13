import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Upsert the caller's inspector profile (all fields optional / additive). */
export class UpdateInspectorProfileDto {
  @ApiPropertyOptional({ example: 'KFZ Müller GmbH' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @ApiPropertyOptional({ example: 'Musterstraße 1, 10115 Berlin' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  baseAddress?: string;

  @ApiPropertyOptional({ example: 52.52, description: 'Base latitude (WGS84).' })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 13.405, description: 'Base longitude (WGS84).' })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ example: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  searchRadiusKm?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  available?: boolean;
}
