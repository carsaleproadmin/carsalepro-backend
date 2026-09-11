import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListNotificationsQueryDto {
  /**
   * The site language of the reader. The title and the body are rendered again
   * in this locale. An unsupported locale gets the default locale. When it is
   * absent, the API returns the text that was stored at creation.
   */
  @ApiPropertyOptional({ example: 'en', maxLength: 35 })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  locale?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class UpdatePreferencesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() inapp?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() email?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sms?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() push?: boolean;
}
