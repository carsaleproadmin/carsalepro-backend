import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GeoService } from '../geo/geo.service';
import { StripeService, classifyStripeError } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateInspectorProfileDto } from './dto/inspector-profile.dto';
import {
  normalizeTelegramUsername,
  resolveContact,
  toE164,
  type PartyContact,
} from './inspector-contact';

/** Mask an id for logs — never log a full user id. */
function mask(id: string): string {
  return id.length <= 8 ? '****' : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** An explicitly empty field means "clear it", which is not the same as omitting the key. */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

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
  taxId: string | null;
  vatId: string | null;
  searchRadiusKm: number;
  available: boolean;
  stripeOnboarded: boolean;
  kycVerified: boolean;
  hasLocation: boolean;
  eligibleForOffers: boolean;
  /**
   * The channels AS STORED — what belongs in the edit form's fields.
   *
   * Deliberately alongside `contact` rather than instead of it: the two answer
   * different questions. These four are what this inspector typed and may
   * change; `contact` is what the customer ends up seeing, fallbacks applied, so
   * `contactEmail: null` here and an account address there is the normal case,
   * not a contradiction.
   *
   * Returning only the resolved form was a real defect. The website's profile
   * form is controlled and initialises from these keys, so every field rendered
   * EMPTY next to a preview showing the saved values, and saving sent all four
   * back blank — which the service reads as "clear this".
   */
  contactPhone: string | null;
  contactEmail: string | null;
  contactWhatsapp: boolean;
  contactTelegram: string | null;
  /**
   * What the customer will see once an order is assigned — resolved through the
   * same helper the order card uses, fallbacks included, so the inspector is
   * shown the actual disclosure and not the raw columns.
   */
  contact: PartyContact | null;
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

    // Contacts are normalised HERE, not on read: the stored username is bare and
    // the stored phone is E.164 where that was possible, so every reader gets the
    // same value without repeating the rules. An empty string means "clear this",
    // which `??` alone would store as an empty field.
    const contactPhone = this.normalizeContactPhone(dto.contactPhone);
    const contactEmail = blankToNull(dto.contactEmail);
    const contactTelegram = this.normalizeContactTelegram(dto.contactTelegram);

    await this.prisma.inspectorProfile.upsert({
      where: { userId },
      create: {
        userId,
        companyName: dto.companyName ?? null,
        // baseAddress is NOT NULL in the schema; default to empty when omitted.
        baseAddress: dto.baseAddress ?? '',
        taxId: dto.taxId ?? null,
        vatId: dto.vatId ?? null,
        contactPhone,
        contactEmail,
        contactWhatsapp: dto.contactWhatsapp ?? undefined,
        contactTelegram,
        searchRadiusKm: dto.searchRadiusKm ?? undefined,
        available: dto.available ?? undefined,
      },
      update: {
        companyName: dto.companyName ?? existing?.companyName ?? null,
        baseAddress: dto.baseAddress ?? existing?.baseAddress ?? '',
        taxId: dto.taxId ?? existing?.taxId ?? null,
        vatId: dto.vatId ?? existing?.vatId ?? null,
        // An absent key keeps what is stored; an explicit empty string clears it.
        contactPhone: dto.contactPhone === undefined ? undefined : contactPhone,
        contactEmail: dto.contactEmail === undefined ? undefined : contactEmail,
        contactWhatsapp: dto.contactWhatsapp ?? undefined,
        contactTelegram: dto.contactTelegram === undefined ? undefined : contactTelegram,
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

  /**
   * Register/refresh the caller's push token (E11 push channel). Upserts onto
   * the inspector profile — `NotificationsService` reads it as the `push`
   * delivery address. A profile is created on demand (baseAddress is NOT NULL,
   * so it defaults to empty) because a device may register a token before the
   * inspector has finished filling in their profile.
   */
  async registerPushToken(userId: string, token: string): Promise<void> {
    await this.prisma.inspectorProfile.upsert({
      where: { userId },
      create: { userId, baseAddress: '', fcmToken: token },
      update: { fcmToken: token },
    });
    this.logger.log(`Push token registered for inspector=${mask(userId)}`);
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

    // Real Stripe. Every failure below used to escape as a raw 500: the
    // inspector pressed "Start onboarding", nothing happened, and nothing said
    // why — most often because Connect was simply not enabled on the platform
    // account (F-15). Each condition now has its own code the UI can act on.
    try {
      return await this.createConnectOnboardingLink(userId, profile.stripeAccountId, user.email);
    } catch (err) {
      throw this.toConnectOnboardingException(err, userId);
    }
  }

  /**
   * Create (or reuse) the connected account and return a fresh account link.
   *
   * Self-healing: a STORED `stripeAccountId` that Stripe answers `resource_missing`
   * for means the account was deleted at Stripe, or the secret key was swapped
   * between live and test — the stored id then names an account that will never
   * exist again, and every retry fails identically forever. The stale id is
   * cleared, a fresh account is created, and the link is attempted exactly ONCE
   * more; a second failure is reported rather than looped.
   */
  private async createConnectOnboardingLink(
    userId: string,
    storedAccountId: string | null,
    email: string,
  ): Promise<StripeOnboardingResponse> {
    let accountId = storedAccountId;
    if (!accountId) {
      const account = await this.stripe.createConnectedAccount(email);
      accountId = account.id;
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeAccountId: accountId },
      });
    }

    try {
      const link = await this.stripe.createAccountLink(
        accountId,
        this.connectRefreshUrl,
        this.connectReturnUrl,
      );
      return { accountLinkUrl: link.url };
    } catch (err) {
      if (!storedAccountId || classifyStripeError(err).code !== 'resource_missing') throw err;

      this.logger.warn(
        `Stored Stripe Connect account no longer exists for inspector=${mask(userId)} ` +
          '(deleted at Stripe, or the API key was swapped between live and test) — recreating once',
      );
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeAccountId: null, stripeOnboarded: false },
      });
      const fresh = await this.stripe.createConnectedAccount(email);
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeAccountId: fresh.id },
      });
      const link = await this.stripe.createAccountLink(
        fresh.id,
        this.connectRefreshUrl,
        this.connectReturnUrl,
      );
      return { accountLinkUrl: link.url };
    }
  }

  /**
   * Map a Stripe failure onto the `{ error: { code, message } }` envelope the
   * exception filter passes through untouched (including at 5xx, because the
   * body carries a `code`).
   */
  private toConnectOnboardingException(err: unknown, userId: string): HttpException {
    const failure = classifyStripeError(err);
    this.logger.error(
      `Stripe Connect onboarding failed for inspector=${mask(userId)}: ` +
        `${failure.code} — ${failure.message}`,
    );

    // Connect not enabled on the platform account. Stripe reports this as a
    // plain invalid_request_error whose only distinguishing mark is its text —
    // and it is by far the most likely cause of a dead onboarding button.
    if (/signed up for Connect/i.test(failure.message)) {
      return new ServiceUnavailableException({
        error: {
          code: 'connect_not_enabled',
          message:
            'Payouts are not enabled on this platform yet. Please try again later or contact support.',
        },
      });
    }
    if (failure.code === 'resource_missing') {
      return new BadGatewayException({
        error: {
          code: 'connect_account_unavailable',
          message: 'Your payout account could not be reached at Stripe. Please try again.',
        },
      });
    }
    if (failure.code === 'account_invalid' || /capabilit|country/i.test(failure.message)) {
      return new BadRequestException({
        error: {
          code: 'connect_account_rejected',
          message:
            'Stripe rejected this payout account (unsupported country or capability). Contact support.',
        },
      });
    }
    if (failure.retryable) {
      return new ServiceUnavailableException({
        error: {
          code: 'stripe_unavailable',
          message: 'Stripe is temporarily unavailable. Please try again in a moment.',
        },
      });
    }
    return new BadGatewayException({
      error: {
        code: 'connect_onboarding_failed',
        message: 'Could not start Stripe onboarding. Please try again or contact support.',
      },
    });
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

  /**
   * Store a work phone in E.164 when it can be read that way, and verbatim when
   * it cannot.
   *
   * A number without a country code is NOT completed from `User.countryCode` —
   * that column defaults to "DE" on every account and means "nobody changed it".
   * Guessing would hand the customer a WhatsApp link to a stranger, so such a
   * number is kept as typed: `tel:` still dials it, and no WhatsApp link is
   * offered. That is a deliberate outcome, not a validation failure.
   */
  private normalizeContactPhone(raw: string | undefined): string | null {
    const trimmed = blankToNull(raw);
    if (!trimmed) return null;
    return toE164(trimmed) ?? trimmed;
  }

  /**
   * Store a bare Telegram username.
   *
   * Unlike the phone, an unusable value is REFUSED rather than kept: a phone
   * that cannot be parsed still works as a `tel:` link, whereas a malformed
   * username has no use at all and would silently vanish from the profile the
   * inspector believes they filled in.
   */
  private normalizeContactTelegram(raw: string | undefined): string | null {
    const trimmed = blankToNull(raw);
    if (!trimmed) return null;
    const username = normalizeTelegramUsername(trimmed);
    if (!username) {
      throw new BadRequestException({
        error: {
          code: 'invalid_telegram_username',
          message: 'Telegram username must be 5–32 characters of letters, digits or underscores.',
        },
      });
    }
    return username;
  }

  private async toView(
    userId: string,
    profile: {
      companyName: string | null;
      baseAddress: string | null;
      taxId: string | null;
      vatId: string | null;
      contactPhone: string | null;
      contactEmail: string | null;
      contactWhatsapp: boolean;
      contactTelegram: string | null;
      searchRadiusKm: number;
      available: boolean;
      stripeOnboarded: boolean;
    },
  ): Promise<InspectorProfileView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, deletedAt: true, kycVerified: true },
    });
    const hasLocation = await this.geo.inspectorHasLocation(userId);
    const kycVerified = user?.kycVerified ?? false;
    return {
      exists: true,
      userId,
      companyName: profile.companyName,
      baseAddress: profile.baseAddress,
      taxId: profile.taxId,
      vatId: profile.vatId,
      searchRadiusKm: profile.searchRadiusKm,
      available: profile.available,
      stripeOnboarded: profile.stripeOnboarded,
      kycVerified,
      hasLocation,
      eligibleForOffers: kycVerified && profile.stripeOnboarded && profile.available && hasLocation,
      contactPhone: profile.contactPhone,
      contactEmail: profile.contactEmail,
      contactWhatsapp: profile.contactWhatsapp,
      contactTelegram: profile.contactTelegram,
      contact: resolveContact(user, profile),
    };
  }
}
