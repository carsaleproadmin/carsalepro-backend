import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeviceLink, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LinkCodesService } from '../link-codes/link-codes.service';
import { UpdateMeDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly linkCodes: LinkCodesService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        locale: true,
        countryCode: true,
        role: true,
        kycVerified: true,
        emailVerified: true,
        notificationPrefs: true,
        createdAt: true,
        inspector: { select: { stripeOnboarded: true, available: true } },
      },
    });
    if (!user || (await this.isDeleted(userId))) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'User not found' } });
    }
    return user;
  }

  private async isDeleted(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    return !!u?.deletedAt;
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        phone: dto.phone,
        locale: dto.locale,
        notificationPrefs: dto.notificationPrefs as Prisma.InputJsonValue | undefined,
      },
    });
    return this.getMe(userId);
  }

  /**
   * GDPR right to erasure (W.4.6): anonymize PII, revoke access tokens/links,
   * hide listings. Orders/payments are kept for accounting but no longer carry
   * personal data (it lived on the User row). KYC document purge from R2 is
   * handled by the KYC module (E8); here we drop the metadata rows.
   */
  async eraseMe(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const tombstone = `deleted+${userId}@carsalepro.invalid`;
      await tx.authAccount.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { userId } });
      await tx.deviceLink.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.listing.updateMany({
        where: { sellerId: userId },
        data: { status: 'DELETED' },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: tombstone,
          emailVerified: null,
          passwordHash: null,
          name: null,
          phone: null,
          totpSecret: null,
          notificationPrefs: Prisma.DbNull,
          deletedAt: new Date(),
        },
      });
    });
    this.logger.log(`User ${userId.slice(0, 6)}… erased (GDPR)`);
  }

  /**
   * Link a mobile device to the user via a one-time code generated on the
   * device. Backfills existing reports so the device archive appears in the
   * web cabinet immediately.
   */
  async linkDeviceByCode(userId: string, linkCode: string): Promise<DeviceLink> {
    const deviceId = await this.linkCodes.consume(linkCode);
    if (!deviceId) {
      throw new BadRequestException({
        error: { code: 'invalid_code', message: 'Link code is invalid or expired' },
      });
    }
    return this.attachDevice(userId, deviceId, 'code');
  }

  /** List all devices linked to the user. */
  async listDeviceLinks(userId: string): Promise<DeviceLink[]> {
    return this.prisma.deviceLink.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Remove a device link for the user (admin unlink). Throws 404 if not found. */
  async unlinkDevice(userId: string, deviceId: string): Promise<DeviceLink> {
    const link = await this.prisma.deviceLink.findUnique({ where: { deviceId } });
    if (!link || link.userId !== userId) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'Device link not found for this user' },
      });
    }
    await this.prisma.deviceLink.delete({ where: { deviceId } });
    this.logger.log(
      `Unlinked device=${this.maskDeviceId(deviceId)} from user ${userId.slice(0, 6)}…`,
    );
    return link;
  }

  /**
   * Idempotently attach a device to a user and backfill its reports. Throws
   * 409 if the device is already linked to a different user. Shared by the
   * code-based (user) and manual (admin) link paths.
   */
  async attachDevice(
    userId: string,
    deviceId: string,
    linkedVia: 'code' | 'admin',
  ): Promise<DeviceLink> {
    const existing = await this.prisma.deviceLink.findUnique({ where: { deviceId } });
    if (existing && existing.userId !== userId) {
      throw new ConflictException({
        error: {
          code: 'device_already_linked',
          message: 'This device is already linked to another account',
        },
      });
    }

    const link = await this.prisma.deviceLink.upsert({
      where: { deviceId },
      update: {},
      create: { userId, deviceId, linkedVia },
    });

    await this.prisma.report.updateMany({
      where: { deviceId },
      data: { userId },
    });

    this.logger.log(
      `Linked device=${this.maskDeviceId(deviceId)} to user ${userId.slice(0, 6)}… via ${linkedVia}`,
    );
    return link;
  }

  private maskDeviceId(deviceId: string): string {
    if (deviceId.length <= 8) return '****';
    return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`;
  }
}
