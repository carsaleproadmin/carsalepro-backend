import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Report } from '@prisma/client';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
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
    private readonly prisma: PrismaService,
  ) {}

  async getFull(userId: string, reportId: string): Promise<FullReportDto> {
    const report = await this.payments.assertReportAccess(userId, reportId);
    return this.toFull(report);
  }

  /**
   * The same payload for an admin (DEN-312). There is no owner check: the
   * caller is `@Roles(Role.ADMIN)` in `AdminReportsController`.
   */
  async getFullForAdmin(reportId: string): Promise<FullReportDto> {
    return this.toFull(await this.findForAdmin(reportId));
  }

  async getDownload(userId: string, reportId: string): Promise<ReportDownloadDto> {
    const report = await this.payments.assertReportAccess(userId, reportId);
    return this.toDownload(report);
  }

  /** The signed PDF URL for an admin (DEN-312). */
  async getDownloadForAdmin(reportId: string): Promise<ReportDownloadDto> {
    return this.toDownload(await this.findForAdmin(reportId));
  }

  /** Same 404 shape as `PaymentsService.assertReportAccess`. */
  private async findForAdmin(reportId: string): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        error: { code: 'not_found', message: `Report ${reportId} not found` },
      });
    }
    return report;
  }

  private async toFull(report: Report): Promise<FullReportDto> {
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

  private async toDownload(report: Report): Promise<ReportDownloadDto> {
    if (!this.r2.isConfigured()) {
      throw new HttpException(
        { error: { code: 'storage_unavailable', message: 'Cloud storage is not configured' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // `s3Key` is reserved at create time, but the object exists only after
    // POST /reports/:id/complete flips `uploaded`. Presigning is an offline
    // operation that succeeds for a key that was never written, so without
    // this gate the caller receives a valid-looking URL that answers R2
    // `NoSuchKey` in the browser. Refuse here, where the reason is known.
    if (!report.uploaded) {
      throw new HttpException(
        {
          error: {
            code: 'report_not_uploaded',
            message: 'The report PDF was not uploaded yet',
          },
        },
        HttpStatus.CONFLICT,
      );
    }
    // The expiry comes from the same call that signed the URL. It used to come
    // from a platform setting that R2 never read, so it disagreed with the real
    // lifetime of the link (DEN-293).
    const { url, expiresAt } = await this.r2.createPresignedDownloadUrl(report.s3Key);
    return { signedUrl: url, expiresAt: expiresAt.toISOString() };
  }

  /** Sign the report PDF; null when R2 unconfigured or the PDF wasn't uploaded. */
  private async signPdf(report: Report): Promise<FullReportDto['pdf']> {
    // `uploaded` is the only proof the object exists — see getDownload().
    if (!report.s3Key || !report.uploaded || !this.r2.isConfigured()) {
      return { downloadUrl: null, expiresAt: null };
    }
    try {
      const { url, expiresAt } = await this.r2.createPresignedDownloadUrl(report.s3Key);
      return { downloadUrl: url, expiresAt: expiresAt.toISOString() };
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
}
