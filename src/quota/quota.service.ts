import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceQuota } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaDto } from './dto/quota.dto';
import { UpgradeDto } from './dto/upgrade.dto';
import { IapValidatorService } from './iap/iap-validator.service';
import { IapValidationError } from './iap/iap.types';

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly defaultLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly iap: IapValidatorService,
  ) {
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

  async markPro(deviceId: string, dto: UpgradeDto): Promise<DeviceQuota> {
    this.logger.log(
      `PRO activation requested for ${this.mask(deviceId)} via ${dto.platform} (mode=${this.iap.currentMode})`,
    );

    try {
      const result = await this.iap.validate({
        platform: dto.platform,
        receipt: dto.receipt,
        productId: dto.productId,
        environment: dto.environment,
      });
      this.logger.log(
        `IAP validated for ${this.mask(deviceId)}: provider=${result.provider} ` +
          `productId=${result.productId ?? '-'} env=${result.environment} ` +
          `txn=${result.transactionId ?? '-'}`,
      );
    } catch (err) {
      if (err instanceof IapValidationError) {
        this.logger.warn(
          `IAP rejected for ${this.mask(deviceId)}: ${err.reason} (code=${err.providerCode ?? '-'})`,
        );
        throw new BadRequestException({
          error: 'IapValidationFailed',
          message: err.reason,
          providerCode: err.providerCode,
        });
      }
      throw err;
    }

    return this.prisma.deviceQuota.upsert({
      where: { deviceId },
      update: {
        isPro: true,
        proActivatedAt: new Date(),
        proPlatform: dto.platform,
      },
      create: {
        deviceId,
        isPro: true,
        proActivatedAt: new Date(),
        proPlatform: dto.platform,
        freeReportsLimit: this.defaultLimit,
      },
    });
  }

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
