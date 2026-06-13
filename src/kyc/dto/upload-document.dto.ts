import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { KYC_DOCUMENT_KINDS, KycDocumentKind } from '../kyc.constants';

export class UploadKycDocumentDto {
  @ApiProperty({
    example: 'id_front',
    enum: KYC_DOCUMENT_KINDS,
    description: 'Which document this upload is for. One row per kind — re-uploading replaces it.',
  })
  @IsIn(KYC_DOCUMENT_KINDS as unknown as string[])
  kind!: KycDocumentKind;

  @ApiPropertyOptional({
    example: 'image/jpeg',
    description:
      'MIME type of the file you will PUT. Must be image/* or application/pdf. ' +
      'Defaults to application/octet-stream.',
  })
  @IsOptional()
  @IsString()
  contentType?: string;
}
