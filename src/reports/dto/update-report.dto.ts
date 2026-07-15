import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Re-sync of an already-created report (finished report edited on the device).
 * Idempotent, NEVER consumes quota. All fields optional — only provided
 * fields are written.
 */
export class UpdateReportDto {
  @ApiPropertyOptional({ example: '1HGBH41JXMN109186', minLength: 17, maxLength: 17 })
  @IsOptional()
  @IsString()
  @Length(17, 17)
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i)
  vin?: string;

  @ApiPropertyOptional({ example: 'BMW' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  make?: string;

  @ApiPropertyOptional({ example: '320d' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @ApiPropertyOptional({ example: 2018, minimum: 1900, maximum: 2100 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 120000, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  mileageKm?: number;

  @ApiPropertyOptional({ example: 'Black' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  color?: string;

  @ApiPropertyOptional({ example: 'sedan' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  bodyType?: string;

  @ApiPropertyOptional({ example: 'awd' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  driveType?: string;

  @ApiPropertyOptional({ example: 87, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  qualityScore?: number;

  @ApiPropertyOptional({ example: '2026-07-16T10:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  inspectedAt?: string;

  @ApiPropertyOptional({ example: '2026-07-16T14:30:00.000Z' })
  @IsOptional()
  @IsISO8601()
  finishedAt?: string;

  @ApiPropertyOptional({ example: 1834217, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  sizeBytes?: number;

  @ApiPropertyOptional({ example: '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069' })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  @Matches(/^[a-f0-9]{64}$/i)
  hash?: string;

  @ApiPropertyOptional({ example: 1, description: 'Contract version of reportData (1 = validated).' })
  @IsOptional()
  @IsIn([1])
  reportSchemaVersion?: number;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  reportData?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: true,
    description:
      'When true, a fresh presigned PUT URL for the (same) PDF key is returned and ' +
      'the report is marked not-uploaded until POST /reports/:id/complete re-verifies.',
  })
  @IsOptional()
  @IsBoolean()
  regeneratePdfUploadUrl?: boolean;
}

export class UpdateReportResponseDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  reportId!: string;

  @ApiProperty({ example: 'CSP-67e5a3d2-9c41-4b7e-8f2a-1d3c5e7a9b0f' })
  code!: string;

  @ApiProperty({ example: '2026-07-16T14:31:02.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({
    description: 'Present only when regeneratePdfUploadUrl was true.',
  })
  presignedUploadUrl?: string;

  @ApiPropertyOptional({ example: '2026-07-16T14:46:02.000Z' })
  expiresAt?: string;
}
