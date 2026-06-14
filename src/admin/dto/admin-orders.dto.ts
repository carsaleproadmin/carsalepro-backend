import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
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
} from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

export class AdminOrderListQueryDto extends PaginationQueryDto {
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
}

export class AdminResolveDisputeDto {
  @ApiProperty({ enum: ['customer', 'inspector'] })
  @IsIn(['customer', 'inspector'])
  resolution!: 'customer' | 'inspector';

  @ApiPropertyOptional({ example: 100, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  refundPercent?: number;
}
