import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
} from '../../orders/admin-decision';
import { PaginationQueryDto } from './pagination.dto';

export class AdminUserListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive match on email or name.' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  q?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: 'Filter by ban state (derived from bannedAt).' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  banned?: boolean;

  @ApiPropertyOptional({ description: 'Include soft-deleted users.', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeDeleted?: boolean;
}

export class BanUserDto {
  @ApiPropertyOptional({ example: 'Fraudulent activity' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class EraseUserDto {
  @ApiProperty({
    description:
      `Why the account is erased (${ADMIN_REASON_MIN_LENGTH}-${ADMIN_REASON_MAX_LENGTH} ` +
      'characters after trimming), for example the date and channel of the request. ' +
      'Only admins see it. Do not put personal data in it.',
    example: 'Erasure request by e-mail on 2026-09-10.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(ADMIN_REASON_MIN_LENGTH)
  @MaxLength(ADMIN_REASON_MAX_LENGTH)
  reason!: string;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: Role, example: Role.ADMIN })
  @IsEnum(Role)
  role!: Role;
}

export class AdminCreateDeviceLinkDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsString()
  @MaxLength(128)
  deviceId!: string;
}
