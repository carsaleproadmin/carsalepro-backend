import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.decorators';
import { DeviceLinkDto } from '../users/dto/device-link.dto';
import { UsersService } from '../users/users.service';
import { AdminCreateDeviceLinkDto } from './dto/admin-device-link.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin')
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Post('users/:id/device-links')
  @HttpCode(201)
  @ApiOperation({ summary: 'Manually link a device to a user (admin only)' })
  @ApiParam({ name: 'id', description: 'Target user id' })
  @ApiOkResponse({ type: DeviceLinkDto })
  async linkDevice(
    @Param('id') userId: string,
    @Body() dto: AdminCreateDeviceLinkDto,
  ): Promise<DeviceLinkDto> {
    const link = await this.users.attachDevice(userId, dto.deviceId, 'admin');
    return { ...link, createdAt: link.createdAt.toISOString() };
  }
}
