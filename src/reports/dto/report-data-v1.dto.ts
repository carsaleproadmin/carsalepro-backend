import {
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Structured inspection payload, contract version 1.
 *
 * Mirrors the mobile app's Drift schema (carsalepro-mobile
 * lib/data/local/database.dart) 1:1 so a report stored here can later
 * auto-fill a car-sale listing without ever parsing the PDF.
 *
 * Validation is deliberately LENIENT (service-level, `whitelist: false`):
 * unknown extra keys are allowed so newer mobile builds keep working against
 * an older backend. Money values inside this payload are plain EUR numbers —
 * a documented, contained deviation from the integer-cents rule (this JSON is
 * archival inspection data, never ledger input).
 */

export class ReportVehicleDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i)
  vin?: string;

  @IsOptional() @IsString() @MaxLength(64) make?: string;
  @IsOptional() @IsString() @MaxLength(64) model?: string;
  @IsOptional() @IsInt() @Min(1900) @Max(2100) year?: number;

  /** HU/TÜV validity (mobile free-text month field, e.g. "2027-06"). */
  @IsOptional() @IsString() @MaxLength(16) tuvDate?: string;

  /** Erstzulassung — first registration date. */
  @IsOptional() @IsISO8601() firstRegistration?: string;

  /** Standard-colour slug (e.g. "silver"); legacy rows may hold free text. */
  @IsOptional() @IsString() @MaxLength(64) colour?: string;

  @IsOptional() @IsString() @MaxLength(128) company?: string;
  @IsOptional() @IsString() @MaxLength(128) branch?: string;

  /** Responsible inspector display name. */
  @IsOptional() @IsString() @MaxLength(128) responsible?: string;

  // Optional listing-oriented attributes (decoded from VIN or entered later).
  @IsOptional() @IsString() @MaxLength(32) bodyType?: string;
  @IsOptional() @IsString() @MaxLength(32) driveType?: string;
  @IsOptional() @IsString() @MaxLength(32) fuelType?: string;
  @IsOptional() @IsString() @MaxLength(32) transmission?: string;
}

export class ReportOperationalDto {
  @IsOptional() @IsInt() @Min(0) @Max(3_000_000) mileageKm?: number;
  @IsOptional() @IsIn(['km', 'mi']) mileageUnit?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10) keysCount?: number;
  @IsOptional() @IsIn(['summer', 'winter', 'allseason']) tyreSeason?: string;
  @IsOptional() @IsBoolean() towHitch?: boolean;
  // Drivability tri-states (absent = not assessed)
  @IsOptional() @IsBoolean() engineStarts?: boolean;
  @IsOptional() @IsBoolean() drivesOk?: boolean;
  @IsOptional() @IsBoolean() brakesOk?: boolean;
  // Undercarriage tri-states
  @IsOptional() @IsBoolean() undercarriageRust?: boolean;
  @IsOptional() @IsBoolean() fluidLeaks?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ReportChecklistEntryDto {
  @IsInt() @Min(1) @Max(200) itemNumber!: number;
  @IsIn(['ok', 'defect', 'na']) state!: string;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

export class ReportWheelDto {
  @IsIn(['fl', 'fr', 'rl', 'rr']) corner!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(20) treadMm?: number;
  @IsOptional() @IsString() @MaxLength(8) dot?: string;
  @IsOptional() @IsIn(['steel', 'alloy']) rimType?: string;
  @IsOptional() @IsIn(['good', 'worn', 'damaged']) condition?: string;
  @IsOptional() @IsString() @MaxLength(32) sizeSpec?: string;
}

export class ReportDamageDto {
  /** Mobile-side damage row UUID — links damage photos (`damage-<id>` kinds). */
  @IsString() @MaxLength(64) id!: string;

  @IsOptional() @IsString() @MaxLength(64) partId?: string;
  @IsOptional() @IsString() @MaxLength(64) typeId?: string;
  @IsIn(['T1', 'T2', 'T3']) tier!: string;

  /** Origin K/S/T quick-code, if the damage came from the quick catalog. */
  @IsOptional() @IsString() @MaxLength(8) kstCode?: string;

  // Cost snapshot (plain EUR — see file header note).
  @IsOptional() @IsNumber() @Min(0) materialsEur?: number;
  @IsOptional() @IsNumber() @Min(0) hours?: number;
  @IsOptional() @IsNumber() @Min(0) hourlyRate?: number;
  @IsOptional() @IsNumber() @Min(0) manualCostEur?: number;

  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class ReportSignoffDto {
  @IsOptional() @IsBoolean() accidentFree?: boolean;
  @IsOptional() @IsBoolean() priorRepairs?: boolean;
  @IsOptional() @IsBoolean() structuralDamage?: boolean;
  @IsOptional() @IsBoolean() paintMeasured?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) accidentRemark?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  conditionTags?: string[];

  @IsOptional() @IsString() @MaxLength(16) huValidUntil?: string;
  @IsOptional() @IsBoolean() obdPerformed?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) obdResult?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;

  /** Diminished value (Minderwert), plain EUR. */
  @IsOptional() @IsNumber() @Min(0) minderwertEur?: number;
}

export class ReportScoresDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) qualityScore?: number;

  /** Free-form component breakdown (weights change between app versions). */
  @IsOptional() @IsObject() breakdown?: Record<string, unknown>;
}

export class ReportRecipientDto {
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsString() @MaxLength(254) email!: string;
}

export class ReportPhotoMetaDto {
  /** Slot key matching the multipart upload `kind` (exterior-front, wheel-fl, damage-<id>, ...). */
  @IsString() @MaxLength(64) kind!: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsISO8601() capturedAt?: string;
  @IsOptional() @IsInt() @Min(1) widthPx?: number;
  @IsOptional() @IsInt() @Min(1) heightPx?: number;
}

export class ReportMetaDto {
  @IsOptional() @IsString() @MaxLength(32) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(8) locale?: string;
  /** ISO country code used for labor-rate selection. */
  @IsOptional() @IsString() @MaxLength(4) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(32) catalogVersion?: string;
}

export class ReportDataV1Dto {
  @Equals(1) schemaVersion!: 1;

  @ValidateNested()
  @Type(() => ReportVehicleDto)
  vehicle!: ReportVehicleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportOperationalDto)
  operational?: ReportOperationalDto;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReportChecklistEntryDto)
  checklist!: ReportChecklistEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ReportWheelDto)
  wheels?: ReportWheelDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReportDamageDto)
  damages?: ReportDamageDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportSignoffDto)
  signoff?: ReportSignoffDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportScoresDto)
  scores?: ReportScoresDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReportRecipientDto)
  recipients?: ReportRecipientDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(150)
  @ValidateNested({ each: true })
  @Type(() => ReportPhotoMetaDto)
  photos?: ReportPhotoMetaDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportMetaDto)
  meta?: ReportMetaDto;
}
