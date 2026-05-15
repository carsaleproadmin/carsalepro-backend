import { ApiProperty } from '@nestjs/swagger';

export class QuotaDto {
  @ApiProperty({ example: 'b2f24f8e-3b6f-4f3e-8ad4-5e5d2f3a1c40' })
  deviceId!: string;

  @ApiProperty({ example: 1 })
  freeReportsUsed!: number;

  @ApiProperty({ example: 3 })
  freeReportsLimit!: number;

  @ApiProperty({ example: false })
  isPro!: boolean;

  @ApiProperty({ example: 2, description: 'reports remaining in FREE tier (0 if PRO)' })
  remaining!: number;
}
