import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';

export interface EraseResult {
  deviceId: string;
  reportsDeleted: number;
  objectsDeleted: number;
  quotaDeleted: boolean;
}

@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);

  constructor(private readonly prisma: PrismaService, private readonly r2: R2Service) {}

  /**
   * GDPR right-to-erasure: deletes all reports + quota and removes every R2
   * object stored under `free/<deviceId>/*`, `pro/<deviceId>/*` and the photo
   * prefixes — `report-photos/<deviceId>/*` (server-compressed layout) plus the
   * legacy per-report `report-photos/<reportId>/*` keys from the old presigned
   * flow. ReportPhoto rows cascade with `report.deleteMany`.
   *
   * Also erases KYC identity documents (`kyc/<userId>/*`) when this device is
   * linked to a web account — see {@link eraseKycDocuments}. The response shape
   * is unchanged (KYC objects are counted in `objectsDeleted`) because the
   * mobile contract is frozen.
   */
  async erase(deviceId: string): Promise<EraseResult> {
    let objectsDeleted = 0;
    if (this.r2.isConfigured()) {
      for (const prefix of [
        `free/${deviceId}/`,
        `pro/${deviceId}/`,
        `report-photos/${deviceId}/`,
      ]) {
        objectsDeleted += await this.r2.deletePrefix(prefix);
      }
      const reports = await this.prisma.report.findMany({
        where: { deviceId },
        select: { id: true },
      });
      for (const { id } of reports) {
        objectsDeleted += await this.r2.deletePrefix(`report-photos/${id}/`);
      }
    }
    objectsDeleted += await this.eraseKycDocuments(deviceId);
    const { count: reportsDeleted } = await this.prisma.report.deleteMany({
      where: { deviceId },
    });
    const quotaDeleted = await this.prisma.deviceQuota
      .delete({ where: { deviceId } })
      .then(() => true)
      .catch(() => false);

    this.logger.log(
      `GDPR erasure for ${this.mask(deviceId)}: ` +
        `${reportsDeleted} rows, ${objectsDeleted} R2 objects, quota=${quotaDeleted}`,
    );
    return { deviceId, reportsDeleted, objectsDeleted, quotaDeleted };
  }

  /**
   * Erase the KYC identity documents belonging to the account this device is
   * linked to.
   *
   * KYC objects are keyed by `userId`, not `deviceId`, so they are only
   * reachable through a DeviceLink. Without this the most sensitive data the
   * platform holds — passport/ID scans and selfies — survived a right-to-erasure
   * request; the reports and photos went, the identity documents stayed.
   *
   * Deletion sweeps BOTH the dedicated private KYC bucket and the legacy shared
   * one (`R2Service.kycDeletePrefix`), and the matching `KycDocument` rows are
   * stamped `purgedAt` so nothing points at an object that no longer exists.
   * The rows themselves are kept: `KycApplication` carries the audit trail of a
   * review decision, which is a separate retention question from the scans.
   */
  private async eraseKycDocuments(deviceId: string): Promise<number> {
    if (!this.r2.isKycConfigured()) return 0;

    const link = await this.prisma.deviceLink.findUnique({
      where: { deviceId },
      select: { userId: true },
    });
    if (!link) return 0;

    const deleted = await this.r2.kycDeletePrefix(`kyc/${link.userId}/`);
    const { count } = await this.prisma.kycDocument.updateMany({
      where: { purgedAt: null, application: { userId: link.userId } },
      data: { purgedAt: new Date() },
    });
    if (deleted > 0 || count > 0) {
      this.logger.log(
        `GDPR erasure removed ${deleted} KYC object(s) and purged ${count} document row(s) ` +
          `for user=${this.mask(link.userId)}`,
      );
    }
    return deleted;
  }

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
