import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { KYC_DOCUMENT_KINDS } from '../kyc.constants';

/** Inspector-facing document view — kind + uploadedAt only, never the raw s3Key. */
export class KycDocumentSummaryDto {
  @ApiProperty({ enum: KYC_DOCUMENT_KINDS, example: 'id_front' })
  kind!: string;

  @ApiProperty({ example: '2026-06-14T10:00:00.000Z' })
  uploadedAt!: string;
}

/** Inspector-facing application view (POST /applications, GET /applications/me). */
export class KycApplicationDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KycStatus, example: 'DRAFT' })
  status!: KycStatus;

  @ApiProperty({ type: [KycDocumentSummaryDto] })
  documents!: KycDocumentSummaryDto[];

  @ApiPropertyOptional({ example: 'ID photo is blurry.', nullable: true })
  rejectReason?: string | null;

  @ApiPropertyOptional({ example: '2026-06-14T10:05:00.000Z', nullable: true })
  submittedAt?: string | null;

  @ApiPropertyOptional({ example: '2026-06-14T11:00:00.000Z', nullable: true })
  reviewedAt?: string | null;

  @ApiProperty({ example: '2026-06-14T09:55:00.000Z' })
  createdAt!: string;
}

/** Response of POST /applications/:id/documents. */
export class PresignDocumentResultDto {
  @ApiPropertyOptional({
    example: 'https://<account>.r2.cloudflarestorage.com/kyc/...',
    description: 'Presigned PUT URL. Absent (and a 503 is returned) when R2 is unconfigured.',
  })
  presignedUploadUrl?: string;

  @ApiProperty({ example: 'kyc/<userId>/<applicationId>/id_front-<uuid>.bin' })
  s3Key!: string;

  @ApiProperty({ enum: KYC_DOCUMENT_KINDS, example: 'id_front' })
  kind!: string;

  @ApiPropertyOptional({ example: '2026-06-14T10:15:00.000Z' })
  expiresAt?: string;
}

/** Response of POST /applications/:id/submit. */
export class SubmitKycResultDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KycStatus, example: 'SUBMITTED' })
  status!: KycStatus;

  @ApiProperty({ example: '2026-06-14T10:05:00.000Z' })
  submittedAt!: string;
}
