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
import { SETTING_LIMITS, settingValueError } from '../settings/setting-limits';
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
  @ApiOperation({
    summary: 'All platform settings with current values, defaults and allowed ranges (admin)',
  })
  async getAll() {
    const values = await this.settings.getAll();
    // `limits` lets the form show the range and refuse a typing error before
    // the request (DEN-297). The backend check below stays authoritative.
    return { values, defaults: PLATFORM_SETTING_DEFAULTS, limits: SETTING_LIMITS };
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

    // One range per key (DEN-297, `setting-limits.ts`). It replaces the old
    // "finite and >= 0" and "percent <= 100" checks, which let an extra digit
    // move a price by a factor of ten. `minReportQualityScore` keeps its 0-100
    // range: above 100 the completeness gate would refuse EVERY report, and 0
    // is the deliberate emergency lever that switches it off.
    const error = settingValueError(settingKey, dto.value);
    if (error) {
      const { min, max } = SETTING_LIMITS[settingKey];
      throw new BadRequestException({
        error: { code: 'invalid_value', message: error, min, max },
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
