import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { Role, User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
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
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user || !user.passwordHash || user.deletedAt) {
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
      throw new UnauthorizedException({
        error: { code: 'invalid_credentials', message: 'Invalid email or password' },
      });
    }
    return this.issueToken(user);
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

  async requestPasswordReset(email: string): Promise<VerificationGrant | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    // Do not reveal whether the email exists.
    if (!user || user.deletedAt) return null;
    return this.createVerificationToken(user.id, user.email, 'password_reset', 60);
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
