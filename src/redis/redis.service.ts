import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';

interface MapEntry {
  value: string;
  expiresAt: number;
}

/**
 * Thin key/value abstraction over Redis with a built-in in-memory fallback.
 *
 * When `REDIS_URL` is empty (dev/CI without a Redis server) the service stores
 * values in a process-local Map with manual TTL expiry so link-code flows and
 * tests work without external infrastructure. When a URL is present it uses
 * ioredis with `lazyConnect` so app boot never blocks on / crashes from an
 * unreachable Redis.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;
  private readonly fallback = new Map<string, MapEntry>();

  constructor(config: ConfigService<AppConfig, true>) {
    const url = config.get('redis', { infer: true }).url;
    if (url) {
      // lazyConnect avoids blocking app boot; the offline queue (default on)
      // buffers the first command until the connection establishes — disabling
      // it together with lazyConnect makes the first command fail with
      // "Stream isn't writeable".
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
      this.client.on('error', (err) => {
        this.logger.warn(`Redis connection error: ${err.message}`);
      });
      this.logger.log('Redis client configured (lazy connect)');
    } else {
      this.logger.warn('REDIS_URL not set — using in-memory key/value fallback');
    }
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.client) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    this.fallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    if (this.client) {
      return this.client.get(key);
    }
    const entry = this.fallback.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.fallback.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<void> {
    if (this.client) {
      await this.client.del(key);
      return;
    }
    this.fallback.delete(key);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }
}
