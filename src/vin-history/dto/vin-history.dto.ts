import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

/**
 * ISO 3779 VIN: 17 characters, and I/O/Q are excluded because they are
 * confusable with 1/0. Validated in the route parameter so a malformed VIN is a
 * 400 and never reaches the provider or the throttled lookup path.
 */
export class VinParamDto {
  @ApiProperty({ example: 'WAUZZZ8V8MA012345' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, {
    message: 'vin must be 17 characters, excluding I, O and Q',
  })
  vin!: string;
}

/** `pdf` is the document a buyer means by "download"; `json` is the raw payload. */
export type VinCheckDownloadFormat = 'pdf' | 'json';

export class VinCheckDownloadQueryDto {
  @ApiPropertyOptional({
    enum: ['pdf', 'json'],
    default: 'pdf',
    description: 'Defaults to the rendered PDF report. `json` returns the archived payload.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(['pdf', 'json'])
  format?: VinCheckDownloadFormat;
}

/**
 * The FREE preview. Counts and booleans only.
 *
 * There is deliberately not a single date, plate, place name or free-text
 * description in this shape. Those are the parts a buyer pays for, and a
 * preview that leaked "accident on 2019-04-12 in Poland" would both give the
 * product away and republish provider data we are licensed to sell, not
 * broadcast. `countriesCount` rather than the country list is the same rule:
 * knowing a car has lived in three countries is a teaser, knowing WHICH three
 * is the answer.
 *
 * **`null` is not `0`.** The five per-array counters are nullable because a
 * provider may hold records it does not count for free. `0` says "we looked,
 * there are none"; `null` says "we are not telling you before you pay". A
 * client must render them differently — "0 accidents" is a claim about the car,
 * and making it out of missing data is the worst thing this page could do.
 */
export class VinHistoryPreviewSummaryDto {
  @ApiProperty({ example: 23 }) recordCount!: number;
  @ApiProperty({ example: 2 }) ownersCount!: number;
  @ApiProperty({ example: 2, description: 'How many countries — never which ones.' })
  countriesCount!: number;

  @ApiProperty({ example: 14, nullable: true, description: 'null = not published, NOT zero.' })
  mileageRecordCount!: number | null;

  @ApiProperty({ example: 1, nullable: true, description: 'null = not published, NOT zero.' })
  damageRecordCount!: number | null;

  @ApiProperty({ example: 2, nullable: true, description: 'null = not published, NOT zero.' })
  registrationCount!: number | null;

  @ApiProperty({ example: 1, nullable: true, description: 'null = not published, NOT zero.' })
  recallCount!: number | null;

  @ApiProperty({ example: 5, nullable: true, description: 'null = not published, NOT zero.' })
  inspectionCount!: number | null;

  @ApiProperty({ example: true }) hasAccidentRecords!: boolean;
  @ApiProperty({ example: false }) hasSalvageOrTotalLoss!: boolean;
  @ApiProperty({ example: false }) hasOdometerRollback!: boolean;
  @ApiProperty({ example: false }) hasStolenRecord!: boolean;
  @ApiProperty({ example: true }) hasOpenRecalls!: boolean;
  @ApiProperty({ example: 184000, nullable: true }) lastRecordedMileageKm!: number | null;
}

export class VinHistoryPreviewDto {
  @ApiProperty({ example: 'WAUZZZ8V8MA012345' }) vin!: string;
  @ApiProperty({ example: 'mock' }) provider!: string;

  @ApiProperty({
    example: true,
    description: 'TRUE when the data is generated, not sourced. Show it to the user.',
  })
  synthetic!: boolean;

  @ApiProperty({
    example: true,
    description: 'False when no provider can serve a PAID unlock right now.',
  })
  purchasable!: boolean;

  @ApiProperty({ type: VinHistoryPreviewSummaryDto })
  summary!: VinHistoryPreviewSummaryDto;

  @ApiProperty({ example: 1999, description: 'What the full history costs, integer cents.' })
  priceCents!: number;

  @ApiProperty({ example: 'EUR' }) currency!: string;

  @ApiProperty({ example: 30, description: 'How long a purchased history stays reusable.' })
  cacheDays!: number;
}

export class VinHistoryUnlockDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' }) purchaseId!: string;
  @ApiProperty({ example: 'ready', enum: ['pending', 'ready'] }) status!: string;
  @ApiProperty({ example: 1999 }) amountCents!: number;
  @ApiProperty({ example: 'EUR' }) currency!: string;

  @ApiPropertyOptional({ example: true, description: 'The caller already owned it; nothing charged.' })
  alreadyOwned?: boolean;

  @ApiPropertyOptional({ description: 'Redirect the buyer here to pay.' })
  checkoutUrl?: string;

  @ApiPropertyOptional({ example: true, description: 'Stripe unconfigured — settled locally.' })
  mock?: boolean;
}

export class VinCheckItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'WAUZZZ8V8MA012345' }) vin!: string;
  @ApiProperty({ example: 'ready', enum: ['pending', 'ready', 'failed', 'refunded'] })
  status!: string;
  @ApiProperty({ example: 'mock', nullable: true }) provider!: string | null;
  @ApiProperty({ example: false }) synthetic!: boolean;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true }) readyAt!: string | null;
  @ApiProperty({ nullable: true, description: 'When the cached report needs a refetch.' })
  expiresAt!: string | null;
}

export class VinCheckListDto {
  @ApiProperty({ type: [VinCheckItemDto] }) items!: VinCheckItemDto[];
}

export class VinCheckDetailDto extends VinCheckItemDto {
  @ApiProperty({
    description: 'The full VinHistoryPayloadV1. Null while the purchase is not ready.',
    nullable: true,
  })
  payload!: unknown;

  @ApiProperty({
    nullable: true,
    description: 'Locale of the rendered PDF, or null when none has been rendered yet.',
    example: 'de',
  })
  pdfLocale!: string | null;
}

export class VinCheckDownloadDto {
  @ApiProperty({ description: 'Short-lived PRIVATE signed URL — never a public R2 URL.' })
  url!: string;

  @ApiProperty() expiresAt!: string;

  @ApiProperty({ example: 'application/pdf', enum: ['application/pdf', 'application/json'] })
  contentType!: string;

  @ApiProperty({ example: 'pdf', enum: ['pdf', 'json'] })
  format!: VinCheckDownloadFormat;

  @ApiProperty({
    example: 'carsalepro-vin-history-WAUZZZ8V8MA012345.pdf',
    description: 'What the browser will save the file as (RFC 6266 on the signed URL).',
  })
  filename!: string;
}
