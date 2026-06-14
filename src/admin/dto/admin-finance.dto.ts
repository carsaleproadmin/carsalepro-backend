import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

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
