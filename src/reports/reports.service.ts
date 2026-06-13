import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma, Report } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { CreateReportDto } from './dto/create-report.dto';
import {
  CompleteReportResponseDto,
  CreateReportResponseDto,
  ReportItemDto,
  ReportListDto,
} from './dto/report-response.dto';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly defaultLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly moduleRef: ModuleRef,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultLimit = config.get('quota', { infer: true }).freeReportsLimit;
  }

  async create(deviceId: string, dto: CreateReportDto): Promise<CreateReportResponseDto> {
    // Quota gate runs first so the 402 contract is testable without R2 creds.
    const { quota, tier } = await this.consumeQuota(deviceId);

    if (!this.r2.isConfigured()) {
      // Roll back the quota increment we just made
      await this.rollbackQuota(deviceId, tier);
      throw new HttpException(
        'Cloud storage is not configured on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const report = await this.prisma.report.create({
      data: {
        deviceId,
        code: dto.code,
        vin: dto.vin?.toUpperCase() ?? null,
        make: dto.make ?? null,
        model: dto.model ?? null,
        inspectedAt: dto.inspectedAt ? new Date(dto.inspectedAt) : null,
        sizeBytes: dto.sizeBytes ?? null,
        hash: dto.hash ?? null,
        tier,
        s3Key: '', // filled below
        // --- website extension fields (all optional) ---
        orderId: dto.orderId ?? null,
        qualityScore: dto.qualityScore ?? null,
        year: dto.year ?? null,
        mileageKm: dto.mileageKm ?? null,
        color: dto.color ?? null,
        bodyType: dto.bodyType ?? null,
        driveType: dto.driveType ?? null,
        reportData:
          dto.reportData !== undefined ? (dto.reportData as Prisma.InputJsonValue) : undefined,
        photosManifest:
          dto.photosManifest !== undefined
            ? (dto.photosManifest as Prisma.InputJsonValue)
            : undefined,
      },
    });

    const s3Key = this.r2.buildKey(tier, deviceId, report.id);
    const updated = await this.prisma.report.update({
      where: { id: report.id },
      data: { s3Key },
    });

    const { url, expiresAt } = await this.r2.createPresignedUploadUrl(
      s3Key,
      dto.contentType ?? 'application/pdf',
    );

    // Marketplace integration: when a report is filed against an order, advance
    // that order to SUBMITTED (set submittedAt + autoApproveAt). The mobile
    // response/quota/402 contract above is unchanged — this is an additive side
    // effect that never affects the returned shape or status code.
    if (dto.orderId) {
      await this.submitOrderForReport(dto.orderId);
    }

    this.logger.log(
      `Reserved report ${report.id} for device=${this.mask(deviceId)} tier=${tier} ` +
        `freeUsed=${quota.freeReportsUsed}/${quota.freeReportsLimit}`,
    );

    return {
      reportId: updated.id,
      s3Key: updated.s3Key,
      presignedUploadUrl: url,
      expiresAt: expiresAt.toISOString(),
      tier,
    };
  }

  /**
   * Advance the linked order to SUBMITTED via OrdersService (the single place
   * for order transitions). Resolved lazily through ModuleRef to avoid a
   * circular module dependency. Best-effort: a failure here must never break the
   * report-create contract, so errors are swallowed (logged).
   */
  private async submitOrderForReport(orderId: string): Promise<void> {
    try {
      const { OrdersService } = await import('../orders/orders.service');
      const orders = this.moduleRef.get(OrdersService, { strict: false });
      await orders.submitReportForOrder(orderId);
    } catch (err) {
      this.logger.warn(`Could not submit order ${orderId} for report: ${(err as Error).message}`);
    }
  }

  async complete(deviceId: string, reportId: string): Promise<CompleteReportResponseDto> {
    const report = await this.requireOwned(deviceId, reportId);
    if (report.uploaded) {
      return { id: report.id, uploaded: true };
    }
    const exists = await this.r2.objectExists(report.s3Key);
    if (!exists) {
      throw new NotFoundException('Upload not found in cloud storage');
    }
    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: { uploaded: true },
    });
    return { id: updated.id, uploaded: updated.uploaded };
  }

  async list(deviceId: string): Promise<ReportListDto> {
    const reports = await this.prisma.report.findMany({
      where: { deviceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const items = await Promise.all(reports.map((r) => this.toItemDto(r)));
    return { items, total: items.length };
  }

  async remove(deviceId: string, reportId: string): Promise<{ id: string; deleted: true }> {
    const report = await this.requireOwned(deviceId, reportId);
    if (this.r2.isConfigured()) {
      await this.r2.deleteObject(report.s3Key);
    }
    await this.prisma.report.update({
      where: { id: reportId },
      data: { deletedAt: new Date() },
    });
    return { id: reportId, deleted: true };
  }

  /**
   * Reserve a presigned upload URL for an individual report photo. The report
   * must be owned by the requesting device. Photo keys live under a dedicated
   * `report-photos/<reportId>/` prefix (separate from the report PDF layout).
   */
  async createPhotoUploadUrl(
    deviceId: string,
    reportId: string,
    kind: string,
  ): Promise<{ presignedUploadUrl: string; s3Key: string; expiresAt: string }> {
    await this.requireOwned(deviceId, reportId);

    if (!this.r2.isConfigured()) {
      throw new HttpException(
        'Cloud storage is not configured on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const s3Key = `report-photos/${reportId}/${kind}-${randomUUID()}.jpg`;
    const { url, expiresAt } = await this.r2.createPresignedUploadUrl(s3Key, 'image/jpeg');

    this.logger.log(
      `Reserved photo upload for report ${reportId} device=${this.mask(deviceId)} kind=${kind}`,
    );

    return {
      presignedUploadUrl: url,
      s3Key,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async rollbackQuota(deviceId: string, tier: 'free' | 'pro'): Promise<void> {
    if (tier !== 'free') return;
    await this.prisma.deviceQuota
      .update({
        where: { deviceId },
        data: { freeReportsUsed: { decrement: 1 } },
      })
      .catch(() => undefined);
  }

  /**
   * Atomically pick a tier and increment the FREE counter when applicable.
   * 402 Payment Required is returned when the device is non-PRO and has hit the limit.
   */
  private async consumeQuota(
    deviceId: string,
  ): Promise<{ quota: { freeReportsUsed: number; freeReportsLimit: number; isPro: boolean }; tier: 'free' | 'pro' }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.deviceQuota.upsert({
        where: { deviceId },
        update: {},
        create: { deviceId, freeReportsLimit: this.defaultLimit },
      });

      if (existing.isPro) {
        return {
          quota: {
            freeReportsUsed: existing.freeReportsUsed,
            freeReportsLimit: existing.freeReportsLimit,
            isPro: true,
          },
          tier: 'pro' as const,
        };
      }

      if (existing.freeReportsUsed >= existing.freeReportsLimit) {
        throw new HttpException(
          {
            error: 'PaymentRequired',
            message:
              `FREE-tier limit of ${existing.freeReportsLimit} reports reached. Upgrade to PRO to continue.`,
            freeReportsUsed: existing.freeReportsUsed,
            freeReportsLimit: existing.freeReportsLimit,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      const updated = await tx.deviceQuota.update({
        where: { deviceId },
        data: { freeReportsUsed: { increment: 1 } },
      });
      return {
        quota: {
          freeReportsUsed: updated.freeReportsUsed,
          freeReportsLimit: updated.freeReportsLimit,
          isPro: updated.isPro,
        },
        tier: 'free' as const,
      };
    });
  }

  private async requireOwned(deviceId: string, reportId: string): Promise<Report> {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report || report.deletedAt) {
      throw new NotFoundException(`Report ${reportId} not found`);
    }
    if (report.deviceId !== deviceId) {
      // Don't reveal existence to other devices
      throw new ForbiddenException('You do not own this report');
    }
    return report;
  }

  private async toItemDto(r: Report): Promise<ReportItemDto> {
    const base: ReportItemDto = {
      id: r.id,
      code: r.code,
      vin: r.vin,
      make: r.make,
      model: r.model,
      inspectedAt: r.inspectedAt ? r.inspectedAt.toISOString() : null,
      tier: r.tier as 'free' | 'pro',
      sizeBytes: r.sizeBytes,
      uploaded: r.uploaded,
      createdAt: r.createdAt.toISOString(),
    };
    if (r.uploaded && this.r2.isConfigured()) {
      try {
        const { url, expiresAt } = await this.r2.createPresignedDownloadUrl(r.s3Key);
        base.downloadUrl = url;
        base.downloadUrlExpiresAt = expiresAt.toISOString();
      } catch (err) {
        this.logger.warn(`Failed to sign download URL for ${r.id}: ${(err as Error).message}`);
      }
    }
    return base;
  }

  async knownPrismaErrorCode(err: unknown): Promise<string | null> {
    if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
    return null;
  }

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
