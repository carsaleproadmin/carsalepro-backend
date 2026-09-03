import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { KYC_DOCUMENT_KINDS } from '../kyc.constants';

export class KycApplicantDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: 'inspector@example.com' })
  email!: string;

  @ApiProperty({ example: 'Max Mustermann', nullable: true })
  name!: string | null;
}

/** One queue entry (GET /admin/kyc). */
export class AdminKycQueueItemDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KycStatus, example: 'SUBMITTED' })
  status!: KycStatus;

  @ApiProperty({ type: KycApplicantDto })
  user!: KycApplicantDto;

  @ApiProperty({ enum: KYC_DOCUMENT_KINDS, isArray: true, example: ['id_front', 'id_back'] })
  documentKinds!: string[];

  @ApiProperty({ example: '2026-06-14T10:05:00.000Z', nullable: true })
  submittedAt!: string | null;

  @ApiProperty({ example: '2026-06-14T09:55:00.000Z' })
  createdAt!: string;

  /**
   * The admin's user id, or the literal `auto` when the platform approved the
   * application itself and nobody read the documents. Null while undecided.
   */
  @ApiProperty({
    example: 'auto',
    nullable: true,
    description: "Admin user id, or 'auto' when approved automatically with no human review.",
  })
  reviewedBy!: string | null;

  @ApiProperty({ example: '2026-06-14T11:00:00.000Z', nullable: true })
  reviewedAt!: string | null;
}

export class AdminKycQueueDto {
  @ApiProperty({ type: [AdminKycQueueItemDto] })
  items!: AdminKycQueueItemDto[];

  /**
   * How many rows match, before `limit` and `offset`.
   *
   * The list is now every approved inspector rather than the few applications
   * that wait for a decision, so a page of it says nothing about the size of
   * the set. Without this number a caller cannot tell a complete answer from a
   * truncated one, and an admin reading the screen cannot either.
   */
  @ApiProperty({ example: 137 })
  total!: number;
}

/** A document with a short-lived signed view URL (GET /admin/kyc/:id). */
export class AdminKycDocumentDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KYC_DOCUMENT_KINDS, example: 'id_front' })
  kind!: string;

  @ApiProperty({ example: '2026-06-14T10:00:00.000Z' })
  uploadedAt!: string;

  @ApiProperty({
    example: 'https://<account>.r2.cloudflarestorage.com/kyc/...?X-Amz-...',
    nullable: true,
    description: 'Short-lived signed view URL, or null when R2 is unconfigured / the doc was purged.',
  })
  viewUrl!: string | null;

  @ApiProperty({ example: '2026-06-14T11:00:00.000Z', nullable: true })
  viewUrlExpiresAt!: string | null;
}

/** Full application detail for an admin reviewer (GET /admin/kyc/:id). */
export class AdminKycApplicationDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KycStatus, example: 'IN_REVIEW' })
  status!: KycStatus;

  @ApiProperty({ type: KycApplicantDto })
  user!: KycApplicantDto;

  @ApiProperty({ type: [AdminKycDocumentDto] })
  documents!: AdminKycDocumentDto[];

  @ApiPropertyOptional({ example: null, nullable: true })
  rejectReason!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  reviewedBy!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  reviewedAt!: string | null;

  @ApiProperty({ example: '2026-06-14T10:05:00.000Z', nullable: true })
  submittedAt!: string | null;

  @ApiProperty({ example: '2026-06-14T09:55:00.000Z' })
  createdAt!: string;
}

/** Response of approve/reject. */
export class AdminKycDecisionDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ enum: KycStatus, example: 'APPROVED' })
  status!: KycStatus;

  @ApiProperty({ example: '2026-06-14T11:00:00.000Z' })
  reviewedAt!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  rejectReason?: string | null;
}
