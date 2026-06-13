import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GeoService } from '../geo/geo.service';
import { StripeService } from '../payments/stripe.service';
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

/** Result of POST /inspector/stripe-onboarding. */
export interface StripeOnboardingResponse {
  accountLinkUrl: string;
  mock?: boolean;
}

/** Result of GET /inspector/onboarding-status. */
export interface OnboardingStatusResponse {
  stripeOnboarded: boolean;
  hasAccount: boolean;
  eligibleForOffers: boolean;
}

/** Result of GET /inspector/earnings. */
export interface EarningsResponse {
  pendingCents: number;
  paidCents: number;
  payouts: Array<{
    orderId: string;
    amountCents: number;
    status: string;
    createdAt: string;
  }>;
}

@Injectable()
export class InspectorService {
  private readonly logger = new Logger(InspectorService.name);
  private readonly connectRefreshUrl: string;
  private readonly connectReturnUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly stripe: StripeService,
    config: ConfigService<AppConfig, true>,
  ) {
    const stripeCfg = config.get('stripe', { infer: true });
    this.connectRefreshUrl = stripeCfg.connectRefreshUrl;
    this.connectReturnUrl = stripeCfg.connectReturnUrl;
  }

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

  // ============================================================
  // Stripe Connect Express onboarding (E7)
  // ============================================================

  /**
   * Begin (or resume) Stripe Connect Express onboarding for the caller. Ensures
   * an InspectorProfile exists (creates a minimal one if missing). In MOCK mode
   * (no Stripe key / NODE_ENV=test) it short-circuits: marks the profile onboarded
   * with a fake account id and returns the configured return URL.
   */
  async startStripeOnboarding(userId: string): Promise<StripeOnboardingResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'User not found' } });
    }

    // Ensure a profile exists (baseAddress is NOT NULL → default to empty).
    let profile = await this.prisma.inspectorProfile.findUnique({ where: { userId } });
    if (!profile) {
      profile = await this.prisma.inspectorProfile.create({
        data: { userId, baseAddress: '' },
      });
    }

    // MOCK mode: no Stripe — mark onboarded with a fake account id immediately.
    if (!this.stripe.configured) {
      const accountId = profile.stripeAccountId ?? `acct_mock_${userId}`;
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeAccountId: accountId, stripeOnboarded: true },
      });
      return { accountLinkUrl: this.connectReturnUrl, mock: true };
    }

    // Real Stripe: create the connected account once, then a fresh account link.
    let accountId = profile.stripeAccountId;
    if (!accountId) {
      const account = await this.stripe.createConnectedAccount(user.email);
      accountId = account.id;
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeAccountId: accountId },
      });
    }

    const link = await this.stripe.createAccountLink(
      accountId,
      this.connectRefreshUrl,
      this.connectReturnUrl,
    );
    return { accountLinkUrl: link.url };
  }

  /** Onboarding status for the caller: whether Stripe is ready and offers eligible. */
  async getOnboardingStatus(userId: string): Promise<OnboardingStatusResponse> {
    const profile = await this.prisma.inspectorProfile.findUnique({ where: { userId } });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycVerified: true },
    });
    const stripeOnboarded = profile?.stripeOnboarded ?? false;
    const hasAccount = Boolean(profile?.stripeAccountId);
    const kycVerified = user?.kycVerified ?? false;
    return {
      stripeOnboarded,
      hasAccount,
      eligibleForOffers: kycVerified && stripeOnboarded,
    };
  }

  /** Earnings summary for the caller: pending/paid totals + the payout list. */
  async getEarnings(userId: string): Promise<EarningsResponse> {
    const payouts = await this.prisma.payout.findMany({
      where: { inspectorId: userId },
      orderBy: { createdAt: 'desc' },
    });
    let pendingCents = 0;
    let paidCents = 0;
    for (const p of payouts) {
      if (p.status === 'paid') paidCents += p.amountCents;
      else if (p.status === 'pending') pendingCents += p.amountCents;
    }
    return {
      pendingCents,
      paidCents,
      payouts: payouts.map((p) => ({
        orderId: p.orderId,
        amountCents: p.amountCents,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      })),
    };
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
