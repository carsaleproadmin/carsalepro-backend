import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  Equals,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
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

/** Vehicle categories. The website form offers the same list. */
export const LISTING_VEHICLE_TYPES = [
  'passenger',
  'moto',
  'truck',
  'trailer',
  'special',
  'agricultural',
  'bus',
  'water',
  'air',
  'motorhome',
] as const;

/**
 * Optional equipment, as on the auto.ria add form. Each key takes one value
 * from its list. The website form offers the same lists.
 */
export const LISTING_EQUIPMENT_OPTIONS = {
  climate: ['ac', 'climate1', 'climate2', 'climateMulti'],
  powerWindows: ['front', 'frontRear'],
  interiorMaterial: ['fabric', 'leather', 'velour', 'combined', 'fauxLeather', 'alcantara'],
  interiorColour: ['light', 'dark', 'brown'],
  powerSteering: ['hydraulic', 'electric'],
  steeringAdjust: ['height', 'heightReach'],
  spareWheel: ['fullSize', 'compact'],
  headlights: ['xenon', 'laser', 'led', 'matrix', 'halogen'],
  seatAdjust: ['manualDriver', 'manualFront', 'electricDriver', 'electricFront', 'electricAll'],
  seatMemory: ['driver', 'front', 'all'],
  seatHeating: ['front', 'all'],
  seatVentilation: ['front', 'all'],
} as const;

/** Technical condition scale, as on the auto.ria add form. */
export const LISTING_TECHNICAL_CONDITIONS = [
  'undamaged',
  'repaired',
  'unrepaired',
  'notRunning',
] as const;

/**
 * Equipment checkboxes, as on the auto.ria add form. The website groups them;
 * the payload is a flat list of slugs.
 */
export const LISTING_FEATURES = [
  // comfort
  'tripComputer',
  'heatedMirrors',
  'cruiseControl',
  'powerMirrors',
  'tintedWindows',
  'rainSensor',
  'multifunctionWheel',
  'frontArmrest',
  'socket12v',
  'leatherWheel',
  'lighterAshtray',
  'foldingRearSeat',
  'powerFoldingMirrors',
  'leatherGearKnob',
  'cooledGlovebox',
  'pushButtonStart',
  'adaptiveCruise',
  'ambientLighting',
  'thirdRearHeadrest',
  'heatedWindscreen',
  'startStop',
  'driveModes',
  'keylessEntry',
  'sunroof',
  'digitalCluster',
  'powerTailgate',
  'heatedWheel',
  'powerWheelAdjust',
  'paddleShifters',
  'panoramicRoof',
  'handsFreeTailgate',
  'pedalCovers',
  'foldingPassengerSeat',
  'wheelMemory',
  'blackHeadliner',
  'thirdSeatRow',
  'wirelessCharging',
  'remoteStart',
  'rearDoorSunblinds',
  'socket220v',
  'rearWindowSunblind',
  'headUpDisplay',
  'seatbackTables',
  'softCloseDoors',
  'fridge',
  'massageSeats',
  'adjustablePedals',
  // lights
  'fogLights',
  'lightSensor',
  'drl',
  'headlightWashers',
  'adaptiveLights',
  'highBeamAssist',
  // body
  'sumpGuard',
  'gearboxGuard',
  'sillCovers',
  'longWheelbase',
  'maxiBody',
  'armoured',
  // parking
  'rearParkingSensors',
  'rearCamera',
  'frontParkingSensors',
  'frontCamera',
  'camera360',
  'autoParking',
  // safety
  'abs',
  'centralLocking',
  'childLocks',
  'asr',
  'esp',
  'immobiliser',
  'alarm',
  'tpms',
  'isofix',
  'brakeAssist',
  'hillStartAssist',
  'hillDescent',
  'vsm',
  'intrusionSensor',
  'collisionAvoidance',
  'blindSpot',
  'fatigueSensor',
  'laneKeeping',
  'signRecognition',
  'nightVision',
  // airbags
  'airbagDriver',
  'airbagPassenger',
  'airbagSideFront',
  'airbagSideRear',
  'airbagCurtain',
  'airbagKnee',
  // multimedia
  'aux',
  'usb',
  'bluetooth',
  'speakers',
  'navigation',
  'lcdMultimedia',
  'voiceControl',
  'audioPrep',
  'androidAuto',
  'carPlay',
  'rearEntertainment',
  // status
  'garageKept',
  'firstRegistration',
  'onCredit',
  // extras
  'lpg',
  'webasto',
  'adaptiveSuspension',
  'airSuspension',
  'handControls',
  'wheelchairRamp',
] as const;

