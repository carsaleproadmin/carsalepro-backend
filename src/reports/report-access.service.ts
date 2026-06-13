import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, Report } from '@prisma/client';
import { PaymentsService } from '../payments/payments.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import {
  FullReportDto,
  FullReportPhotoDto,
  ReportDownloadDto,
} from './dto/report-access.dto';

type PhotoRef = { s3Key?: string; kind?: string; angle?: string };

/**
 * Website-facing report access (Reports Store). Gates every read through
 * PaymentsService.assertReportAccess (owner or pay-per-view purchaser) and
 * returns signed URLs for the PDF + photos.
 */
@Injectable()
export class ReportAccessService {
  private readonly logger = new Logger(ReportAccessService.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly r2: R2Service,
    private readonly settings: SettingsService,
  ) {}

  async getFull(userId: string, reportId: string): Promise<FullReportDto> {
    const report = await this.payments.assertReportAccess(userId, reportId);
    const photos = await this.signPhotos(report.photosManifest);
    const pdf = await this.signPdf(report);

    return {
      id: report.id,
      code: report.code,
      createdAt: report.createdAt.toISOString(),
      qualityScore: report.qualityScore,
      tier: report.tier as 'free' | 'pro',
      vehicle: {
        vin: report.vin,
        make: report.make,
        model: report.model,
        year: report.year,
        mileageKm: report.mileageKm,
        color: report.color,
        bodyType: report.bodyType,
        driveType: report.driveType,
      },
      reportData: (report.reportData ?? null) as Record<string, unknown> | null,
      photos,
      pdf,
    };
  }

  async getDownload(userId: string, reportId: string): Promise<ReportDownloadDto> {
    const report = await this.payments.assertReportAccess(userId, reportId);
    if (!this.r2.isConfigured()) {
      throw new HttpException(
        { error: { code: 'storage_unavailable', message: 'Cloud storage is not configured' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const { url } = await this.r2.createPresignedDownloadUrl(report.s3Key);
    return { signedUrl: url, expiresAt: await this.expiresAt() };
  }

  /** Sign the report PDF; null when R2 unconfigured or the PDF wasn't uploaded. */
  private async signPdf(report: Report): Promise<FullReportDto['pdf']> {
    if (!report.s3Key || !this.r2.isConfigured()) {
      return { downloadUrl: null, expiresAt: null };
    }
    try {
      const { url } = await this.r2.createPresignedDownloadUrl(report.s3Key);
      return { downloadUrl: url, expiresAt: await this.expiresAt() };
    } catch (err) {
      this.logger.warn(`Failed to sign PDF for ${report.id}: ${(err as Error).message}`);
      return { downloadUrl: null, expiresAt: null };
    }
  }

  private async signPhotos(manifest: Prisma.JsonValue | null): Promise<FullReportPhotoDto[]> {
    if (!Array.isArray(manifest) || !this.r2.isConfigured()) return [];
    const refs = (manifest as PhotoRef[]).filter((p) => p?.s3Key);
    const out: FullReportPhotoDto[] = [];
    for (const ref of refs) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(ref.s3Key!);
        out.push({ url, kind: ref.kind, angle: ref.angle });
      } catch {
        /* skip unsignable */
      }
    }
    return out;
  }

  /** Expiry timestamp derived from the configurable signedUrlTtlMinutes setting. */
  private async expiresAt(): Promise<string> {
    const minutes = await this.settings.getNumber('signedUrlTtlMinutes');
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }
}
