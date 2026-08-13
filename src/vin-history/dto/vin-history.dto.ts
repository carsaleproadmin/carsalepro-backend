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

/**
 * Which car the visitor typed, from the FREE decode.
 *
 * Costs nothing: the decode is cached in Postgres and is the same one the mobile
 * app has always used. It exists because the preview showed eight counters
 * against a bare seventeen-character string and never named the car — the one
 * thing that tells a visitor they typed the VIN correctly.
 *
 * Every field is individually nullable. The decoder is US-centric and answers
 * less for a European VIN, and a field it does not know is omitted rather than
 * printed empty.
 */
export class VinHistoryVehicleDto {
  @ApiProperty({ example: 'BMW', nullable: true }) make!: string | null;
  @ApiProperty({ example: '535i', nullable: true }) model!: string | null;
  @ApiProperty({ example: 2012, nullable: true }) modelYear!: number | null;
  @ApiProperty({ example: 'Sedan/Saloon', nullable: true }) bodyClass!: string | null;
  @ApiProperty({ example: 'Gasoline', nullable: true }) fuelType!: string | null;
  @ApiProperty({ example: 'GERMANY', nullable: true }) plantCountry!: string | null;
}

/**
 * Whether the history source can hold anything for this VIN at all.
 *
 * - `supported`   — worth offering. The paid button appears.
 * - `not_covered` — a real car the source does not cover. We say so and offer an
 *   inspection instead; no payment is possible.
 * - `invalid_vin` — not a VIN.
 * - `no_records`  — we already looked, at our own expense, and there was nothing.
 *   Remembered for a short window so the same VIN cannot bill us again.
 *
 * The last two are refusals a visitor should read differently: one is "check
 * what you typed", the other is "this car has no history on file".
 */
export type VinHistoryCoverageState =
  | 'supported'
  | 'not_covered'
  | 'invalid_vin'
  | 'no_records';

export class VinHistoryPreviewDto {
  @ApiProperty({ example: 'WAUZZZ8V8MA012345' }) vin!: string;

  @ApiProperty({
    example: true,
    description: 'TRUE when the data is generated, not sourced. Show it to the user.',
  })
  synthetic!: boolean;

  @ApiProperty({
    example: true,
    description:
      'False when no provider can serve a PAID unlock right now, OR when the source cannot ' +
      'cover this VIN. Read `coverage` for which.',
  })
  purchasable!: boolean;

  @ApiProperty({
    enum: ['supported', 'not_covered', 'invalid_vin', 'no_records'],
    description: 'Why the paid report is or is not on offer.',
  })
  coverage!: VinHistoryCoverageState;

  @ApiProperty({
    type: VinHistoryVehicleDto,
    nullable: true,
    description: 'Which car this is, from the free decode. Null when it cannot be decoded.',
  })
  vehicle!: VinHistoryVehicleDto | null;

  @ApiProperty({
    example: false,
    description:
      'TRUE when the counters below were actually measured — from a warm cache, or from a ' +
      'provider that offers a free probe. FALSE means NOTHING was counted and `summary` is ' +
      'null: do not render zeros, and do not imply the car is clean.',
  })
  probed!: boolean;

  @ApiProperty({
    type: VinHistoryPreviewSummaryDto,
    nullable: true,
    description:
      'Null when `probed` is false. The active provider bills per lookup and has no free ' +
      'probe, so before a purchase there is genuinely nothing to count.',
  })
  summary!: VinHistoryPreviewSummaryDto | null;

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
    description:
      'The full payload — VinHistoryPayloadV1 or V2, branch on `schemaVersion`. Null while ' +
      'the purchase is not ready.',
    nullable: true,
  })
  payload!: unknown;

  @ApiProperty({
    nullable: true,
    description: 'Locale of the rendered PDF, or null when none has been rendered yet.',
    example: 'de',
  })
  pdfLocale!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The public share link, or null when the report is not shared. Present only on the ' +
      "owner's own view — the public route never echoes it back.",
  })
  shareUrl!: string | null;

  @ApiProperty({ nullable: true, description: 'When the current link was minted.' })
  sharedAt!: string | null;
}

/**
 * The answer to minting or revoking a share link.
 *
 * `shareUrl` is null after a revoke. Returning the whole state rather than just
 * the new token means a caller never has to reconstruct the URL, and the origin
 * stays a server-side fact.
 */
export class VinCheckShareDto {
  @ApiProperty({ nullable: true, example: 'https://www.carsalepro.de/vin-report/3f9a…' })
  shareUrl!: string | null;

  @ApiProperty({ nullable: true }) sharedAt!: string | null;
}

/**
 * A shared report as an anonymous reader sees it.
 *
 * Deliberately NOT `VinCheckDetailDto`: that shape carries the purchase id, the
 * buyer's failure reasons and the share token itself, none of which belong to
 * whoever was handed the link. What is published is the vehicle history and the
 * date it was taken — the report, not the transaction.
 */
export class PublicVinReportDto {
  @ApiProperty({ example: 'WAUZZZ8V8MA012345' }) vin!: string;
  @ApiProperty({ example: false }) synthetic!: boolean;

  @ApiProperty({ description: 'VinHistoryPayloadV1 or V2 — branch on `schemaVersion`.' })
  payload!: unknown;

  @ApiProperty({ description: 'When the buyer\'s snapshot was taken. The age of this data.' })
  reportedAt!: string;
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
