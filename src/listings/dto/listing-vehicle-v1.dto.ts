import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ReportDamageDto,
  ReportOperationalDto,
  ReportThicknessDto,
  ReportVehicleDto,
  ReportWheelDto,
} from '../../reports/dto/report-data-v1.dto';

/**
 * Seller-declared vehicle payload for a MANUAL listing (no inspection), v1.
 *
 * Every shared block is the INSPECTOR's own DTO, imported unchanged from
 * `reports/dto/report-data-v1.dto.ts`. A seller-declared BMW and an
 * inspector-recorded BMW therefore serialise identically, which is the whole
 * point: the two contracts cannot drift, and a manual listing can be upgraded
 * to an inspected one later without a data migration.
 *
 * What is deliberately NOT here, and why:
 *   - `scores`   — a quality score is DERIVED from an inspection. There is no
 *                  honest way for a seller to assert one, so the field does not
 *                  exist and `qualityScore` stays null for manual listings.
 *   - `signoff`  — an inspector's legal sign-off ("accident-free", "structural
 *                  damage"). A seller's opinion of the same facts belongs in
 *                  {@link ListingSelfDeclarationDto}, clearly labelled as a claim.
 *   - damage COSTS (`materialsEur`, `hours`, `hourlyRate`, `manualCostEur`) —
 *                  AW/AZT repair estimation is a trained discipline and the
 *                  seller is the one party with a motive to understate it. The
 *                  fields ride along on the reused `ReportDamageDto`, so they
 *                  are stripped server-side (see `sanitizeVehicleData`) rather
 *                  than rejected: a client may legitimately be replaying a
 *                  payload it read from elsewhere.
 *
 * Every field is optional, including `schemaVersion`. The same class validates
 * both `POST /listings/manual` (a first draft is allowed to be almost empty)
 * and `PATCH /listings/:id` (a sparse patch). Completeness is enforced once, at
 * publish time, where it can produce an actionable `missing[]`.
 */

/** ReportVehicleDto plus the attributes an inspection never records. */
export class ListingVehicleDeclaredDto extends ReportVehicleDto {
  /** Engine power in kW (Leistung) — a listing filter, not an inspection value. */
  @ApiPropertyOptional({ example: 140 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  powerKw?: number;
}

/** On-board-diagnostics self-check. */
export class ListingDiagnosticsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  obdPerformed?: boolean;

  @ApiPropertyOptional({ example: 'No stored fault codes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  obdResult?: string;
}

/**
 * The seller's own claims about the car. Named "self declaration" everywhere in
 * the API so no surface can present it as a verified finding.
 */
export class ListingSelfDeclarationDto {
  @ApiPropertyOptional({ example: true, description: 'Seller CLAIMS the car is accident-free.' })
  @IsOptional()
  @IsBoolean()
  accidentFreeClaimed?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  serviceHistoryComplete?: boolean;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  ownersCount?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  importedVehicle?: boolean;

  @ApiPropertyOptional({ example: ['non_smoker', 'garage_kept'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  conditionTags?: string[];

  @ApiPropertyOptional({ example: 'Two sets of wheels included.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string;
}

export class ListingVehicleV1Dto {
  @ApiPropertyOptional({ example: 1, description: 'Contract version. Defaults to 1 when omitted.' })
  @IsOptional()
  @Equals(1)
  schemaVersion?: 1;

  @ApiPropertyOptional({ type: ListingVehicleDeclaredDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingVehicleDeclaredDto)
  vehicle?: ListingVehicleDeclaredDto;

  @ApiPropertyOptional({ type: ReportOperationalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportOperationalDto)
  operational?: ReportOperationalDto;

  @ApiPropertyOptional({ type: [ReportWheelDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ReportWheelDto)
  wheels?: ReportWheelDto[];

  /**
   * Cap 50, not the report's 200. A seller listing a car itemises the dents a
   * buyer can see; 200 entries is a hail-damage inspection, which is exactly
   * the case that needs a real inspector.
   */
  @ApiPropertyOptional({ type: [ReportDamageDto], description: 'Max 50. Cost fields are stripped.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReportDamageDto)
  damages?: ReportDamageDto[];

  @ApiPropertyOptional({ type: ReportThicknessDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportThicknessDto)
  thickness?: ReportThicknessDto;

  @ApiPropertyOptional({ type: ListingDiagnosticsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDiagnosticsDto)
  diagnostics?: ListingDiagnosticsDto;

  @ApiPropertyOptional({ type: ListingSelfDeclarationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingSelfDeclarationDto)
  selfDeclaration?: ListingSelfDeclarationDto;
}
