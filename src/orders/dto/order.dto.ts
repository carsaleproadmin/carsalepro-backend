import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class QuoteOrderDto {
  @ApiProperty({ example: 52.52 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 13.405 })
  @IsLongitude()
  lng!: number;

  @ApiProperty({ example: '2026-07-01T09:00:00.000Z' })
  @IsISO8601()
  scheduledAt!: string;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ example: '1HGBH41JXMN109186', minLength: 17, maxLength: 17 })
  @IsOptional()
  @IsString()
  @Length(17, 17)
  @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i)
  vin?: string;

  @ApiProperty({ example: 'BMW' })
  @IsString()
  @MaxLength(64)
  make!: string;

  @ApiProperty({ example: '320d' })
  @IsString()
  @MaxLength(64)
  model!: string;

  @ApiPropertyOptional({ example: 'https://mobile.de/listing/123' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  listingUrl?: string;

  @ApiProperty({ example: 'Musterstraße 1, 10115 Berlin' })
  @IsString()
  @MaxLength(240)
  address!: string;

  @ApiProperty({ example: 52.52 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 13.405 })
  @IsLongitude()
  lng!: number;

  @ApiProperty({ example: '2026-07-01T09:00:00.000Z' })
  @IsISO8601()
  scheduledAt!: string;
}

/** Statuses an assigned inspector may push the order into via /status. */
export enum InspectorStatusUpdate {
  EN_ROUTE = 'EN_ROUTE',
  IN_PROGRESS = 'IN_PROGRESS',
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: InspectorStatusUpdate })
  @IsEnum(InspectorStatusUpdate)
  status!: InspectorStatusUpdate;
}

export class DisputeOrderDto {
  @ApiProperty({ example: 'Inspector never showed up' })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export enum OrderRole {
  customer = 'customer',
  inspector = 'inspector',
}

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ enum: OrderRole, default: OrderRole.customer })
  @IsOptional()
  @IsEnum(OrderRole)
  role?: OrderRole;

  @ApiPropertyOptional({ example: 'PAID' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;
}
