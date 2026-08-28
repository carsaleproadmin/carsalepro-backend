import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { AppConfig } from '../config/configuration';
import { Public } from './auth.decorators';
import { AuthService } from './auth.service';
import {
  LoginDto,
  OAuthUpsertDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterDto,
  ResendVerificationDto,
  VerifyEmailDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register with email + password (GDPR consent required)' })
  async register(@Body() dto: RegisterDto) {
    if (!dto.gdprConsent) {
      throw new BadRequestException({
        error: { code: 'consent_required', message: 'GDPR consent is required' },
      });
    }
    const { auth, verification } = await this.auth.register(dto);
    // The raw verification token goes to the notification layer and NOWHERE
    // else. It used to be returned here, which handed anyone who could call
    // this endpoint a working single-use credential. See SECURITY.md.
    await this.auth.sendVerificationEmail(auth.user.id, auth.user.email, verification);
    return { token: auth.token, user: auth.user };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  @ApiOperation({ summary: 'Login — returns an API JWT (used by NextAuth Credentials)' })
  async login(@Body() dto: LoginDto) {
    const { token, user } = await this.auth.validateCredentials(dto.email, dto.password);
    return { token, user };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('password-reset')
  @ApiOperation({ summary: 'Request a password-reset link (no account disclosure)' })
  async requestReset(@Body() dto: PasswordResetRequestDto) {
    // Byte-identical response whether or not the address is registered: the
    // service swallows the distinction, so this endpoint is not an
    // account-existence oracle. The reset token is emailed, never returned.
    await this.auth.requestPasswordResetAndNotify(dto.email);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('password-reset/confirm')
  @ApiOperation({ summary: 'Confirm a password reset' })
  async confirmReset(@Body() dto: PasswordResetConfirmDto) {
    await this.auth.confirmPasswordReset(dto.token, dto.password);
    return { ok: true };
  }

  /**
   * Send the confirmation link again (DEN-200).
   *
   * Throttled harder than the rest of this controller: every call that finds
   * something to do sends a real email to an address the caller named, so the
   * bucket is the abuse control, not the response. Five a minute is generous
   * for a person clicking a button and useless for anything else.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-email/resend')
  @ApiOperation({ summary: 'Send the confirmation link again (no account disclosure)' })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    // Same answer for a registered address, an unknown one and one that is
    // already confirmed — see requestReset above for why that matters.
    await this.auth.resendVerificationEmail(dto.email);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('verify-email')
  @ApiOperation({ summary: 'Verify an email address with a token' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.auth.verifyEmail(dto.token);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('oauth-upsert')
  @ApiOperation({ summary: 'Internal: upsert a user from a NextAuth OAuth/magic-link sign-in' })
  async oauthUpsert(
    @Headers('x-internal-key') internalKey: string | undefined,
    @Body() dto: OAuthUpsertDto,
  ) {
    const auth = this.config.get('auth', { infer: true });
    // Prefer the dedicated INTERNAL_API_KEY when configured; otherwise fall back
    // to JWT_SECRET so existing deployments (no new var) keep working.
    const expected = auth.internalApiKey || auth.jwtSecret;
    if (!internalKey || !this.constantTimeEquals(internalKey, expected)) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'Invalid internal key' },
      });
    }
    const { token, user } = await this.auth.oauthUpsert(dto);
    return { token, user };
  }

  /** Constant-time string comparison with a length guard (avoids timing leaks). */
  private constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
