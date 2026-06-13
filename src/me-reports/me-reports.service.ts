import { Injectable, Logger } from '@nestjs/common';
import { Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { MeReportItemDto, MeReportListDto } from './dto/me-report.dto';

@Injectable()
export class MeReportsService {
  private readonly logger = new Logger(MeReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
  ) {}

  /**
   * Aggregate the report archive across every device linked to the user.
   * Reports are matched by linked deviceId (the link flow also backfills
   * report.userId, but matching on deviceId keeps it robust to ordering).
   */
  async listForUser(userId: string): Promise<MeReportListDto> {
    const links = await this.prisma.deviceLink.findMany({
      where: { userId },
      select: { deviceId: true },
    });
    const deviceIds = links.map((l) => l.deviceId);
    if (deviceIds.length === 0) {
      return { items: [], total: 0 };
    }

    const reports = await this.prisma.report.findMany({
      where: { deviceId: { in: deviceIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const items = await Promise.all(reports.map((r) => this.toItem(r)));
    return { items, total: items.length };
  }

  private async toItem(r: Report): Promise<MeReportItemDto> {
    const item: MeReportItemDto = {
      id: r.id,
      code: r.code,
      vin: r.vin,
      make: r.make,
      model: r.model,
      year: r.year,
      mileageKm: r.mileageKm,
      color: r.color,
      bodyType: r.bodyType,
      driveType: r.driveType,
      qualityScore: r.qualityScore,
      tier: r.tier as 'free' | 'pro',
      uploaded: r.uploaded,
      inspectedAt: r.inspectedAt ? r.inspectedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
    if (r.uploaded && this.r2.isConfigured()) {
      try {
        const { url, expiresAt } = await this.r2.createPresignedDownloadUrl(r.s3Key);
        item.downloadUrl = url;
        item.downloadUrlExpiresAt = expiresAt.toISOString();
      } catch (err) {
        this.logger.warn(`Failed to sign download URL for ${r.id}: ${(err as Error).message}`);
      }
    }
    return item;
  }
}
