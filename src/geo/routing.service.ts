import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteEstimate {
  /** Road kilometres, one decimal. */
  distanceKm: number;
  /** Driving minutes, whole. */
  durationMin: number;
  /** How the numbers were obtained — surfaced to the UI so an estimate is labelled as one. */
  source: 'mapbox' | 'haversine';
}

/** Shape of the bits of the Mapbox Directions response we consume. */
interface DirectionsResponse {
  routes?: Array<{ distance?: number; duration?: number }>;
}

const EARTH_RADIUS_KM = 6371;
const REQUEST_TIMEOUT_MS = 2500;
/** Used only by the fallback, to turn a straight line into a plausible drive time. */
const FALLBACK_AVERAGE_KMH = 60;

/**
 * Road distance and travel time between two points.
 *
 * Mapbox **Directions** rather than Matrix: pricing only ever asks about one
 * origin/destination pair (the nearest eligible inspector), so Directions is the
 * right shape and costs one request per quote. Candidate *ranking* stays on
 * PostGIS KNN — we do not route everyone, only the winner.
 *
 * This service NEVER throws and never rejects. A routing outage must degrade the
 * quote, not take the endpoint down, so every failure path falls back to a
 * great-circle distance inflated by a detour factor. `source` tells the caller
 * which happened, and that value reaches the UI.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly token: string;
  private warnedAboutRateLimit = false;

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.token = config.get('mapbox', { infer: true }).token;
    if (!this.token) {
      this.logger.warn('MAPBOX_TOKEN not set — routing falls back to great-circle estimates');
    }
  }

  /** Mirrors StripeService.configured: false means the mock/fallback path. */
  get configured(): boolean {
    return this.token.length > 0;
  }

  /**
   * @param detourFactor multiplier applied to the great-circle distance when
   *   routing is unavailable (a straight line understates a real drive).
   * @param cacheHours TTL for the cached result. Inspector base locations are
   *   static, so the hit rate is high in practice.
   */
  async estimate(
    from: LatLng,
    to: LatLng,
    detourFactor: number,
    cacheHours: number,
  ): Promise<RouteEstimate> {
    const fallback = this.haversineEstimate(from, to, detourFactor);
    if (!this.configured) return fallback;

    const cacheKey = this.cacheKey(from, to);
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const route = await this.fetchRoute(from, to);
    if (!route) return fallback;

    await this.writeCache(cacheKey, route, cacheHours);
    return route;
  }

  // ---- Mapbox ----

  private async fetchRoute(from: LatLng, to: LatLng): Promise<RouteEstimate | null> {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
      `?overview=false&access_token=${encodeURIComponent(this.token)}`;

    try {
      const { data } = await firstValueFrom(
        this.http.get<DirectionsResponse>(url, { timeout: REQUEST_TIMEOUT_MS }),
      );
      const route = data?.routes?.[0];
      if (!route || typeof route.distance !== 'number' || typeof route.duration !== 'number') {
        return null;
      }
      return {
        distanceKm: Math.round((route.distance / 1000) * 10) / 10,
        durationMin: Math.max(1, Math.round(route.duration / 60)),
        source: 'mapbox',
      };
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429 && !this.warnedAboutRateLimit) {
        this.warnedAboutRateLimit = true;
        this.logger.error('Mapbox Directions is rate-limiting us — quotes are using estimates');
      } else if (status !== 429) {
        this.logger.warn(`Directions lookup failed (${String(status ?? 'network')}) — estimating`);
      }
      return null;
    }
  }

  // ---- fallback ----

  private haversineEstimate(from: LatLng, to: LatLng, detourFactor: number): RouteEstimate {
    const factor = Number.isFinite(detourFactor) && detourFactor >= 1 ? detourFactor : 1;
    const straightKm = haversineKm(from, to);
    const distanceKm = Math.round(straightKm * factor * 10) / 10;
    return {
      distanceKm,
      durationMin: Math.max(1, Math.round((distanceKm / FALLBACK_AVERAGE_KMH) * 60)),
      source: 'haversine',
    };
  }

  // ---- cache ----

  /** 4 decimal places ≈ 11 m, which is well inside routing noise. */
  private cacheKey(from: LatLng, to: LatLng): string {
    const r = (n: number) => n.toFixed(4);
    return `route:${r(from.lat)}:${r(from.lng)}:${r(to.lat)}:${r(to.lng)}`;
  }

  private async readCache(key: string): Promise<RouteEstimate | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as RouteEstimate;
      if (typeof parsed?.distanceKm !== 'number' || typeof parsed?.durationMin !== 'number') {
        return null;
      }
      return { ...parsed, source: 'mapbox' };
    } catch {
      return null; // a bad cache entry must never break a quote
    }
  }

  private async writeCache(key: string, route: RouteEstimate, cacheHours: number): Promise<void> {
    const hours = Number.isFinite(cacheHours) && cacheHours > 0 ? cacheHours : 24;
    try {
      await this.redis.setWithTtl(key, JSON.stringify(route), Math.round(hours * 3600));
    } catch (err) {
      this.logger.warn(`Could not cache route ${key}: ${(err as Error).message}`);
    }
  }
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
