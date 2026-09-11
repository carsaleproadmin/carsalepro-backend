import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ListingStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
} from '../../orders/admin-decision';
import { PaginationQueryDto } from './pagination.dto';

export class AdminListingListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ListingStatus })
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;

  @ApiPropertyOptional({ description: 'Case-insensitive match on city, make or model.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerId?: string;
}

export class AdminHideListingDto {
  @ApiProperty({
    description:
      `Why the listing is hidden (${ADMIN_REASON_MIN_LENGTH}-${ADMIN_REASON_MAX_LENGTH} ` +
      'characters after trimming). The seller receives this text (DEN-295).',
    example: 'The price in the advert does not match the description.',
  })
  // Trim before the length check, so that a reason of only spaces is refused.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(ADMIN_REASON_MIN_LENGTH)
  @MaxLength(ADMIN_REASON_MAX_LENGTH)
  reason!: string;
}
