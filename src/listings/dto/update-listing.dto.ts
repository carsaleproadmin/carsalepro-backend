import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateListingDto {
  @ApiPropertyOptional({ example: 1850000, description: 'Asking price in integer cents (> 0).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @ApiPropertyOptional({ example: 'Berlin' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: '10115' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  plz?: string;

  @ApiPropertyOptional({ example: 'One owner, full service history.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '+49 30 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'seller@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;
}
