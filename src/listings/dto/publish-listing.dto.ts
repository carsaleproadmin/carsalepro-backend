import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class PublishListingDto {
  @ApiProperty({
    example: 'standard',
    enum: ['standard', 'gold'],
    description: 'Listing package. "gold" triggers a Stripe Checkout (or auto-activates in mock mode).',
  })
  @IsIn(['standard', 'gold'])
  package!: 'standard' | 'gold';
}
