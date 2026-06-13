import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

export const PHOTO_KINDS = [
  'front',
  'left',
  'back',
  'right',
  'roof',
  'interior',
  'odometer',
  'vin_plate',
  'wheel',
  'extra',
] as const;

export type PhotoKind = (typeof PHOTO_KINDS)[number];

export class CreatePhotoUploadDto {
  @ApiProperty({
    enum: PHOTO_KINDS,
    example: 'front',
    description: 'Which photo slot this upload fills.',
  })
  @IsString()
  @IsIn(PHOTO_KINDS)
  kind!: PhotoKind;
}

export class CreatePhotoUploadResponseDto {
  @ApiProperty({
    example:
      'https://<account>.r2.cloudflarestorage.com/carsalepro-reports/report-photos/<reportId>/front-<uuid>.jpg?X-Amz-Signature=...',
  })
  presignedUploadUrl!: string;

  @ApiProperty({ example: 'report-photos/<reportId>/front-<uuid>.jpg' })
  s3Key!: string;

  @ApiProperty({ example: '2026-06-13T10:15:00.000Z' })
  expiresAt!: string;
}
