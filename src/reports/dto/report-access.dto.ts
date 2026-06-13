import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FullReportVehicleDto {
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
  @ApiPropertyOptional({ example: 'rwd' })
  driveType?: string | null;
}

export class FullReportPhotoDto {
  @ApiProperty({ example: 'https://cdn.example.com/report-photos/abc/front.jpg' })
  url!: string;
  @ApiPropertyOptional({ example: 'exterior' })
  kind?: string;
  @ApiPropertyOptional({ example: 'front' })
  angle?: string;
}

export class FullReportPdfDto {
  @ApiPropertyOptional({
    example: 'https://cdn.example.com/free/dev/report.pdf',
    description: 'Signed PDF download URL (null when R2 is unconfigured or not uploaded).',
  })
  downloadUrl!: string | null;

  @ApiPropertyOptional({ example: '2026-06-13T11:00:00.000Z' })
  expiresAt!: string | null;
}

export class FullReportDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: 'CSP-042' })
  code!: string;

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({ example: 87 })
  qualityScore!: number | null;

  @ApiProperty({ enum: ['free', 'pro'], example: 'pro' })
  tier!: 'free' | 'pro';

  @ApiProperty({ type: FullReportVehicleDto })
  vehicle!: FullReportVehicleDto;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  reportData!: Record<string, unknown> | null;

  @ApiProperty({ type: [FullReportPhotoDto] })
  photos!: FullReportPhotoDto[];

  @ApiProperty({ type: FullReportPdfDto })
  pdf!: FullReportPdfDto;
}

export class ReportDownloadDto {
  @ApiProperty({ example: 'https://cdn.example.com/free/dev/report.pdf' })
  signedUrl!: string;

  @ApiProperty({ example: '2026-06-13T11:00:00.000Z' })
  expiresAt!: string;
}
