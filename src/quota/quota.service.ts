import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceQuota, Prisma } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaDto } from './dto/quota.dto';
import { UpgradeDto } from './dto/upgrade.dto';
import { IapValidatorService } from './iap/iap-validator.service';
import { IAP_MAX_DEVICES_PER_PURCHASE, IapValidationError } from './iap/iap.types';

/** Serializable transactions that lose a race are retried this many times. */
const GRANT_ATTEMPTS = 3;

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly defaultLimit: number;
  private readonly enforceFreeLimit: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly iap: IapValidatorService,
  ) {
    const quotaConfig = config.get('quota', { infer: true });
    this.defaultLimit = quotaConfig.freeReportsLimit;
    this.enforceFreeLimit = quotaConfig.enforceFreeLimit;
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
      // `freeReportsLimit` and `remaining` are HISTORICAL COUNTERS, not a gate:
      // FREE has been unlimited since 2026-08 (see `enforceFreeLimit`), so
      // `remaining` reaching 0 blocks nothing. They are still emitted verbatim —
      // stored values, `remaining` clamped at 0 — because the shipped Flutter
      // app parses this response through a freezed DTO that declares all three
      // as non-nullable `int`s: nulling or dropping one crashes old clients.
      // PRO is unlimited and has always received 0 here. Keep the value.
      remaining: quota.isPro ? 0 : Math.max(0, quota.freeReportsLimit - quota.freeReportsUsed),
      // Additive — json_serializable ignores unknown keys, so old clients are
      // unaffected; new ones can tell a real paywall from a stale counter.
      freeLimitEnforced: this.enforceFreeLimit,
    };
  }

  async markPro(deviceId: string, dto: UpgradeDto): Promise<DeviceQuota> {
    this.logger.log(
      `PRO activation requested for ${this.mask(deviceId)} via ${dto.platform} (mode=${this.iap.currentMode})`,
    );

    let storeTransactionId: string | undefined;
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
      storeTransactionId = result.storeTransactionId;
      if (result.provider !== 'client-trust' && !storeTransactionId) {
        // Fail closed: without the purchase id the device cap cannot hold.
        throw new IapValidationError('iap_store_unavailable', 'store verdict has no purchase id');
      }
    } catch (err) {
      if (err instanceof IapValidationError) throw this.toHttpError(deviceId, err);
      throw err;
    }

    return this.grantPro(deviceId, dto.platform, storeTransactionId);
  }

  /**
   * Record the (purchase, device) pair and set `isPro`, in one transaction.
   *
   * One purchase may unlock at most `IAP_MAX_DEVICES_PER_PURCHASE` devices; the
   * next NEW device gets 409 `iap_device_limit`. A device that already holds a
   * row for this purchase (a restore, a retry) passes without a new row.
   *
   * SERIALIZABLE, because the check is a count followed by an insert: under
   * READ COMMITTED two new devices could both count 4 and both insert. A lost
   * race is a serialization failure (P2034), or a unique violation (P2002) when
   * the same device raced itself, and is retried.
   *
   * `client-trust` has no purchase id and records nothing.
   */
  private async grantPro(
    deviceId: string,
    platform: UpgradeDto['platform'],
    storeTransactionId: string | undefined,
  ): Promise<DeviceQuota> {
    const markPro = (tx: Prisma.TransactionClient) =>
      tx.deviceQuota.upsert({
        where: { deviceId },
        update: { isPro: true, proActivatedAt: new Date(), proPlatform: platform },
        create: {
          deviceId,
          isPro: true,
          proActivatedAt: new Date(),
          proPlatform: platform,
          freeReportsLimit: this.defaultLimit,
        },
      });

    if (!storeTransactionId) return markPro(this.prisma);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const own = await tx.iapGrant.findUnique({
              where: {
                platform_storeTransactionId_deviceId: { platform, storeTransactionId, deviceId },
              },
            });
            if (!own) {
              const holders = await tx.iapGrant.count({ where: { platform, storeTransactionId } });
              if (holders >= IAP_MAX_DEVICES_PER_PURCHASE) {
                this.logger.warn(
                  `IAP device limit for ${this.mask(deviceId)}: purchase already holds ${holders} devices`,
                );
                throw new ConflictException({
                  error: 'IapDeviceLimit',
                  code: 'iap_device_limit',
                  message: `This purchase is already used on ${IAP_MAX_DEVICES_PER_PURCHASE} devices.`,
                  deviceLimit: IAP_MAX_DEVICES_PER_PURCHASE,
                });
              }
              await tx.iapGrant.create({ data: { platform, storeTransactionId, deviceId } });
            }
            return markPro(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined;
        if ((code === 'P2034' || code === 'P2002') && attempt < GRANT_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /**
   * A refused upgrade grants nothing, whatever the reason. The status says
   * whose problem it is: 400 when the store (or the request) says this is not
   * a valid PRO purchase, 503 when the server could not get a verdict. `code`
   * is machine-readable in both; `error` keeps its legacy value on the 400.
   * The 503 must nest `{ code, message }` in `error`, or `AllExceptionsFilter`
   * masks it as `internal_error`.
   */
  private toHttpError(deviceId: string, err: IapValidationError): HttpException {
    const detail = `${err.code}: ${err.reason} (provider=${err.providerCode ?? '-'})`;
    if (err.unavailable) {
      this.logger.error(`IAP verdict unavailable for ${this.mask(deviceId)} - ${detail}`);
      return new ServiceUnavailableException({
        error: { code: err.code, message: err.reason },
        code: err.code,
        message: err.reason,
        providerCode: err.providerCode,
      });
    }
    this.logger.warn(`IAP rejected for ${this.mask(deviceId)} - ${detail}`);
    return new BadRequestException({
      error: 'IapValidationFailed',
      code: err.code,
      message: err.reason,
      providerCode: err.providerCode,
    });
  }

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
