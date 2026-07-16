import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

/**
 * Multipart body for `POST /reports/:id/photos/upload` (fields arrive as
 * strings — `position` is transformed). The binary itself is the `file` part.
 */
export class UploadPhotoDto {
  @ApiProperty({
    example: 'exterior-front',
    description:
      'Logical photo slot: exterior-front, exterior-back, wheel-fl, interior-1, ' +
      'odometer, vin, zeroproof, damage-<damageId>, extra, ...',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_-]{0,47}$/)
  kind!: string;

  @ApiPropertyOptional({ example: 0, description: 'Slot position for repeated kinds.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional({
    example: '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069',
    description:
      'SHA-256 of the ORIGINAL file bytes. Idempotency: re-uploading the same slot ' +
      'with the same hash is a no-op that returns the stored photo.',
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  @Matches(/^[a-f0-9]{64}$/i)
  hash?: string;
}

export class ReportPhotoDto {
  @ApiProperty({ example: 'ckxy9ab340001a8b8c2d4e6f8' })
  photoId!: string;

  @ApiProperty({ example: 'exterior-front' })
  kind!: string;

  @ApiProperty({ example: 0 })
  position!: number;

  @ApiProperty({ example: 'report-photos/<deviceId>/<reportId>/exterior-front-0-a1b2c3d4.jpg' })
  r2Key!: string;

  @ApiProperty({ example: 1920 })
  width!: number;

  @ApiProperty({ example: 1440 })
  height!: number;

  @ApiProperty({ example: 348211, description: 'Compressed size stored in R2.' })
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Public or presigned URL for the stored photo.' })
  url?: string;

  @ApiProperty({ example: false, description: 'True when this upload replaced an earlier photo in the slot.' })
  replaced!: boolean;

  @ApiProperty({ example: '2026-07-16T14:31:02.000Z' })
  createdAt!: string;
}

export class ReportPhotoListDto {
  @ApiProperty({ type: [ReportPhotoDto] })
  items!: ReportPhotoDto[];

  @ApiProperty({ example: 24 })
  total!: number;
}