/** ReportVehicleDto plus the attributes an inspection never records. */
export class ListingVehicleDeclaredDto extends ReportVehicleDto {
  /** Engine power in kW (Leistung) — a listing filter, not an inspection value. */
  @ApiPropertyOptional({ example: 140 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  powerKw?: number;

  /** Vehicle category (car, moto, truck ...). Stored in `vehicleData` only. */
  @ApiPropertyOptional({ enum: LISTING_VEHICLE_TYPES, example: 'passenger' })
  @IsOptional()
  @IsIn(LISTING_VEHICLE_TYPES)
  vehicleType?: string;

  /** Ticked equipment checkboxes. The array replaces the stored one. */
  @ApiPropertyOptional({ enum: LISTING_FEATURES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LISTING_FEATURES.length)
  @IsIn(LISTING_FEATURES, { each: true })
  features?: string[];

  /** Fuel consumption in the city, l/100 km. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(50)
  fuelCityL?: number;

  /** Fuel consumption on the highway, l/100 km. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(50)
  fuelHighwayL?: number;

  /** Combined fuel consumption, l/100 km. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(50)
  fuelCombinedL?: number;

  /** Engine displacement in litres. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  engineVolumeL?: number;

  /** Number of doors. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(5)
  doors?: number;

  /** Number of seats. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  seats?: number;

  @ApiPropertyOptional({ enum: LISTING_TECHNICAL_CONDITIONS })
  @IsOptional()
  @IsIn(LISTING_TECHNICAL_CONDITIONS)
  technicalCondition?: string;

  /** The seller agrees to a check of the car at a service station. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  serviceCheckReady?: boolean;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.climate })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.climate)
  climate?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.powerWindows })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.powerWindows)
  powerWindows?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.interiorMaterial })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.interiorMaterial)
  interiorMaterial?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.interiorColour })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.interiorColour)
  interiorColour?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.powerSteering })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.powerSteering)
  powerSteering?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.steeringAdjust })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.steeringAdjust)
  steeringAdjust?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.spareWheel })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.spareWheel)
  spareWheel?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.headlights })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.headlights)
  headlights?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.seatAdjust })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.seatAdjust)
  seatAdjust?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.seatMemory })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.seatMemory)
  seatMemory?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.seatHeating })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.seatHeating)
  seatHeating?: string;

  @ApiPropertyOptional({ enum: LISTING_EQUIPMENT_OPTIONS.seatVentilation })
  @IsOptional()
  @IsIn(LISTING_EQUIPMENT_OPTIONS.seatVentilation)
  seatVentilation?: string;
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

  /**
   * An OPEN vocabulary with more than one writer, which is why it is validated
   * as plain strings and not as an enum.
   *
   * The mobile app writes the inspector's condition indicators — five
   * mutually exclusive groups, camelCase tokens, at most one per group
   * (`carsalepro-mobile/lib/core/inspection/condition_indicators.dart`). The
   * website's seller editor writes its own `seller_*` namespace into the same
   * array. Each writer preserves the other's entries, because the report deep
   * merge REPLACES an array wholesale.
   *
   * The example was `non_smoker` / `garage_kept` until 2026-08-18 and no
   * client has ever sent those: the tokens are camelCase.
   */
  @ApiPropertyOptional({ example: ['nonSmoker', 'garageKept'], type: [String] })
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
  @ApiPropertyOptional({
    type: [ReportDamageDto],
    description: 'Max 50. Cost fields are stripped.',
  })
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
