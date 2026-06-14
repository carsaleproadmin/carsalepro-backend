import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import {
  PLATFORM_SETTING_DEFAULTS,
  SETTING_KEYS,
  SettingKey,
} from '../settings/platform-settings.constants';
import { SettingsService } from '../settings/settings.service';
import { AdminAuditService } from './admin-audit.service';
import { UpdateSettingDto } from './dto/admin-settings.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All platform settings with current values + defaults (admin)' })
  async getAll() {
    const values = await this.settings.getAll();
    return { values, defaults: PLATFORM_SETTING_DEFAULTS };
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Update a platform setting (admin)' })
  @ApiParam({ name: 'key', example: 'orderBaseFeeEur' })
  async update(
    @CurrentUser('id') adminId: string,
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
  ) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_KEYS, key)) {
      throw new NotFoundException({
        error: { code: 'unknown_setting', message: `Unknown setting '${key}'` },
      });
    }
    const settingKey = key as SettingKey;

    if (!Number.isFinite(dto.value) || dto.value < 0) {
      throw new BadRequestException({
        error: { code: 'invalid_value', message: 'Value must be a finite number ≥ 0' },
      });
    }
    if (settingKey.endsWith('Percent') && dto.value > 100) {
      throw new BadRequestException({
        error: { code: 'invalid_value', message: 'Percent settings must be between 0 and 100' },
      });
    }

    const previous = await this.settings.getNumber(settingKey);
    await this.settings.set(settingKey, dto.value, adminId);
    await this.audit.log(
      adminId,
      'settings.update',
      'platform_setting',
      settingKey,
      { value: previous },
      { value: dto.value },
    );
    return { key: settingKey, value: dto.value };
  }
}
