import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'BadRequestException' })
  error!: string;

  @ApiProperty({ example: 'X-Device-Id header is required', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  message!: string | string[];

  @ApiProperty({ example: '/reports' })
  path!: string;

  @ApiProperty({ example: '2026-05-15T17:42:00.000Z' })
  timestamp!: string;
}
