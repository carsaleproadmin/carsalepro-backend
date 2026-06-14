import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { CreateDeviceLinkDto, DeviceLinkDto } from './dto/device-link.dto';
import { UpdateMeDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile' })
  getMe(@CurrentUser('id') userId: string) {
    return this.users.getMe(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile (name, phone, locale, notification prefs)' })
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(userId, dto);
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({ summary: 'GDPR erasure — anonymize PII and revoke access' })
  async eraseMe(@CurrentUser('id') userId: string): Promise<void> {
    await this.users.eraseMe(userId);
  }

  @Post('me/device-links')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Link a mobile device to the account via a 6-digit code' })
  @ApiOkResponse({ type: DeviceLinkDto })
  async linkDevice(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDeviceLinkDto,
  ): Promise<DeviceLinkDto> {
    const link = await this.users.linkDeviceByCode(userId, dto.linkCode);
    return { ...link, createdAt: link.createdAt.toISOString() };
  }

  @Get('me/device-links')
  @ApiOperation({ summary: 'List devices linked to the account' })
  @ApiOkResponse({ type: [DeviceLinkDto] })
  async listDeviceLinks(@CurrentUser('id') userId: string): Promise<DeviceLinkDto[]> {
    const links = await this.users.listDeviceLinks(userId);
    return links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() }));
  }
}
