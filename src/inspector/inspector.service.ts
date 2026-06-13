import { Injectable } from '@nestjs/common';
import { GeoService } from '../geo/geo.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateInspectorProfileDto } from './dto/inspector-profile.dto';

/**
 * Public projection of an InspectorProfile. The raw geography column is never
 * returned; callers get a `hasLocation` boolean and the eligibility flags so the
 * frontend can show "you can receive offers when KYC + Stripe + available".
 */
export interface InspectorProfileView {
  exists: true;
  userId: string;
  companyName: string | null;
  baseAddress: string | null;
  searchRadiusKm: number;
  available: boolean;
  stripeOnboarded: boolean;
  kycVerified: boolean;
  hasLocation: boolean;
  eligibleForOffers: boolean;
}

@Injectable()
export class InspectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  /** The caller's profile, or `{ exists: false }` when none has been created. */
  async getProfile(userId: string): Promise<InspectorProfileView | { exists: false }> {
    const profile = await this.prisma.inspectorProfile.findUnique({ where: { userId } });
    if (!profile) return { exists: false };
    return this.toView(userId, profile);
  }

  /** Create-or-update the caller's profile; writes location via GeoService. */
  async upsertProfile(
    userId: string,
    dto: UpdateInspectorProfileDto,
  ): Promise<InspectorProfileView> {
    const existing = await this.prisma.inspectorProfile.findUnique({ where: { userId } });

    await this.prisma.inspectorProfile.upsert({
      where: { userId },
      create: {
        userId,
        companyName: dto.companyName ?? null,
        // baseAddress is NOT NULL in the schema; default to empty when omitted.
        baseAddress: dto.baseAddress ?? '',
        searchRadiusKm: dto.searchRadiusKm ?? undefined,
        available: dto.available ?? undefined,
      },
      update: {
        companyName: dto.companyName ?? existing?.companyName ?? null,
        baseAddress: dto.baseAddress ?? existing?.baseAddress ?? '',
        searchRadiusKm: dto.searchRadiusKm ?? undefined,
        available: dto.available ?? undefined,
      },
    });

    if (dto.lat !== undefined && dto.lng !== undefined) {
      await this.geo.setInspectorLocation(userId, dto.lat, dto.lng);
    }

    const profile = await this.prisma.inspectorProfile.findUniqueOrThrow({ where: { userId } });
    return this.toView(userId, profile);
  }

  private async toView(
    userId: string,
    profile: {
      companyName: string | null;
      baseAddress: string | null;
      searchRadiusKm: number;
      available: boolean;
      stripeOnboarded: boolean;
    },
  ): Promise<InspectorProfileView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycVerified: true },
    });
    const hasLocation = await this.geo.inspectorHasLocation(userId);
    const kycVerified = user?.kycVerified ?? false;
    return {
      exists: true,
      userId,
      companyName: profile.companyName,
      baseAddress: profile.baseAddress,
      searchRadiusKm: profile.searchRadiusKm,
      available: profile.available,
      stripeOnboarded: profile.stripeOnboarded,
      kycVerified,
      hasLocation,
      eligibleForOffers: kycVerified && profile.stripeOnboarded && profile.available && hasLocation,
    };
  }
}
