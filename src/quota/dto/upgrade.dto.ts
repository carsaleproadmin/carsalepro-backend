import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpgradeDto {
  @ApiProperty({ enum: ['ios', 'android'], example: 'ios' })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @ApiProperty({
    example: 'MIIBoAYJKoZIhvcNAQcC...',
    description:
      'Apple IAP base64-encoded receipt blob, or for Android the purchaseToken string. ' +
      'When `IAP_VALIDATION_MODE=server`, this is verified against Apple/Google servers before the device is upgraded.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(16384)
  receipt!: string;

  @ApiPropertyOptional({
    example: 'carsalepro_pro_monthly',
    description: 'Product/SKU id. Required for Android (Google Play API needs it).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  productId?: string;

  @ApiPropertyOptional({
    enum: ['Sandbox', 'Production'],
    description: 'Client hint about the environment the receipt came from.',
  })
  @IsOptional()
  @IsIn(['Sandbox', 'Production'])
  environment?: 'Sandbox' | 'Production';
}
