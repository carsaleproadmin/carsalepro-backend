import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

export class UpdateSettingDto {
  @ApiProperty({ example: 60, description: 'New value (finite number ≥ 0; percent keys are 0–100).' })
  @IsNumber()
  @Min(0)
  value!: number;
}
