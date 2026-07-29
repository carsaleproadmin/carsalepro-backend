import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Report codes accepted by the public lookups. Mirrors the pattern in
 * `src/reports/dto/create-report.dto.ts` so the two surfaces cannot drift:
 * the legacy sequential form and the current `CSP-<uuid v4>` form.
 */
export const REPORT_CODE_PATTERN =
  /^CSP-(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `GET /api/v1/public/report-check`. Both parameters are optional — the service
 * decides what to do when neither is supplied — but a supplied value must be
 * well-formed. Previously these were raw strings with no validation at all.
 */
export class ReportCheckQueryDto {
  @IsOptional()
  @Transform(upper)
  @IsString()
  // ISO 3779: no I, O or Q.
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, { message: 'vin must be a 17-character VIN' })
  vin?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(48)
  @Matches(REPORT_CODE_PATTERN, { message: 'code must be a CSP report code' })
  code?: string;
}

/** `GET /api/v1/public/reports/:code/preview`. */
export class ReportCodeParamDto {
  @Transform(trim)
  @IsString()
  @MaxLength(48)
  @Matches(REPORT_CODE_PATTERN, { message: 'code must be a CSP report code' })
  code!: string;
}
