import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller('api/v1/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('public')
  @ApiOperation({ summary: 'Public platform settings (prices, fees, radius)' })
  @ApiOkResponse({ description: 'Public subset of PlatformSetting values' })
  async getPublic(): Promise<Record<string, number>> {
    return this.settings.getPublic();
  }
}
