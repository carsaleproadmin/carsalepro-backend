import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateReportResponseDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  reportId!: string;

  @ApiProperty({ example: 'free/<deviceId>/<reportId>.pdf' })
  s3Key!: string;

  @ApiProperty({
    example:
      'https://<account>.r2.cloudflarestorage.com/carsalepro-reports/free/.../...pdf?X-Amz-Signature=...',
  })
  presignedUploadUrl!: string;

  @ApiProperty({ example: '2026-05-15T17:42:00.000Z' })
  expiresAt!: string;

  @ApiProperty({ enum: ['free', 'pro'], example: 'free' })
  tier!: 'free' | 'pro';
}

export class ReportItemDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: 'CSP-042' })
  code!: string;

  @ApiPropertyOptional({ example: '1HGBH41JXMN109186' })
  vin?: string | null;

  @ApiPropertyOptional({ example: 'BMW' })
  make?: string | null;

  @ApiPropertyOptional({ example: '320d' })
  model?: string | null;

  @ApiPropertyOptional({ example: '2026-06-03T10:00:00.000Z' })
  inspectedAt?: string | null;

  @ApiProperty({ enum: ['free', 'pro'], example: 'free' })
  tier!: 'free' | 'pro';

  @ApiPropertyOptional({ example: 1834217 })
  sizeBytes?: number | null;

  @ApiProperty({ example: true })
  uploaded!: boolean;

  @ApiProperty({ example: '2026-05-15T17:42:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({
    description: 'Presigned download URL (only present when the object has been confirmed uploaded).',
    example: 'https://<account>.r2.cloudflarestorage.com/.../<key>?X-Amz-Signature=...',
  })
  downloadUrl?: string;

  @ApiPropertyOptional({ example: '2026-05-15T18:42:00.000Z' })
  downloadUrlExpiresAt?: string;
}

export class ReportListDto {
  @ApiProperty({ type: [ReportItemDto] })
  items!: ReportItemDto[];

  @ApiProperty({ example: 3 })
  total!: number;
}

export class CompleteReportResponseDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: true })
  uploaded!: boolean;
}
