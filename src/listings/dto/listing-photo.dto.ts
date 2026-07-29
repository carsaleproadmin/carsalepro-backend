import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Multipart body fields that ride alongside the uploaded file. */
export class UploadListingPhotoDto {
  @ApiPropertyOptional({
    example: 0,
    description: 'Gallery position. Omitted = appended to the end.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ example: 'Front three-quarter view' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  caption?: string;

  @ApiPropertyOptional({ description: 'sha256 hex of the ORIGINAL bytes — duplicate short-circuit.' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i)
  hash?: string;
}

export class ReorderListingPhotosDto {
  @ApiProperty({
    type: [String],
    description:
      'Photo ids in the desired order. Must be exactly the listing\'s current photo ids.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids!: string[];
}

export class ListingPhotoDto {
  @ApiProperty() id!: string;
  @ApiProperty() order!: number;
  @ApiProperty({ nullable: true }) caption!: string | null;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty({ description: 'Compressed size in bytes.' }) sizeBytes!: number;
  @ApiProperty({ nullable: true, description: 'Signed/public download URL, null if R2 is unset.' })
  url!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ListingPhotoListDto {
  @ApiProperty({ type: [ListingPhotoDto] })
  items!: ListingPhotoDto[];

  @ApiProperty({ example: 20, description: 'Server-side cap on photos per listing.' })
  max!: number;
}
