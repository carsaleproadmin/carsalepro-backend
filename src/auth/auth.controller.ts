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
import { AppConfig } from '../config/configuration';
import { Public } from './auth.decorators';
import { AuthService } from './auth.service';
import {
  LoginDto,
  OAuthUpsertDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterDto,
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
    // verification token returned so the notifications layer can email a link.
    return { token: auth.token, user: auth.user, emailVerification: verification };
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
    const grant = await this.auth.requestPasswordReset(dto.email);
    // Always 200; token (if any) is handed to notifications, never to the client.
    return { ok: true, reset: grant };
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
    const expected = this.config.get('auth', { infer: true }).jwtSecret;
    if (!internalKey || internalKey !== expected) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'Invalid internal key' },
      });
    }
    const { token, user } = await this.auth.oauthUpsert(dto);
    return { token, user };
  }
}
