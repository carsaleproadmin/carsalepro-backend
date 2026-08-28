import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GeoService } from '../geo/geo.service';
import {
  StripeService,
  classifyStripeError,
  isStripeBusinessType,
  type StripeBusinessType,
} from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveConnectAccountParams,
  type ConnectAccountParams,
  type ConnectAccountRequest,
} from './connect-account-params';
import { UpdateInspectorProfileDto } from './dto/inspector-profile.dto';
import { inspectorBaseFeeBounds } from '../orders/inspector-base-fee';
import { SettingsService } from '../settings/settings.service';
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
  /** What this inspector charges as the base, in cents. Null = the platform base. */
  baseFeeCents: number | null;
  /** The window the base fee must stay inside, and the platform's own figure. */
  baseFee: { minCents: number; maxCents: number; platformCents: number };
  stripeOnboarded: boolean;
  /** Payout-account country (ISO 3166-1 alpha-2) and legal form; null until chosen. */
  stripeCountry: string | null;
  stripeBusinessType: StripeBusinessType | null;
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
  /**
   * The country the payout account was created in (or will be), ISO 3166-1
   * alpha-2. Echoed because it is the one parameter that cannot be changed
   * afterwards, so an inspector is owed the chance to see it before submitting
   * documents to Stripe.
   */
  country: string;
  /** Null means Stripe will ask during onboarding. */
  businessType: StripeBusinessType | null;
}

