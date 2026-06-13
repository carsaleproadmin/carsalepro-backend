import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import {
  AdminKycApplicationDto,
  AdminKycDecisionDto,
  AdminKycQueueDto,
} from './dto/admin-kyc-response.dto';
import { KycQueueQueryDto } from './dto/list-queue.dto';
import { RejectKycDto } from './dto/reject-application.dto';
import { KycService } from './kyc.service';

@ApiTags('admin-kyc')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/kyc')
export class AdminKycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @ApiOperation({ summary: 'KYC review queue (SUBMITTED + IN_REVIEW, or a status filter)' })
  @ApiOkResponse({ type: AdminKycQueueDto })
  listQueue(@Query() query: KycQueueQueryDto): Promise<AdminKycQueueDto> {
    return this.kyc.listQueue(query.status);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'KYC application detail with signed document view URLs',
    description: 'Viewing a SUBMITTED application transitions it to IN_REVIEW.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: AdminKycApplicationDto })
  getDetail(@Param('id') id: string): Promise<AdminKycApplicationDto> {
    return this.kyc.getApplicationForAdmin(id);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a KYC application and verify the user' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: AdminKycDecisionDto })
  approve(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
  ): Promise<AdminKycDecisionDto> {
    return this.kyc.approve(id, adminId);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a KYC application with a reason' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: AdminKycDecisionDto })
  reject(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: RejectKycDto,
  ): Promise<AdminKycDecisionDto> {
    return this.kyc.reject(id, adminId, dto.reason);
  }
}
