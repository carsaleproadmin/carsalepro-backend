import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceQuota } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaDto } from './dto/quota.dto';

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly defaultLimit: number;

  constructor(private readonly prisma: PrismaService, config: ConfigService<AppConfig, true>) {
    this.defaultLimit = config.get('quota', { infer: true }).freeReportsLimit;
  }

  async getOrInit(deviceId: string): Promise<DeviceQuota> {
    return this.prisma.deviceQuota.upsert({
      where: { deviceId },
      update: {},
      create: { deviceId, freeReportsLimit: this.defaultLimit },
    });
  }

  toDto(quota: DeviceQuota): QuotaDto {
    return {
      deviceId: quota.deviceId,
      freeReportsUsed: quota.freeReportsUsed,
      freeReportsLimit: quota.freeReportsLimit,
      isPro: quota.isPro,
      remaining: quota.isPro
        ? Number.POSITIVE_INFINITY === Infinity
          ? 0
          : 0
        : Math.max(0, quota.freeReportsLimit - quota.freeReportsUsed),
    };
  }

  async markPro(deviceId: string, platform: 'ios' | 'android', receipt: string): Promise<DeviceQuota> {
    this.logger.log(`PRO activation requested for device ${this.mask(deviceId)} via ${platform}`);
    // MVP: trust client. Phase 2: validate receipt via App Store Server API / Play Developer API.
    void receipt; // referenced to satisfy linter; persistence intentionally omitted (PII / receipt size)
    return this.prisma.deviceQuota.upsert({
      where: { deviceId },
      update: {
        isPro: true,
        proActivatedAt: new Date(),
        proPlatform: platform,
      },
      create: {
        deviceId,
        isPro: true,
        proActivatedAt: new Date(),
        proPlatform: platform,
        freeReportsLimit: this.defaultLimit,
      },
    });
  }

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
