import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { KYC_DOCUMENT_KINDS, KycDocumentKind } from '../kyc.constants';

/**
 * The non-file part of `POST /applications/:id/documents/upload`.
 *
 * THERE IS NO `contentType` FIELD ANY MORE, AND ONE MUST NOT COME BACK. The
 * presign endpoint accepted an optional one and checked it with
 * `if (contentType && …)`, so a client skipped validation by simply not sending
 * it. The type now comes from the multipart part itself and is corroborated
 * against the file's magic bytes in `kyc-upload.ts` — neither of which the
 * caller can turn off.
 */
export class UploadKycDocumentDto {
  @ApiProperty({
    example: 'id_front',
    enum: KYC_DOCUMENT_KINDS,
    description: 'Which document this upload is for. One row per kind — re-uploading replaces it.',
  })
  @IsIn(KYC_DOCUMENT_KINDS as unknown as string[])
  kind!: KycDocumentKind;
}
