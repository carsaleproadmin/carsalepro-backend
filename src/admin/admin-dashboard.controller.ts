import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AdminDashboardService } from './admin-dashboard.service';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Admin dashboard counts' })
  counts() {
    return this.dashboard.counts();
  }
}
