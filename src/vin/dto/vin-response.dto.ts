import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VinResponseDto {
  @ApiProperty({ example: '1HGBH41JXMN109186' })
  vin!: string;

  @ApiPropertyOptional({ example: 'HONDA' })
  make?: string | null;

  @ApiPropertyOptional({ example: 'Accord' })
  model?: string | null;

  @ApiPropertyOptional({ example: 2021 })
  modelYear?: number | null;

  @ApiPropertyOptional({ example: 'JAPAN' })
  plantCountry?: string | null;

  @ApiPropertyOptional({ example: 'Sedan/Saloon' })
  bodyClass?: string | null;

  @ApiPropertyOptional({ example: 'GASOLINE' })
  fuelType?: string | null;

  @ApiProperty({ example: 'nhtsa-vpic' })
  source!: string;

  @ApiProperty({ example: true, description: 'true if served from local cache, false on NHTSA fetch' })
  cached!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Raw NHTSA vPIC payload (Results[])',
  })
  raw!: Record<string, unknown>;
}
