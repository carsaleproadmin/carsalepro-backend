import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { ReportDataV1Dto } from './dto/report-data-v1.dto';

/** Serialized payload cap — a full 98-item report with damages is ~50–150 KB. */
const MAX_REPORT_DATA_BYTES = 1024 * 1024;

/**
 * Queryable columns synced from a validated payload onto the Report row.
 * Explicit top-level DTO fields (dto.year etc.) win over these when both are
 * present — the caller merges with `?? extracted.*`.
 */
export interface ExtractedReportFields {
  vin?: string;
  make?: string;
  model?: string;
  year?: number;
  mileageKm?: number;
  color?: string;
  bodyType?: string;
  driveType?: string;
  qualityScore?: number;
}

/**
 * Validate a `reportData` payload claiming contract version 1.
 *
 * Lenient by design: `whitelist: false` keeps unknown keys (forward-compat
 * with newer mobile builds); only known fields are type/range-checked.
 * Throws 400 with per-field details on failure. MUST be called before any
 * quota is consumed so a validation failure never burns a free credit.
 */
export function validateReportDataV1(payload: unknown): ReportDataV1Dto {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequestException({
      error: 'invalid_report_data',
      message: 'reportData must be a JSON object when reportSchemaVersion is 1',
    });
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_REPORT_DATA_BYTES) {
    throw new BadRequestException({
      error: 'report_data_too_large',
      message: `reportData is ${bytes} bytes; the limit is ${MAX_REPORT_DATA_BYTES}`,
    });
  }

  const instance = plainToInstance(ReportDataV1Dto, payload);
  const errors = validateSync(instance, {
    whitelist: false,
    forbidNonWhitelisted: false,
    forbidUnknownValues: false,
  });
  if (errors.length > 0) {
    throw new BadRequestException({
      error: 'invalid_report_data',
      message: 'reportData failed schema v1 validation',
      details: flattenValidationErrors(errors),
    });
  }
  return instance;
}

/** Pull the listing-relevant denormalized columns out of a validated payload. */
export function extractDenormalizedFields(data: ReportDataV1Dto): ExtractedReportFields {
  return {
    vin: data.vehicle?.vin?.toUpperCase(),
    make: data.vehicle?.make,
    model: data.vehicle?.model,
    year: data.vehicle?.year,
    mileageKm: data.operational?.mileageKm,
    color: data.vehicle?.colour,
    bodyType: data.vehicle?.bodyType,
    driveType: data.vehicle?.driveType,
    qualityScore: data.scores?.qualityScore,
  };
}

function flattenValidationErrors(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      out.push(...Object.values(err.constraints).map((msg) => `${path}: ${msg}`));
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenValidationErrors(err.children, path));
    }
  }
  return out;
}
