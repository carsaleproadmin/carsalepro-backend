import { ApiProperty } from '@nestjs/swagger';

export class LinkCodeResponseDto {
  @ApiProperty({ example: '042178', description: '6-digit numeric link code (zero-padded).' })
  code!: string;

  @ApiProperty({ example: '2026-06-13T10:10:00.000Z' })
  expiresAt!: string;
}
