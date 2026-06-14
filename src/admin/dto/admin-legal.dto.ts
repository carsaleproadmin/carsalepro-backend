import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const LEGAL_TEMPLATE_KEYS = ['contract_de', 'contract_eu', 'contract_en'] as const;
export type LegalTemplateKey = (typeof LEGAL_TEMPLATE_KEYS)[number];

export class CreateLegalVersionDto {
  @ApiProperty({ example: 'de' })
  @IsString()
  @MaxLength(8)
  locale!: string;

  @ApiProperty({ example: 'Inspection Contract (Germany)' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: '# Contract\n\nThe parties agree...' })
  @IsString()
  @MinLength(1)
  bodyMd!: string;

  @ApiPropertyOptional({ default: true, description: 'Activate this version (deactivates others).' })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

export class ActivateLegalVersionDto {
  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  version!: number;
}
