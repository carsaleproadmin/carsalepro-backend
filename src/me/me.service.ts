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
   * GDPR right-to-erasure: deletes all reports + quota and removes every R2 object
   * stored under `free/<deviceId>/*` and `pro/<deviceId>/*`.
   */
  async erase(deviceId: string): Promise<EraseResult> {
    let objectsDeleted = 0;
    if (this.r2.isConfigured()) {
      for (const prefix of [`free/${deviceId}/`, `pro/${deviceId}/`]) {
        objectsDeleted += await this.r2.deletePrefix(prefix);
      }
    }
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

  private mask(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
