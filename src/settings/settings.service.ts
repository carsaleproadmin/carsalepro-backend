import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceCatalog } from './price-catalog';
import {
  PLATFORM_SETTING_DEFAULTS,
  PUBLIC_SETTING_KEYS,
  SETTING_KEYS,
  SettingKey,
} from './platform-settings.constants';

const CACHE_TTL_MS = 30_000;

/**
 * Reads PlatformSetting values with a short in-memory cache. Falls back to the
 * seeded defaults if a row is missing, so business logic always has a value.
 * Write path (admin) invalidates the cache.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, unknown>();
  private cacheExpiresAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  private async load(): Promise<void> {
    if (Date.now() < this.cacheExpiresAt && this.cache.size > 0) return;
    const rows = await this.prisma.platformSetting.findMany();
    const next = new Map<string, unknown>();
    for (const row of rows) next.set(row.key, row.value);
    this.cache = next;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }

  invalidate(): void {
    this.cacheExpiresAt = 0;
    this.cache.clear();
  }

  /** Numeric setting with a guaranteed default. */
  async getNumber(key: SettingKey): Promise<number> {
    await this.load();
    const raw = this.cache.get(key);
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) return value;
    return PLATFORM_SETTING_DEFAULTS[key];
  }

  /** EUR setting converted to integer cents at the single point of use. */
  async getCents(key: SettingKey): Promise<number> {
    return Math.round((await this.getNumber(key)) * 100);
  }

  async getAll(): Promise<Record<string, number>> {
    await this.load();
    const out: Record<string, number> = {};
    for (const key of Object.keys(SETTING_KEYS) as SettingKey[]) {
      out[key] = await this.getNumber(key);
    }
    return out;
  }

  async getPublic(): Promise<Record<string, number>> {
    await this.load();
    const out: Record<string, number> = {};
    for (const key of PUBLIC_SETTING_KEYS) {
      out[key] = await this.getNumber(key);
    }
    return out;
  }

  /**
   * Every chargeable price in integer cents. The one shape any response that
   * shows a price should embed, so a displayed price can never drift from the
   * price charged at checkout.
   */
  async getPriceCatalog(): Promise<PriceCatalog> {
    await this.load();
    return {
      currency: 'EUR',
      payPerViewCents: await this.getCents('payPerViewPriceEur'),
      goldPackageCents: await this.getCents('goldPackagePriceEur'),
      standardListingCents: await this.getCents('standardListingPriceEur'),
      orderBaseFeeCents: await this.getCents('orderBaseFeeEur'),
      orderRatePerKmCents: await this.getCents('orderRatePerKmEur'),
      orderRatePerMinuteCents: await this.getCents('orderRatePerMinuteEur'),
      orderMinimumFareCents: await this.getCents('orderMinimumFareEur'),
      listingDurationDays: await this.getNumber('listingDurationDays'),
      expertSearchRadiusKm: await this.getNumber('expertSearchRadiusKm'),
    };
  }

  async set(key: SettingKey, value: number, updatedBy?: string): Promise<void> {
    await this.prisma.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedBy },
      update: { value, updatedBy },
    });
    this.invalidate();
    this.logger.log(`PlatformSetting ${key} updated`);
  }
}
