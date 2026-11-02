import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { PARTIAL_LOCALES, SUPPORTED_LOCALES } from '../notifications/notification-types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuthUser, JwtPayload } from './jwt.types';

export interface IssuedToken {
  token: string;
  user: AuthUser;
}

/** Raw token + expiry handed back so the notifications layer can email a link. */
export interface VerificationGrant {
  rawToken: string;
  expiresAt: Date;
}

/** DEN-417. Failed logins per email before the lock, and the lock window. */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_SECONDS = 15 * 60;

/** The email is hashed so the Redis key does not hold personal data. */
function loginFailureKey(email: string): string {
  return `login-fail:${createHash('sha256').update(email).digest('hex')}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  // ---- token helpers ----

  private toAuthUser(user: User): AuthUser {
    return { id: user.id, email: user.email, role: user.role, kycVerified: user.kycVerified };
  }

  issueToken(user: User): IssuedToken {
    const { jwtSecret, jwtExpiresIn } = this.config.get('auth', { infer: true });
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      kycVerified: user.kycVerified,
    };
    const signOptions = { secret: jwtSecret, expiresIn: jwtExpiresIn } as JwtSignOptions;
    const token = this.jwt.sign(payload, signOptions);
    return { token, user: this.toAuthUser(user) };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private async createVerificationToken(
    userId: string | null,
    identifier: string,
    purpose: 'verify_email' | 'password_reset' | 'magic_link',
    ttlMinutes: number,
  ): Promise<VerificationGrant> {
    const rawToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    await this.prisma.verificationToken.create({
      data: { userId, identifier, tokenHash: this.hashToken(rawToken), purpose, expiresAt },
    });
    return { rawToken, expiresAt };
  }

  // ---- registration / login ----

  async register(input: {
    email: string;
    password?: string;
    name?: string;
    locale?: string;
  }): Promise<{ auth: IssuedToken; verification: VerificationGrant }> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({
        error: { code: 'email_taken', message: 'Email already registered' },
      });
    }
    const passwordHash = input.password ? await hash(input.password) : null;
    const user = await this.prisma.user.upsert({
      where: { email },
      create: {
        email,
        passwordHash,
        name: input.name,
        locale: input.locale ?? 'de',
        gdprConsentAt: new Date(),
      },
      update: { passwordHash, name: input.name, deletedAt: null },
    });
    const verification = await this.createVerificationToken(
      user.id,
      email,
      'verify_email',
      60 * 24,
    );
    return { auth: this.issueToken(user), verification };
  }

  async validateCredentials(email: string, password: string): Promise<IssuedToken> {
    const normalized = email.toLowerCase().trim();
    await this.assertLoginNotLocked(normalized);
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (!user || !user.passwordHash || user.deletedAt) {
      await this.recordLoginFailure(normalized);
      throw new UnauthorizedException({
        error: { code: 'invalid_credentials', message: 'Invalid email or password' },
      });
    }
    if (user.bannedAt) {
      throw new ForbiddenException({
        error: { code: 'account_banned', message: 'Account suspended' },
      });
    }
    const ok = await verify(user.passwordHash, password);
    if (!ok) {
      await this.recordLoginFailure(normalized);
      throw new UnauthorizedException({
        error: { code: 'invalid_credentials', message: 'Invalid email or password' },
      });
    }
    await this.redis.del(loginFailureKey(normalized)).catch(() => undefined);
    return this.issueToken(user);
  }

  /*
   * DEN-417. A limit per IP does not stop a slow attack on one account from
   * many addresses, so failures are also counted per email. The lock applies
   * to an unknown email too, so the answer does not tell which emails exist.
   * Redis that does not answer must not stop every login: the check then
   * passes, and the per-IP limit still applies.
   */
  private async assertLoginNotLocked(email: string): Promise<void> {
    const raw = await this.redis.get(loginFailureKey(email)).catch(() => null);
    if (raw && parseInt(raw, 10) >= LOGIN_MAX_FAILURES) {
      throw new HttpException(
        {
          error: {
            code: 'too_many_login_attempts',
            message: 'Too many failed login attempts. Try again later.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordLoginFailure(email: string): Promise<void> {
    await this.redis
      .incrWithTtl(loginFailureKey(email), LOGIN_LOCK_SECONDS)
      .catch(() => undefined);
  }

  // ---- email verification ----

  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.consumeToken(rawToken, 'verify_email');
    if (record.userId) {
      await this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: new Date() },
      });
    }
  }

  // ---- password reset ----

  /**
   * Mint a reset token and email it. Always resolves void, and does the same
   * amount of observable work either way, so the response cannot be used to
   * learn whether an address is registered. The raw token is handed straight to
   * the notification layer and is never returned to a caller — see SECURITY.md.
   *
   * `locale` is the language of the page that asked (DEN-540). With no
   * locale, the letter uses `User.locale`, as before. See `authLetterLocale`
   * for a locale with no template.
   */
  async requestPasswordResetAndNotify(email: string, locale?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user || user.deletedAt) return;

    const grant = await this.createVerificationToken(
      user.id,
      user.email,
      'password_reset',
      60,
    );
    await this.notifications.notify(
      user.id,
      'auth.password_reset',
      {
        resetUrl: this.buildWebUrl('/reset-password', grant.rawToken),
        expiresAt: grant.expiresAt.toISOString(),
      },
      locale === undefined ? undefined : { locale: authLetterLocale(locale) },
    );
  }

  /**
   * Email the freshly-registered user their single-use verification link.
   *
   * `locale` is the language of the site page (DEN-540), so a reader who signed
   * up in German gets a German letter. It is NOT taken from `User.locale`:
   * that defaults to `de` for anyone who did not say otherwise. With no page
   * language (the mobile app, an older site) the letter stays in English, as
   * the client asked in DEN-200.
   */
  async sendVerificationEmail(
    userId: string,
    email: string,
    grant: VerificationGrant,
    locale?: string,
  ): Promise<void> {
    await this.notifications.notify(
      userId,
      'auth.verify_email',
      {
        email,
        verifyUrl: this.buildWebUrl('/verify', grant.rawToken),
        expiresAt: grant.expiresAt.toISOString(),
      },
      { locale: locale === undefined ? 'en' : authLetterLocale(locale) },
    );
  }

  /**
   * Send another confirmation link to `email`, if there is anything to send.
   *
   * Always resolves void and does the same observable work either way - an
   * unknown address, a deleted account and an already-confirmed one are
   * indistinguishable from outside. Same contract as
   * `requestPasswordResetAndNotify`, and for the same reason: an endpoint that
   * answered differently for a registered address would be an account-existence
   * oracle, and this one is unauthenticated.
   *
   * The old token is NOT invalidated. Two live links are harmless - both point
   * at the same address and both expire - and revoking on re-send breaks the
   * commonest case there is: a reader who clicks "send it again", then finds
   * the first letter and opens that one.
   */
  async resendVerificationEmail(email: string, locale?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user || user.deletedAt || user.emailVerified) return;

    const grant = await this.createVerificationToken(
      user.id,
      user.email,
      'verify_email',
      60 * 24,
    );
    await this.sendVerificationEmail(user.id, user.email, grant, locale);
  }

  private buildWebUrl(path: string, token: string): string {
    const origin = this.config.get('web', { infer: true }).origin.replace(/\/$/, '');
    return `${origin}${path}?token=${encodeURIComponent(token)}`;
  }

  async confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
    const record = await this.consumeToken(rawToken, 'password_reset');
    if (!record.userId) {
      throw new BadRequestException({
        error: { code: 'invalid_token', message: 'Invalid reset token' },
      });
    }
    await this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hash(newPassword) },
    });
  }

  private async consumeToken(rawToken: string, purpose: string) {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.verificationToken.findUnique({ where: { tokenHash } });
    if (!record || record.purpose !== purpose || record.consumedAt || record.expiresAt < new Date()) {
      throw new BadRequestException({
        error: { code: 'invalid_token', message: 'Invalid or expired token' },
      });
    }
    await this.prisma.verificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return record;
  }

  // ---- OAuth / magic-link bridge (called by NextAuth) ----

  async oauthUpsert(input: {
    email: string;
    name?: string;
    provider: string;
    providerAccountId: string;
  }): Promise<IssuedToken> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: input.name,
        emailVerified: new Date(), // provider-verified
        gdprConsentAt: new Date(),
      },
      update: { name: input.name ?? undefined, deletedAt: null },
    });
    await this.prisma.authAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      },
      create: {
        userId: user.id,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        type: 'oauth',
      },
      update: {},
    });
    return this.issueToken(user);
  }
}

/**
 * The template language of an auth letter asked for in `locale` (DEN-540).
 * A locale with no template gets English, not the German default: the reader
 * asked in a language that is not German, and English is the one most of them
 * can read.
 */
function authLetterLocale(locale: string): string {
  const written: string[] = [...SUPPORTED_LOCALES, ...PARTIAL_LOCALES];
  return written.includes(locale) ? locale : 'en';
}
