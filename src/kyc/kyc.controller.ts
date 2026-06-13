import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { UploadKycDocumentDto } from './dto/upload-document.dto';
import {
  KycApplicationDto,
  PresignDocumentResultDto,
  SubmitKycResultDto,
} from './dto/kyc-response.dto';
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

  @Post('applications/:id/documents')
  @ApiOperation({ summary: 'Reserve a presigned upload URL for a KYC document' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: PresignDocumentResultDto })
  presignDocument(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UploadKycDocumentDto,
  ): Promise<PresignDocumentResultDto> {
    return this.kyc.presignDocument(userId, id, dto.kind, dto.contentType);
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
