import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AdminAuditService } from './admin-audit.service';
import { AuditQueryDto } from './dto/audit.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @ApiOperation({ summary: 'List admin audit-log entries (admin)' })
  list(@Query() query: AuditQueryDto) {
    return this.audit.list(query);
  }
}
