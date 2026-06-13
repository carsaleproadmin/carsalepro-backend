import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectKycDto {
  @ApiProperty({
    example: 'ID photo is blurry — please re-upload a clear image.',
    description: 'Reason shown to the inspector. Required.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
