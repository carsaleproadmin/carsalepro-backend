import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class PublishListingDto {
  @ApiProperty({
    example: 'standard',
    enum: ['standard'],
    description:
      'Listing package. The only package is "standard", and publishing is free. ' +
      '"gold" is not sold any more (DEN-309) and gets 400.',
  })
  @IsIn(['standard'])
  package!: 'standard';
}
