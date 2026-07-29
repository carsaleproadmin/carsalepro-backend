import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class FinanceSummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01T00:00:00.000Z', description: 'Window start (default: 30 days ago).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-01T00:00:00.000Z', description: 'Window end (default: now).' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class Dac7QueryDto {
  @ApiPropertyOptional({ example: 2026, description: 'Calendar year (default: current year).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(3000)
  year?: number;
}

export class PayoutQueueQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'paid', 'failed'] })
  @IsOptional()
  @IsIn(['pending', 'paid', 'failed'])
  status?: 'pending' | 'paid' | 'failed';

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

/**
 * Some transfers can never succeed through Stripe — a closed connected account,
 * for instance — and get settled by bank transfer instead. The reference is
 * mandatory so the audit log records HOW the money actually moved.
 */
export class MarkPayoutPaidDto {
  @ApiProperty({ example: 'SEPA 2026-07-29 ref 88213', description: 'How it was settled.' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}
