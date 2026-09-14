import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { UsersService } from '../users/users.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminUsersService } from './admin-users.service';
import {
  AdminCreateDeviceLinkDto,
  AdminUserListQueryDto,
  BanUserDto,
  ChangeRoleDto,
} from './dto/admin-users.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly adminUsers: AdminUsersService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List/search users (admin)' })
  list(@Query() query: AdminUserListQueryDto) {
    return this.adminUsers.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'User detail (admin)' })
  @ApiParam({ name: 'id' })
  detail(@Param('id') id: string) {
    return this.adminUsers.detail(id);
  }

  @Post(':id/ban')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ban a user (admin)' })
  @ApiParam({ name: 'id' })
  async ban(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: BanUserDto,
  ) {
    const before = await this.adminUsers.require(id);
    const after = await this.adminUsers.ban(id, adminId);
    await this.audit.log(
      adminId,
      'user.ban',
      'user',
      id,
      { bannedAt: before.bannedAt },
      { bannedAt: after.bannedAt, reason: dto.reason ?? null },
    );
    return { id: after.id, bannedAt: after.bannedAt?.toISOString() ?? null };
  }

  @Post(':id/unban')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unban a user (admin)' })
  @ApiParam({ name: 'id' })
  async unban(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    const before = await this.adminUsers.require(id);
    const after = await this.adminUsers.unban(id);
    await this.audit.log(
      adminId,
      'user.unban',
      'user',
      id,
      { bannedAt: before.bannedAt },
      { bannedAt: after.bannedAt },
    );
    return { id: after.id, bannedAt: after.bannedAt?.toISOString() ?? null };
  }

  @Post(':id/role')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change a user role (admin)' })
  @ApiParam({ name: 'id' })
  async changeRole(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    const before = await this.adminUsers.require(id);
    const after = await this.adminUsers.changeRole(id, dto.role, adminId);
    await this.audit.log(
      adminId,
      'user.role',
      'user',
      id,
      { role: before.role },
      { role: after.role },
    );
    return { id: after.id, role: after.role };
  }

  @Get(':id/device-links')
  @ApiOperation({ summary: 'List device links for a user (admin)' })
  @ApiParam({ name: 'id' })
  async listDeviceLinks(@Param('id') id: string) {
    const links = await this.users.listDeviceLinks(id);
    return { items: links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })) };
  }

  @Post(':id/device-links')
  @HttpCode(201)
  @ApiOperation({ summary: 'Manually link a device to a user (admin)' })
  @ApiParam({ name: 'id' })
  async linkDevice(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: AdminCreateDeviceLinkDto,
  ) {
    const link = await this.users.attachDevice(id, dto.deviceId, 'admin');
    await this.audit.log(adminId, 'user.device_link', 'user', id, null, {
      deviceId: dto.deviceId,
    });
    return { ...link, createdAt: link.createdAt.toISOString() };
  }

  @Delete(':id/device-links/:deviceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unlink a device from a user (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'deviceId' })
  async unlinkDevice(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
  ) {
    const link = await this.users.unlinkDevice(id, deviceId);
    await this.audit.log(adminId, 'user.device_unlink', 'user', id, { deviceId }, null);
    return { id: link.id, deviceId: link.deviceId, removed: true };
  }
}
