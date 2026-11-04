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
import { SubmitKycApplicationDto } from './dto/submit-application.dto';
import { UploadKycDocumentDto } from './dto/upload-document.dto';
import {
  KycApplicationDto,
  KycDocumentUploadResultDto,
  KycDocumentViewDto,
  SubmitKycResultDto,
} from './dto/kyc-response.dto';
import { KYC_DOCUMENT_KINDS, KycDocumentKind } from './kyc.constants';
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

  @Get('applications/:id/documents/:kind/view')
  @ApiOperation({
    summary: 'Get a short-lived signed link to one document of a DRAFT application',
    description:
      'Only for a DRAFT application of the caller, so the applicant can check a file ' +
      'before the submit (DEN-546). The link expires after five minutes.',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'kind', enum: [...KYC_DOCUMENT_KINDS] })
  @ApiOkResponse({ type: KycDocumentViewDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'invalid_kind / kyc_not_editable',
  })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'not_kyc_owner' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'kyc_document_not_found' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'storage_unavailable' })
  viewDocument(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('kind') kind: string,
  ): Promise<KycDocumentViewDto> {
    if (!(KYC_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({
        error: { code: 'invalid_kind', message: 'Unknown KYC document kind' },
      });
    }
    return this.kyc.getDraftDocumentView(userId, id, kind as KycDocumentKind);
  }

  @Post('applications/:id/reset')
  @ApiOperation({
    summary: 'Delete every document of a DRAFT application (start over)',
    description:
      'Only for a DRAFT application of the caller. The application keeps its id; ' +
      'its documents are deleted from storage and from the database (DEN-543).',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: KycApplicationDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'kyc_not_editable' })
  resetDraft(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<KycApplicationDto> {
    return this.kyc.resetDraft(userId, id);
  }

  @Post('applications/:id/submit')
  @ApiOperation({
    summary: 'Submit a complete DRAFT application for review',
    description:
      'The applicant must confirm the framework terms in the same request — the inspector ' +
      'works as an independent contractor and carries the liability for the inspection and ' +
      'its report. The confirmation and the wording it applied to are stored on the ' +
      'application (DEN-364).',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: SubmitKycResultDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'terms_not_accepted / incomplete_kyc / invalid_kyc_transition',
  })
  submit(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SubmitKycApplicationDto,
  ): Promise<SubmitKycResultDto> {
    return this.kyc.submitApplication(userId, id, dto.termsAccepted === true);
  }

  @Get('applications/me')
  @ApiOperation({ summary: "Get the current user's latest KYC application" })
  @ApiOkResponse({ type: KycApplicationDto })
  getMine(@CurrentUser('id') userId: string): Promise<KycApplicationDto | null> {
    return this.kyc.getMyApplication(userId);
  }
}
