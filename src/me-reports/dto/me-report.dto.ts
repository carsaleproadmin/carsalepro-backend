import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MeReportItemDto {
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

  @ApiPropertyOptional({ example: 2018 })
  year?: number | null;

  @ApiPropertyOptional({ example: 120000 })
  mileageKm?: number | null;

  @ApiPropertyOptional({ example: 'Black' })
  color?: string | null;

  @ApiPropertyOptional({ example: 'sedan' })
  bodyType?: string | null;

  @ApiPropertyOptional({ example: 'awd' })
  driveType?: string | null;

  @ApiPropertyOptional({ example: 87 })
  qualityScore?: number | null;

  @ApiProperty({ enum: ['free', 'pro'], example: 'pro' })
  tier!: 'free' | 'pro';

  @ApiProperty({ example: true })
  uploaded!: boolean;

  @ApiPropertyOptional({ example: '2026-06-03T10:00:00.000Z' })
  inspectedAt?: string | null;

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({ description: 'Presigned download URL (only when uploaded and R2 configured).' })
  downloadUrl?: string;

  @ApiPropertyOptional({ example: '2026-06-13T11:00:00.000Z' })
  downloadUrlExpiresAt?: string;
}

export class MeReportListDto {
  @ApiProperty({ type: [MeReportItemDto] })
  items!: MeReportItemDto[];

  @ApiProperty({ example: 3 })
  total!: number;
}
