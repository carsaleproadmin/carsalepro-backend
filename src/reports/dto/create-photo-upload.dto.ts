import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

/**
 * LEGACY, and deliberately NOT derived from the reference catalog.
 *
 * These are the slot names of the pre-v2 presigned upload route
 * (`POST /reports/:id/photos`), which writes an object to R2 and creates
 * neither a `ReportPhoto` row nor a `photosManifest` entry. A photo uploaded
 * there is invisible to the showroom, the report view, the public-bucket mirror
 * and the quality score.
 *
 * So adding the catalog's angle ids here — `exterior-diag_front_left` and the
 * other 16 — would advertise slots that silently go nowhere, which is strictly
 * worse than today's 400. The shipped Flutter app uses the multipart route
 * (`POST /reports/:id/photos/upload`) exclusively. Leave this list alone; if
 * the legacy route is ever removed, remove this with it.
 */
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
