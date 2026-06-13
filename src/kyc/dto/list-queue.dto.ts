import { ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class KycQueueQueryDto {
  @ApiPropertyOptional({
    enum: KycStatus,
    description:
      'Optional status filter. When omitted the queue returns SUBMITTED + IN_REVIEW applications.',
  })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;
}
