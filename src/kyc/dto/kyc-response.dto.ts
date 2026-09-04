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

/**
 * Response of POST /applications/:id/documents/upload.
 *
 * Deliberately says nothing about WHERE the object went. The s3Key and the
 * bucket are server-side facts; the presign DTO this replaces had to leak the
 * key (the browser needed it) and that key was the one piece of the KYC store
 * a client should never hold.
 */
export class KycDocumentUploadResultDto {
  @ApiProperty({ enum: KYC_DOCUMENT_KINDS, example: 'id_front' })
  kind!: string;

  @ApiProperty({ example: '2026-06-14T10:00:00.000Z' })
  uploadedAt!: string;

  @ApiProperty({
    example: 'image/jpeg',
    description: 'What the object was STORED as. Images are re-encoded to JPEG; PDFs are kept.',
  })
  contentType!: string;

  @ApiProperty({ example: 412_338, description: 'Bytes stored, after compression.' })
  sizeBytes!: number;

  @ApiProperty({ example: 3_918_221, description: 'Bytes received from the client.' })
  sourceBytes!: number;

  @ApiProperty({
    example: false,
    description: 'True when this upload replaced an earlier document of the same kind.',
  })
  replaced!: boolean;
}

/**
 * Response of POST /applications/:id/submit.
 *
 * The status is the ANSWER TO A QUESTION THE CALLER MUST ASK: an application
 * gets one of two outcomes, and a client that assumes one of them shows the
 * wrong thing to half its users.
 */
export class SubmitKycResultDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({
    enum: KycStatus,
    example: 'APPROVED',
    description:
      'APPROVED when the platform approved the application itself, which is the usual answer. ' +
      'SUBMITTED when the applicant was rejected before: that application waits for an admin, ' +
      'and the user is NOT verified by it (DEN-239).',
  })
  status!: KycStatus;

  @ApiProperty({ example: '2026-06-14T10:05:00.000Z' })
  submittedAt!: string;
}
