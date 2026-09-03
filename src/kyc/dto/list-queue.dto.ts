import { ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { KYC_QUEUE_DEFAULT_LIMIT, KYC_QUEUE_MAX_LIMIT } from '../kyc.constants';

export class KycQueueQueryDto {
  @ApiPropertyOptional({
    enum: KycStatus,
    description:
      'Optional status filter. When omitted the queue returns SUBMITTED + IN_REVIEW + APPROVED — ' +
      'approved applications are included because approval is automatic, so the first two are ' +
      'always empty and revoking an inspector starts from the approved list.',
  })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: KYC_QUEUE_MAX_LIMIT,
    default: KYC_QUEUE_DEFAULT_LIMIT,
    description:
      'Page size. The queue used to be unbounded, which was safe only while it held the handful ' +
      'of applications awaiting review; it now holds every approved inspector and grows for ever.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KYC_QUEUE_MAX_LIMIT)
  limit?: number;
}
