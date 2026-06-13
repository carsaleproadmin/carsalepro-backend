import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const LINK_CODE_TTL_SECONDS = 600; // 10 minutes
const LINK_CODE_PREFIX = 'linkcode:';

@Injectable()
export class LinkCodesService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Generate a single-use 6-digit numeric code bound to a device. The code is
   * stored in Redis (or the in-memory fallback) with a 10-minute TTL.
   */
  async generate(deviceId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.setWithTtl(`${LINK_CODE_PREFIX}${code}`, deviceId, LINK_CODE_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_SECONDS * 1000);
    return { code, expiresAt };
  }

  /**
   * Resolve and consume a code (single-use): returns the bound deviceId and
   * deletes the key, or null if the code is unknown/expired.
   */
  async consume(code: string): Promise<string | null> {
    const key = `${LINK_CODE_PREFIX}${code}`;
    const deviceId = await this.redis.get(key);
    if (!deviceId) return null;
    await this.redis.del(key);
    return deviceId;
  }
}
