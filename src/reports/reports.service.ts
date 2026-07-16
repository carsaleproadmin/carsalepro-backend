import { createHash, randomUUID } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma, Report, ReportPhoto } from '@prisma/client';
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
import { UpdateReportDto, UpdateReportResponseDto } from './dto/update-report.dto';
import { ReportPhotoDto, ReportPhotoListDto, UploadPhotoDto } from './dto/upload-photo.dto';
import { PhotoProcessingService } from './photo-processing.service';
import {
  extractDenormalizedFields,
  ExtractedReportFields,
  validateReportDataV1,
} from './report-data.validator';

const UUID_CODE_RE =
  /^CSP-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly defaultLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly moduleRef: ModuleRef,
    private readonly photoProcessing: PhotoProcessingService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultLimit = config.get('quota', { infer: true }).freeReportsLimit;
  }

  async create(deviceId: string, dto: CreateReportDto): Promise<CreateReportResponseDto> {
    // Structured-payload validation runs BEFORE any quota is consumed so a 400
    // never burns a free credit.
    const extracted = this.validatePayload(dto.reportSchemaVersion, dto.reportData);

    // Idempotent create: a UUID code re-posted by the same device (mobile retry
    // after a network drop, or a re-finish) returns the existing report with a
    // fresh upload URL — no second quota charge.
    if (UUID_CODE_RE.test(dto.code)) {
      const existing = await this.prisma.report.findFirst({
        where: { deviceId, code: dto.code, deletedAt: null },
      });
      if (existing) {
        return this.recreate(deviceId, existing, dto, extracted);
      }
    }

    // Quota gate runs before R2 so the 402 contract is testable without R2 creds.
    const { quota, tier } = await this.consumeQuota(deviceId);

    if (!this.r2.isConfigured()) {
      // Roll back the quota increment we just made
      await this.rollbackQuota(deviceId, tier);
      throw new HttpException(
        'Cloud storage is not configured on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    let report: Report;
    try {
      report = await this.prisma.report.create({
        data: {
          deviceId,
          code: dto.code,
          vin: dto.vin?.toUpperCase() ?? extracted?.vin ?? null,
          make: dto.make ?? extracted?.make ?? null,
          model: dto.model ?? extracted?.model ?? null,
          inspectedAt: dto.inspectedAt ? new Date(dto.inspectedAt) : null,
          finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : null,
          sizeBytes: dto.sizeBytes ?? null,
          hash: dto.hash ?? null,
          tier,
          s3Key: '', // filled below
          reportSchemaVersion: dto.reportSchemaVersion ?? null,
          // --- website extension fields (all optional) ---
          orderId: dto.orderId ?? null,
          qualityScore: dto.qualityScore ?? extracted?.qualityScore ?? null,
          year: dto.year ?? extracted?.year ?? null,
          mileageKm: dto.mileageKm ?? extracted?.mileageKm ?? null,
          color: dto.color ?? extracted?.color ?? null,
          bodyType: dto.bodyType ?? extracted?.bodyType ?? null,
          driveType: dto.driveType ?? extracted?.driveType ?? null,
          reportData:
            dto.reportData !== undefined ? (dto.reportData as Prisma.InputJsonValue) : undefined,
          photosManifest:
            dto.photosManifest !== undefined
              ? (dto.photosManifest as Prisma.InputJsonValue)
              : undefined,
        },
      });
    } catch (err) {
      await this.rollbackQuota(deviceId, tier);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Cross-device collision on the partial unique code index — practically
        // impossible for honest UUID v4 clients, so refuse loudly.
        throw new ConflictException({
          error: 'code_conflict',
          message: `Report code ${dto.code} is already registered to another device`,
        });
      }
      throw err;
    }

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
   * Idempotent-create hit: refresh metadata + mint a new PDF upload URL for an
   * existing report. The response mirrors a fresh create (plus `reused: true`)
   * so mobile retry logic needs no special casing. Quota untouched.
   */
  private async recreate(
    deviceId: string,
    existing: Report,
    dto: CreateReportDto,
    extracted: ExtractedReportFields | undefined,
  ): Promise<CreateReportResponseDto> {
    if (!this.r2.isConfigured()) {
      throw new HttpException(
        'Cloud storage is not configured on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const updated = await this.prisma.report.update({
      where: { id: existing.id },
      data: {
        vin: dto.vin?.toUpperCase() ?? extracted?.vin ?? existing.vin,
        make: dto.make ?? extracted?.make ?? existing.make,
        model: dto.model ?? extracted?.model ?? existing.model,
        inspectedAt: dto.inspectedAt ? new Date(dto.inspectedAt) : existing.inspectedAt,
        finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : existing.finishedAt,
        sizeBytes: dto.sizeBytes ?? existing.sizeBytes,
        hash: dto.hash ?? existing.hash,
        reportSchemaVersion: dto.reportSchemaVersion ?? existing.reportSchemaVersion,
        qualityScore: dto.qualityScore ?? extracted?.qualityScore ?? existing.qualityScore,
        year: dto.year ?? extracted?.year ?? existing.year,
        mileageKm: dto.mileageKm ?? extracted?.mileageKm ?? existing.mileageKm,
        color: dto.color ?? extracted?.color ?? existing.color,
        bodyType: dto.bodyType ?? extracted?.bodyType ?? existing.bodyType,
        driveType: dto.driveType ?? extracted?.driveType ?? existing.driveType,
        reportData:
          dto.reportData !== undefined ? (dto.reportData as Prisma.InputJsonValue) : undefined,
        // A new PDF is coming — require a fresh /complete verification.
        uploaded: false,
      },
    });

    const { url, expiresAt } = await this.r2.createPresignedUploadUrl(
      updated.s3Key,
      dto.contentType ?? 'application/pdf',
    );

    this.logger.log(
      `Idempotent re-create of report ${updated.id} device=${this.mask(deviceId)} (no quota)`,
    );

    return {
      reportId: updated.id,
      s3Key: updated.s3Key,
      presignedUploadUrl: url,
      expiresAt: expiresAt.toISOString(),
      tier: updated.tier as 'free' | 'pro',
      reused: true,
    };
  }

  /**
   * Re-sync of an edited finished report. Idempotent; NEVER consumes quota.
   */
  async update(
    deviceId: string,
    reportId: string,
    dto: UpdateReportDto,
  ): Promise<UpdateReportResponseDto> {
    const report = await this.requireOwned(deviceId, reportId);
    const extracted = this.validatePayload(dto.reportSchemaVersion, dto.reportData);

    const updated = await this.prisma.report.update({
      where: { id: report.id },
      data: {
        vin: dto.vin?.toUpperCase() ?? extracted?.vin ?? report.vin,
        make: dto.make ?? extracted?.make ?? report.make,
        model: dto.model ?? extracted?.model ?? report.model,
        inspectedAt: dto.inspectedAt ? new Date(dto.inspectedAt) : report.inspectedAt,
        finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : report.finishedAt,
        sizeBytes: dto.sizeBytes ?? report.sizeBytes,
        hash: dto.hash ?? report.hash,
        reportSchemaVersion: dto.reportSchemaVersion ?? report.reportSchemaVersion,
        qualityScore: dto.qualityScore ?? extracted?.qualityScore ?? report.qualityScore,
        year: dto.year ?? extracted?.year ?? report.year,
        mileageKm: dto.mileageKm ?? extracted?.mileageKm ?? report.mileageKm,
        color: dto.color ?? extracted?.color ?? report.color,
        bodyType: dto.bodyType ?? extracted?.bodyType ?? report.bodyType,
        driveType: dto.driveType ?? extracted?.driveType ?? report.driveType,
        reportData:
          dto.reportData !== undefined ? (dto.reportData as Prisma.InputJsonValue) : undefined,
        ...(dto.regeneratePdfUploadUrl ? { uploaded: false } : {}),
      },
    });

    const response: UpdateReportResponseDto = {
      reportId: updated.id,
      code: updated.code,
      updatedAt: updated.updatedAt.toISOString(),
    };

    if (dto.regeneratePdfUploadUrl) {
      if (!this.r2.isConfigured()) {
        throw new HttpException(
          'Cloud storage is not configured on this server',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      const { url, expiresAt } = await this.r2.createPresignedUploadUrl(
        updated.s3Key,
        'application/pdf',
      );
      response.presignedUploadUrl = url;
      response.expiresAt = expiresAt.toISOString();
    }

    return response;
  }

  /**
   * Validate the structured payload when a contract version is claimed and
   * return the denormalized listing fields. Legacy free-form payloads (no
   * version) pass through untouched.
   */
  private validatePayload(
    schemaVersion: number | undefined,
    reportData: Record<string, unknown> | undefined,
  ): ExtractedReportFields | undefined {
    if (schemaVersion !== 1) return undefined;
    const data = validateReportDataV1(reportData);
    return extractDenormalizedFields(data);
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
      // Server-compressed photos (new layout) + legacy presigned photos.
      await this.r2.deletePrefix(`report-photos/${deviceId}/${reportId}/`);
      await this.r2.deletePrefix(`report-photos/${reportId}/`);
    }
    await this.prisma.reportPhoto.deleteMany({ where: { reportId } });
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

  /**
   * Multipart photo upload: compress server-side (sharp) and store in R2 under
   * `report-photos/<deviceId>/<reportId>/<kind>-<position>-<hash8>.jpg`.
   * `(reportId, kind, position)` is the logical slot — re-uploading it replaces
   * the stored photo; an identical original (same sha-256) short-circuits.
   */
  async uploadPhoto(
    deviceId: string,
    reportId: string,
    dto: UploadPhotoDto,
    file: Express.Multer.File,
  ): Promise<ReportPhotoDto> {
    const report = await this.requireOwned(deviceId, reportId);

    if (!this.r2.isConfigured()) {
      throw new HttpException(
        'Cloud storage is not configured on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const position = dto.position ?? 0;
    const originalHash = createHash('sha256').update(file.buffer).digest('hex');
    if (dto.hash && dto.hash.toLowerCase() !== originalHash) {
      throw new HttpException(
        { error: 'hash_mismatch', message: 'Provided hash does not match the uploaded bytes' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.prisma.reportPhoto.findUnique({
      where: { reportId_kind_position: { reportId, kind: dto.kind, position } },
    });
    if (existing && existing.hash === originalHash) {
      // Same original re-sent (mobile retry) — nothing to do.
      return this.toPhotoDto(existing, false);
    }

    const processed = await this.photoProcessing.compress(file.buffer);
    const r2Key =
      `report-photos/${deviceId}/${reportId}/` +
      `${dto.kind}-${position}-${originalHash.slice(0, 8)}.jpg`;

    await this.r2.putObject(r2Key, processed.data, 'image/jpeg');

    const data = {
      kind: dto.kind,
      position,
      r2Key,
      sizeBytes: processed.sizeBytes,
      sourceBytes: file.size,
      width: processed.width,
      height: processed.height,
      format: processed.format,
      hash: originalHash,
    };

    const row = existing
      ? await this.prisma.reportPhoto.update({ where: { id: existing.id }, data })
      : await this.prisma.reportPhoto.create({ data: { reportId, ...data } });

    // Replaced slot: drop the superseded object (key differs via hash suffix).
    if (existing && existing.r2Key !== r2Key) {
      await this.r2.deleteObject(existing.r2Key).catch(() => undefined);
    }

    await this.mirrorPhotosManifest(reportId);

    this.logger.log(
      `Stored photo ${dto.kind}#${position} for report ${reportId} ` +
        `device=${this.mask(deviceId)} ${file.size}→${processed.sizeBytes} bytes`,
    );

    return this.toPhotoDto(row, existing !== null);
  }

  async listPhotos(deviceId: string, reportId: string): Promise<ReportPhotoListDto> {
    await this.requireOwned(deviceId, reportId);
    const rows = await this.prisma.reportPhoto.findMany({
      where: { reportId },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    });
    const items = await Promise.all(rows.map((r) => this.toPhotoDto(r, false)));
    return { items, total: items.length };
  }

  async deletePhoto(
    deviceId: string,
    reportId: string,
    photoId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.requireOwned(deviceId, reportId);
    const photo = await this.prisma.reportPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.reportId !== reportId) {
      throw new NotFoundException(`Photo ${photoId} not found`);
    }
    if (this.r2.isConfigured()) {
      await this.r2.deleteObject(photo.r2Key);
    }
    await this.prisma.reportPhoto.delete({ where: { id: photoId } });
    await this.mirrorPhotosManifest(reportId);
    return { id: photoId, deleted: true };
  }

  /**
   * Keep `report.photosManifest` in sync with the ReportPhoto rows so existing
   * website consumers (`signPhotos`, showroom, PPV) keep working unmodified.
   */
  private async mirrorPhotosManifest(reportId: string): Promise<void> {
    const rows = await this.prisma.reportPhoto.findMany({
      where: { reportId },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }],
      select: { r2Key: true, kind: true },
    });
    await this.prisma.report.update({
      where: { id: reportId },
      data: {
        photosManifest: rows.map((r) => ({ s3Key: r.r2Key, kind: r.kind })) as Prisma.InputJsonValue,
      },
    });
  }

  private async toPhotoDto(row: ReportPhoto, replaced: boolean): Promise<ReportPhotoDto> {
    const dto: ReportPhotoDto = {
      photoId: row.id,
      kind: row.kind,
      position: row.position,
      r2Key: row.r2Key,
      width: row.width,
      height: row.height,
      sizeBytes: row.sizeBytes,
      replaced,
      createdAt: row.createdAt.toISOString(),
    };
    if (this.r2.isConfigured()) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(row.r2Key);
        dto.url = url;
      } catch (err) {
        this.logger.warn(`Failed to sign photo URL for ${row.id}: ${(err as Error).message}`);
      }
    }
    return dto;
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
