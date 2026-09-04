import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { KYC_RETENTION_DAYS } from '../kyc/kyc.constants';
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
  /**
   * Days a decided KYC application's documents are kept before the nightly
   * purge deletes them.
   *
   * Not a price, so not in `prices` - but published for the same reason every
   * price is. The website prints it to the applicant at the moment they hand
   * over an identity document, and it held its own literal `90` with no shared
   * package and no test tying it to the cron that enforces the number. A stale
   * price misinforms a buyer; a stale retention period is a promise about
   * somebody's personal data that nothing keeps.
   */
  kycRetentionDays: number;
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
    return { ...flat, prices, kycRetentionDays: KYC_RETENTION_DAYS };
  }
}
