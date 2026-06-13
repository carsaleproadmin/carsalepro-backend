import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class CreatePpvDto {
  @ApiProperty({
    example: 'CSP-042',
    description: 'Report code (CSP-### sequence) to purchase pay-per-view access to.',
  })
  @IsString()
  @Matches(/^CSP-\d{1,6}$/)
  reportCode!: string;
}
