import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpgradeDto {
  @ApiProperty({ enum: ['ios', 'android'], example: 'ios' })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @ApiProperty({
    example: 'eyJhbGciOiJFUzI1NiIsIng1YyI6WyJNSUlF...',
    description:
      '`PurchaseDetails.verificationData.serverVerificationData`. iOS: the StoreKit 2 signed ' +
      'transaction (JWS). A bare numeric transaction id is refused. A base64 StoreKit 1 app ' +
      'receipt is accepted only when `APPLE_SHARED_SECRET` is set. Android: the purchase token.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(16384)
  receipt!: string;

  @ApiPropertyOptional({
    example: 'carsalepro_pro_lifetime',
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
