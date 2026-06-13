import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class CreateListingDto {
  @ApiProperty({
    example: 'CSP-042',
    description: 'Report code (CSP-### sequence) to create a sales listing for.',
  })
  @IsString()
  @Matches(/^CSP-\d{1,12}$/)
  reportCode!: string;
}
