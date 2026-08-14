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
 *
 * Array caps are sized for the WORST realistic report, never for the average
 * one: hitting a cap throws 400 `invalid_report_data`, which blocks the mobile
 * Finish flow entirely. Raise a cap before it can bite.
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

  /** Tyre make as printed on the sidewall (Michelin, Continental, ...). */
  @IsOptional() @IsString() @MaxLength(48) tyreBrand?: string;

  /**
   * Tyre season, PER WHEEL since the 2026-08-14 app release.
   *
   * `ReportOperationalDto.tyreSeason` still carries the whole-vehicle value and
   * is still populated by the app when all four wheels agree — a car can
   * legitimately run winter tyres on the driven axle only, which the single
   * value could not express.
   */
  @IsOptional()
  @IsIn(['summer', 'winter', 'allseason'])
  tyreSeason?: string;
}

export class ReportDamageDto {
  /** Mobile-side damage row UUID — links damage photos (`damage-<id>` kinds). */
  @IsString() @MaxLength(64) id!: string;

  @IsOptional() @IsString() @MaxLength(64) partId?: string;
  @IsOptional() @IsString() @MaxLength(64) typeId?: string;

  /** How the damage gets repaired — catalog `repairMethods` id (2026-08-14). */
  @IsOptional() @IsString() @MaxLength(64) repairMethodId?: string;

  @IsIn(['T1', 'T2', 'T3']) tier!: string;

  /** Origin K/S/T quick-code, if the damage came from the quick catalog. */
  @IsOptional() @IsString() @MaxLength(8) kstCode?: string;

  /**
   * The inspector typed the three fields instead of picking them.
   *
   * The id fields above are NOT cleared when this is set — the app keeps both
   * sides so a mis-tap destroys nothing — so this flag is what says which side
   * a reader should believe.
   */
  @IsOptional() @IsBoolean() manualEntry?: boolean;
  @IsOptional() @IsString() @MaxLength(500) manualPart?: string;
  @IsOptional() @IsString() @MaxLength(500) manualDamage?: string;
  @IsOptional() @IsString() @MaxLength(500) manualRepair?: string;

  /** Which price the replacement part was quoted at. */
  @IsOptional()
  @IsIn(['none', 'newAftermarket', 'newOem', 'used'])
  partCondition?: string;

  // Cost snapshot (plain EUR — see file header note). Two generations coexist
  // and both are stored verbatim: `materialsEur`/`hours` come from the engine
  // the app shipped before 2026-08-14, the rest from the one after it.
  @IsOptional() @IsNumber() @Min(0) materialsEur?: number;
  @IsOptional() @IsNumber() @Min(0) hours?: number;
  @IsOptional() @IsNumber() @Min(0) hourlyRate?: number;
  @IsOptional() @IsNumber() @Min(0) partsEur?: number;
  @IsOptional() @IsNumber() @Min(0) riHours?: number;
  @IsOptional() @IsNumber() @Min(0) paintHours?: number;
  @IsOptional() @IsNumber() @Min(0) straightHours?: number;
  @IsOptional() @IsNumber() @Min(0) otherHours?: number;
  @IsOptional() @IsNumber() @Min(0) labourEur?: number;
  @IsOptional() @IsNumber() @Min(0) consumablesEur?: number;

  /**
   * The engine's own line total before any manual override.
   *
   * Prefer this over recomputing: the website re-implemented the line formula
   * and read a field name that never existed on the wire, so its materials
   * component was silently zero for a year.
   */
  @IsOptional() @IsNumber() @Min(0) estimateEur?: number;

  @IsOptional() @IsNumber() @Min(0) vehicleClassFactor?: number;
  @IsOptional() @IsInt() @Min(1) costDataVersion?: number;
  @IsOptional() @IsNumber() @Min(0) manualCostEur?: number;

  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/**
 * One guided paint-thickness (Lackdicke) reading.
 *
 * `panelId` is a catalog `thicknessPanels[].id` (13 stations) or an
 * `extra_`-prefixed id for an ad-hoc measurement the inspector added — the
 * `extra_` prefix is RESERVED for those (see `catalog.data.ts`). `label` is the
 * denormalized display name so the website/PDF never needs the catalog.
 */
export class ReportThicknessPanelDto {
  @IsString() @MaxLength(48) panelId!: string;

  /** Measured coating thickness in micrometres (µm); absent = not measured. */
  @IsOptional() @IsNumber() @Min(0) @Max(5000) um?: number;

  @IsOptional() @IsString() @MaxLength(120) label?: string;
}

/**
 * Paint-thickness block. `panels` is required inside `thickness` — emit `[]`
 * (or omit the whole `thickness` object) when nothing was measured.
 */
export class ReportThicknessDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ReportThicknessPanelDto)
  panels!: ReportThicknessPanelDto[];

  /** Median of the measured panels (µm), computed on the device. */
  @IsOptional() @IsNumber() @Min(0) @Max(5000) medianUm?: number;
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

  /** Optional per-photo comment, printed under the photo in the PDF. */
  @IsOptional() @IsString() @MaxLength(200) caption?: string;
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

  /**
   * Cap 200: the defect catalog alone can contribute up to 98 C-coded damages
   * and the inspector adds free ones on top (hail cars, multi-panel repaints).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReportDamageDto)
  damages?: ReportDamageDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportThicknessDto)
  thickness?: ReportThicknessDto;

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

  /**
   * Cap 300: a thorough report now carries ~8 exterior + unlimited exterior
   * extras + 12 interior + 13 thickness stations + 2 calibration shots + 4
   * wheels + odometer/VIN/zero-proof + several photos per damage (~100–120
   * slots typical). 150 was within reach and a 400 here blocks Finish.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ReportPhotoMetaDto)
  photos?: ReportPhotoMetaDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReportMetaDto)
  meta?: ReportMetaDto;
}
