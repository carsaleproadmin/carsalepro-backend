import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class UpgradeDto {
  @ApiProperty({ enum: ['ios', 'android'], example: 'ios' })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @ApiProperty({
    example: 'MIIBoAYJKoZIhvcNAQcC...',
    description: 'Apple IAP transaction receipt or Google Play purchase token.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  receipt!: string;
}
