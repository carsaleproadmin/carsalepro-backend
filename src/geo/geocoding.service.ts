import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import { LatLng } from './routing.service';

/** Shape of the bits of the Mapbox Geocoding v6 response we consume. */
interface ReverseGeocodeResponse {
  features?: Array<{
    properties?: {
      context?: { country?: { country_code?: string } };
    };
  }>;
}

const REQUEST_TIMEOUT_MS = 2500;

/**
 * The country an order falls back to when reverse geocoding cannot answer.
 *
 * It matches the `Order.countryCode` column default, and — once regional
 * tariffs land — it must resolve to a real tariff row, because this value is
 * used exactly when we know the least about the location.
 */
export const DEFAULT_COUNTRY_CODE = 'DE';

/**
 * The country of a coordinate pair.
 *
 * Written for one caller: an order must record the country of the INSPECTION
 * ADDRESS, not of the customer's account. A car in Poland inspected for a
 * customer in Germany is in Poland, and regional pricing (DEN-108) reads this
 * value.
 *
 * Like `RoutingService`, this service NEVER throws and never rejects. A
 * geocoding outage must not refuse an order that is otherwise payable, so every
 * failure path returns `null` and the caller falls back to
 * `DEFAULT_COUNTRY_CODE`.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly token: string;
  private warnedAboutRateLimit = false;

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.token = config.get('mapbox', { infer: true }).token;
    if (!this.token) {
      this.logger.warn(`MAPBOX_TOKEN not set — orders record ${DEFAULT_COUNTRY_CODE}`);
    }
  }

  /** Mirrors RoutingService.configured: false means the fallback path. */
  get configured(): boolean {
    return this.token.length > 0;
  }

  /**
   * ISO 3166-1 alpha-2, upper case, or `null` when the country is unknown —
   * which includes a point at sea, an unconfigured token and a provider
   * failure. The caller decides what an unknown country costs; this service
   * does not invent one.
   */
  async countryCodeFor(point: LatLng): Promise<string | null> {
    if (!this.configured) return null;

    const key = this.cacheKey(point);
    const cached = await this.readCache(key);
    if (cached) return cached;

    const code = await this.fetchCountry(point);
    if (!code) return null;

    await this.writeCache(key, code);
    return code;
  }

  // ---- Mapbox ----

  private async fetchCountry(point: LatLng): Promise<string | null> {
    // `types=country` asks for the one feature we use. Without it the response
    // carries the full address hierarchy — several kilobytes to read a single
    // two-letter field.
    const url =
      'https://api.mapbox.com/search/geocode/v6/reverse' +
      `?longitude=${point.lng}&latitude=${point.lat}&types=country` +
      `&access_token=${encodeURIComponent(this.token)}`;

    try {
      const { data } = await firstValueFrom(
        this.http.get<ReverseGeocodeResponse>(url, { timeout: REQUEST_TIMEOUT_MS }),
      );
      const code = data?.features?.[0]?.properties?.context?.country?.country_code;
      if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return null;
      return code.toUpperCase();
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429 && !this.warnedAboutRateLimit) {
        this.warnedAboutRateLimit = true;
        this.logger.error('Mapbox Geocoding is rate-limiting us — orders record the default country');
      } else if (status !== 429) {
        this.logger.warn(
          `Reverse geocode failed (${String(status ?? 'network')}) — using the default country`,
        );
      }
      return null;
    }
  }

  // ---- cache ----

  /**
   * 2 decimal places is about 1.1 km. Coarser than the routing cache on
   * purpose: a country is a large object, so a coarse key raises the hit rate,
   * and the error it can introduce is confined to a strip along a border.
   */
  private cacheKey(point: LatLng): string {
    return `country:${point.lat.toFixed(2)}:${point.lng.toFixed(2)}`;
  }

  private async readCache(key: string): Promise<string | null> {
    try {
      const raw = await this.redis.get(key);
      return raw && /^[A-Z]{2}$/.test(raw) ? raw : null;
    } catch {
      return null; // a bad cache entry must never break an order
    }
  }

  private async writeCache(key: string, code: string): Promise<void> {
    try {
      // 30 days. Borders move on a scale of years, and the entry is cheap.
      await this.redis.setWithTtl(key, code, 30 * 24 * 3600);
    } catch (err) {
      this.logger.warn(`Could not cache country ${key}: ${(err as Error).message}`);
    }
  }
}
