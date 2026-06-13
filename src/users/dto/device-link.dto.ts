import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class CreateDeviceLinkDto {
  @ApiProperty({ example: '042178', description: '6-digit link code generated on the mobile device.' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'linkCode must be 6 digits' })
  linkCode!: string;
}

export class DeviceLinkDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: 'ckqz...userId' })
  userId!: string;

  @ApiProperty({ example: 'a1b2c3d4-....' })
  deviceId!: string;

  @ApiProperty({ enum: ['code', 'admin'], example: 'code' })
  linkedVia!: string;

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z' })
  createdAt!: string;
}
