import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { PriceCatalog } from './price-catalog';
import { SettingsService } from './settings.service';

/**
 * Public settings response: the historical EUR-float keys (an index signature,
 * because the exact key set is data-driven by PUBLIC_SETTING_KEYS) plus the
 * cents-based `prices` block.
 */
export interface PublicSettingsResponse {
  [key: string]: number | PriceCatalog;
  prices: PriceCatalog;
}

@ApiTags('settings')
@Controller('api/v1/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get('public')
  // Tariffs change rarely and the values are identical for every caller, so a
  // short shared cache is safe and keeps the website's render path off the DB.
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Public platform settings (prices, fees, radius)' })
  @ApiOkResponse({ description: 'Public subset of PlatformSetting values, plus prices in cents' })
  async getPublic(): Promise<PublicSettingsResponse> {
    // The flat EUR keys are a published contract that existing clients read —
    // they stay exactly as they were. `prices` is the additive, cents-based
    // shape new code should use.
    const [flat, prices] = await Promise.all([
      this.settings.getPublic(),
      this.settings.getPriceCatalog(),
    ]);
    return { ...flat, prices };
  }
}
