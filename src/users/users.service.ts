import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

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
}
