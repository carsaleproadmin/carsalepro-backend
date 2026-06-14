import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'order', description: 'Filter by entity type.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entity?: string;

  @ApiPropertyOptional({ description: 'Filter by the affected entity id.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ description: 'Filter by the acting admin id.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  adminId?: string;

  @ApiPropertyOptional({ example: 'order.cancel', description: 'Filter by action name.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;
}
