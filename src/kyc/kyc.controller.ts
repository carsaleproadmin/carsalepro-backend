import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { UploadKycDocumentDto } from './dto/upload-document.dto';
import {
  KycApplicationDto,
  KycDocumentUploadResultDto,
  SubmitKycResultDto,
} from './dto/kyc-response.dto';
import { KYC_DOCUMENT_KINDS } from './kyc.constants';
import { MAX_KYC_UPLOAD_BYTES } from './kyc-upload';
import { KycService } from './kyc.service';

@ApiTags('kyc')
@ApiBearerAuth()
@Controller('api/v1/kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('applications')
  @ApiOperation({
    summary: 'Create (or return the existing) DRAFT KYC application',
    description:
      'Returns the existing application if the user already has one in ' +
      'DRAFT/SUBMITTED/IN_REVIEW; otherwise creates a fresh DRAFT.',
  })
  @ApiOkResponse({ type: KycApplicationDto })
  createApplication(@CurrentUser('id') userId: string): Promise<KycApplicationDto> {
    return this.kyc.createApplication(userId);
  }

  /**
   * The ONLY way a KYC document enters the system.
   *
   * There is deliberately no presigned-PUT variant. The private KYC bucket has
   * no CORS rules, so a browser PUT never left the browser; and giving it CORS
   * would leave a browser-reachable write path into the identity-document
   * store standing open forever. The bytes come through the API, where the
   * credentials stay server-side and the file can be checked against its own
   * contents.
   */
  @Post('applications/:id/documents/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_KYC_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload one KYC document (multipart, server-side storage)',
    description:
      'Multipart upload of an identity document (≤15 MB). The content type is ' +
      'taken from the multipart part and corroborated against the file’s magic ' +
      'bytes. Images are compressed server-side and stored as JPEG; PDFs are stored ' +
      'as-is. One document per kind — re-uploading a kind REPLACES the previous one ' +
      'and deletes the object it displaced. The application must be DRAFT.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: [...KYC_DOCUMENT_KINDS] },
      },
    },
  })
  @ApiResponse({ status: 201, type: KycDocumentUploadResultDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'file_required / kyc_not_editable / unsupported_content_type / ' +
      'content_type_mismatch / file_too_large / invalid_image',
  })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'not_kyc_owner' })
  @ApiResponse({ status: 413, description: 'File larger than 15 MB' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'storage_unavailable' })
  uploadDocument(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UploadKycDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<KycDocumentUploadResultDto> {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException({
        error: {
          code: 'file_required',
          message: 'Send the document in the `file` multipart field',
        },
      });
    }
    return this.kyc.uploadDocument(userId, id, dto.kind, file);
  }

  @Post('applications/:id/submit')
  @ApiOperation({ summary: 'Submit a complete DRAFT application for review' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: SubmitKycResultDto })
  submit(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<SubmitKycResultDto> {
    return this.kyc.submitApplication(userId, id);
  }

  @Get('applications/me')
  @ApiOperation({ summary: "Get the current user's latest KYC application" })
  @ApiOkResponse({ type: KycApplicationDto })
  getMine(@CurrentUser('id') userId: string): Promise<KycApplicationDto | null> {
    return this.kyc.getMyApplication(userId);
  }
}