/** Result of GET /inspector/onboarding-status. */
export interface OnboardingStatusResponse {
  stripeOnboarded: boolean;
  hasAccount: boolean;
  eligibleForOffers: boolean;
  /**
   * Where the payout account lives and what legal form it declares. Both null
   * before onboarding has been started once; `stripeCountry` is fixed from the
   * moment `hasAccount` is true, which is what the UI needs in order to show it
   * as settled rather than as an editable field.
   */
  stripeCountry: string | null;
  stripeBusinessType: StripeBusinessType | null;
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
  /** Where a connected account lands when nobody has named a country. */
  private readonly connectDefaultCountry: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly stripe: StripeService,
    private readonly settings: SettingsService,
    config: ConfigService<AppConfig, true>,
  ) {
    const stripeCfg = config.get('stripe', { infer: true });
    this.connectRefreshUrl = stripeCfg.connectRefreshUrl;
    this.connectReturnUrl = stripeCfg.connectReturnUrl;
    this.connectDefaultCountry = stripeCfg.connectDefaultCountry;
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
    /*
     * DEN-213. The bound is REFUSED here and only clamped at pricing time.
     *
     * This is the one place a person is present to be told, so a number outside
     * the window comes back as an error naming the window rather than being
     * silently changed into a different price than the one they typed. Pricing
     * clamps instead, because the window moves and a value that was legal when
     * it was typed must not drop an inspector out of dispatch weeks later.
     */
    const baseFeeCents = await this.checkedBaseFeeCents(dto.baseFeeCents ?? null);
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
        baseFeeCents: dto.baseFeeCents === undefined ? undefined : baseFeeCents,
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
        // An absent key keeps what is stored; an explicit null returns this
        // inspector to the platform base.
        baseFeeCents: dto.baseFeeCents === undefined ? undefined : baseFeeCents,
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
   *
   * `input` carries the two facts that used to be hardcoded — the account's
   * country and its legal form. Both are optional, and an empty body means "use
   * what you already know about me", which is exactly how the website called this
   * route before either existed. See `resolveConnectAccountParams` for the
   * precedence and for why the country cannot be changed later.
   */
  async startStripeOnboarding(
    userId: string,
    input: ConnectAccountRequest = {},
  ): Promise<StripeOnboardingResponse> {
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

    const params = this.resolveAccountParams(input, profile);

    // MOCK mode: no Stripe — mark onboarded with a fake account id immediately.
    // The two choices are still STORED, so the dev/test path answers the same
    // questions as production and the country lock is exercised without a key.
    if (!this.stripe.configured) {
      const accountId = profile.stripeAccountId ?? `acct_mock_${userId}`;
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: {
          stripeAccountId: accountId,
          stripeOnboarded: true,
          stripeCountry: params.country,
          stripeBusinessType: params.businessType,
        },
      });
      return {
        accountLinkUrl: this.connectReturnUrl,
        mock: true,
        country: params.country,
        businessType: params.businessType,
      };
    }

    // Real Stripe. Every failure below used to escape as a raw 500: the
    // inspector pressed "Start onboarding", nothing happened, and nothing said
    // why — most often because Connect was simply not enabled on the platform
    // account (F-15). Each condition now has its own code the UI can act on.
    try {
      return await this.createConnectOnboardingLink(
        userId,
        profile.stripeAccountId,
        user.email,
        params,
      );
    } catch (err) {
      throw this.toConnectOnboardingException(err, userId, params);
    }
  }

  /**
   * Country + legal form for this attempt, or a refusal.
   *
   * The country lock answers **409**, not 400: nothing about the request is
   * malformed, and the state it conflicts with — an account Stripe will not
   * relocate — is the whole reason it cannot be honoured. The stored country is
   * named in the message, because "you cannot change it" without saying what it
   * currently is leaves the inspector nothing to act on.
   */
  private resolveAccountParams(
    input: ConnectAccountRequest,
    profile: { stripeAccountId: string | null; stripeCountry: string | null; stripeBusinessType: string | null },
  ): ConnectAccountParams {
    const resolution = resolveConnectAccountParams(
      input,
      {
        accountId: profile.stripeAccountId,
        country: profile.stripeCountry,
        businessType: profile.stripeBusinessType,
      },
      this.connectDefaultCountry,
    );
    if (resolution.ok) return resolution.params;

    if (resolution.code === 'country_locked') {
      throw new ConflictException({
        error: {
          code: 'connect_country_locked',
          message:
            `Your payout account is registered in ${resolution.stored} and Stripe cannot move it ` +
            `to ${resolution.requested}. Contact support to have the account replaced.`,
          storedCountry: resolution.stored,
          requestedCountry: resolution.requested,
        },
      });
    }
    throw new BadRequestException({
      error: {
        code: resolution.code === 'country_invalid' ? 'invalid_country' : 'invalid_business_type',
        message:
          resolution.code === 'country_invalid'
            ? 'Country must be a two-letter ISO 3166-1 alpha-2 code, for example DE or PL.'
            : 'Business type must be individual, company, non_profit or government_entity.',
      },
    });
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
    params: ConnectAccountParams,
  ): Promise<StripeOnboardingResponse> {
    let accountId = storedAccountId;
    if (!accountId) {
      const account = await this.stripe.createConnectedAccount({
        email,
        country: params.country,
        businessType: params.businessType,
      });
      accountId = account.id;
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: {
          stripeAccountId: accountId,
          // Written in the SAME statement as the id, because these three facts
          // only mean anything together: a stored country next to a different
          // account is worse than no country at all — it is what the lock trusts.
          stripeCountry: params.country,
          stripeBusinessType: params.businessType,
        },
      });
    } else if (params.businessTypeChanged && params.businessType) {
      await this.applyBusinessTypeChange(userId, accountId, params.businessType);
    }

    try {
      const link = await this.stripe.createAccountLink(
        accountId,
        this.connectRefreshUrl,
        this.connectReturnUrl,
      );
      return {
        accountLinkUrl: link.url,
        country: params.country,
        businessType: params.businessType,
      };
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
      // The replacement is created in the SAME country as the one being replaced
      // (`params.country` is the country of record, not the request), so a
      // self-heal cannot quietly relocate an inspector.
      const fresh = await this.stripe.createConnectedAccount({
        email,
        country: params.country,
        businessType: params.businessType,
      });
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: {
          stripeAccountId: fresh.id,
          stripeCountry: params.country,
          stripeBusinessType: params.businessType,
        },
      });
      const link = await this.stripe.createAccountLink(
        fresh.id,
        this.connectRefreshUrl,
        this.connectReturnUrl,
      );
      return {
        accountLinkUrl: link.url,
        country: params.country,
        businessType: params.businessType,
      };
    }
  }

  /**
   * Tell Stripe the legal form changed, then record it.
   *
   * Stripe refuses the change once the declaration has been verified, and that
   * refusal must NOT abort onboarding: the inspector's account still exists and
   * the link they asked for is still the right answer. So the failure is logged,
   * the stored value is left alone — it keeps describing the account as it
   * actually is — and the caller continues. Writing our column anyway would give
   * the profile a legal form the account does not carry, which is the kind of
   * disagreement nobody discovers until a payout is held.
   */
  private async applyBusinessTypeChange(
    userId: string,
    accountId: string,
    businessType: StripeBusinessType,
  ): Promise<void> {
    try {
      await this.stripe.updateConnectedAccountBusinessType(accountId, businessType);
      await this.prisma.inspectorProfile.update({
        where: { userId },
        data: { stripeBusinessType: businessType },
      });
    } catch (err) {
      const failure = classifyStripeError(err);
      this.logger.warn(
        `Stripe refused a business_type change to ${businessType} for inspector=${mask(userId)}: ` +
          `${failure.code} — ${failure.message}`,
      );
    }
  }

  /**
   * Map a Stripe failure onto the `{ error: { code, message } }` envelope the
   * exception filter passes through untouched (including at 5xx, because the
   * body carries a `code`).
   */
  private toConnectOnboardingException(
    err: unknown,
    userId: string,
    params?: ConnectAccountParams,
  ): HttpException {
    const failure = classifyStripeError(err);
    this.logger.error(
      `Stripe Connect onboarding failed for inspector=${mask(userId)}` +
        (params ? ` (country=${params.country}, businessType=${params.businessType ?? 'unset'})` : '') +
        `: ${failure.code} — ${failure.message}`,
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
    /*
     * The COUNTRY is its own answer, and it used to share one with capabilities.
     * Since 2026-08-19 the inspector chooses it, so this is the one Stripe
     * rejection they can act on themselves — and only if the message names the
     * country back. Stripe words it several ways ("Invalid country",
     * "not able to create accounts in …", cross-border payouts not enabled),
     * which is why the match is on the word rather than on a code: there is no
     * distinct code to match.
     */
    if (/countr/i.test(failure.message)) {
      return new BadRequestException({
        error: {
          code: 'connect_country_unsupported',
          message: params?.country
            ? `Stripe cannot create a payout account in ${params.country} for this platform. ` +
              'Choose the country your business is registered in, or contact support.'
            : 'Stripe cannot create a payout account in that country for this platform. Contact support.',
          country: params?.country ?? null,
        },
      });
    }
    if (failure.code === 'account_invalid' || /capabilit/i.test(failure.message)) {
      return new BadRequestException({
        error: {
          code: 'connect_account_rejected',
          message: 'Stripe rejected this payout account (unsupported capability). Contact support.',
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
      stripeCountry: profile?.stripeCountry ?? null,
      stripeBusinessType: isStripeBusinessType(profile?.stripeBusinessType)
        ? profile.stripeBusinessType
        : null,
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

  /**
   * The platform base fee for the bound, and the bound itself.
   *
   * The GLOBAL base, not a regional one: an inspector's window has to be a
   * number they can be shown in their own profile, and they work across
   * whichever regions their radius reaches. Pricing resolves the regional
   * tariff and clamps again there, so a regional base that moves the window is
   * still honoured at the moment it matters.
   */
  private async baseFeeBounds(): Promise<{ minCents: number; maxCents: number; platformCents: number }> {
    const platformCents = await this.settings.getCents('orderBaseFeeEur');
    return { ...inspectorBaseFeeBounds(platformCents), platformCents };
  }

  /** Refuse a fee outside the window, naming the window. */
  private async checkedBaseFeeCents(value: number | null): Promise<number | null> {
    if (value === null) return null;
    const { minCents, maxCents } = await this.baseFeeBounds();
    if (value < minCents || value > maxCents) {
      throw new BadRequestException({
        error: {
          code: 'base_fee_out_of_range',
          message: `The base fee must be between ${(minCents / 100).toFixed(2)} and ${(maxCents / 100).toFixed(2)} EUR.`,
        },
        minCents,
        maxCents,
      });
    }
    return value;
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
      stripeCountry: string | null;
      stripeBusinessType: string | null;
      baseFeeCents: number | null;
    },
  ): Promise<InspectorProfileView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, deletedAt: true, kycVerified: true },
    });
    const hasLocation = await this.geo.inspectorHasLocation(userId);
    const baseFeeBounds = await this.baseFeeBounds();
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
      baseFeeCents: profile.baseFeeCents,
      /*
       * The window travels WITH the value, so the form can state the bound
       * rather than hardcode 30 % of a number it would have to fetch
       * separately - and so the bound the client shows is the bound the API
       * will enforce a second later.
       */
      baseFee: baseFeeBounds,
      stripeOnboarded: profile.stripeOnboarded,
      stripeCountry: profile.stripeCountry,
      // Read through the guard rather than cast: the column is a plain string,
      // so a value Stripe has retired (or a hand-edited row) must not be handed
      // to a client as a member of the enum.
      stripeBusinessType: isStripeBusinessType(profile.stripeBusinessType)
        ? profile.stripeBusinessType
        : null,
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
