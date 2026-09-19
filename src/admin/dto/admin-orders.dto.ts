import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
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
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
} from '../../orders/admin-decision';
import { AdminCarFilterQueryDto } from './admin-car-filter.dto';

/**
 * Trim before the length check, so that a reason of only spaces is refused
 * and the stored text has no padding.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const REASON_DESCRIPTION =
  `Why the admin makes this decision (${ADMIN_REASON_MIN_LENGTH}-${ADMIN_REASON_MAX_LENGTH} ` +
  'characters after trimming). Only admins see it.';

/**
 * The car filters (DEN-316) read the order's own columns where it has them. An
 * order has no year, mileage or city column: year and mileage come from the
 * attached report, and the city is matched in the address.
 */
export class AdminOrderListQueryDto extends AdminCarFilterQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Case-insensitive match on order number or VIN.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  inspectorId?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class AdminAssignOrderDto {
  @ApiProperty({ description: 'Target inspector user id.' })
  @IsString()
  @MaxLength(64)
  inspectorId!: string;
}

export class AdminCancelOrderDto {
  @ApiProperty({ example: 100, minimum: 0, maximum: 100, description: 'Refund percent (0–100).' })
  @IsInt()
  @Min(0)
  @Max(100)
  refundPercent!: number;

  @ApiProperty({ description: REASON_DESCRIPTION, example: 'The customer asked by phone to cancel.' })
  @Transform(trim)
  @IsString()
  @MinLength(ADMIN_REASON_MIN_LENGTH)
  @MaxLength(ADMIN_REASON_MAX_LENGTH)
  reason!: string;
}

export class AdminResolveDisputeDto {
  @ApiProperty({ enum: ['customer', 'inspector'] })
  @IsIn(['customer', 'inspector'])
  resolution!: 'customer' | 'inspector';

  @ApiProperty({ description: REASON_DESCRIPTION, example: 'The report has no photo of the rear.' })
  @Transform(trim)
  @IsString()
  @MinLength(ADMIN_REASON_MIN_LENGTH)
  @MaxLength(ADMIN_REASON_MAX_LENGTH)
  reason!: string;

  @ApiPropertyOptional({ example: 100, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  refundPercent?: number;
}
