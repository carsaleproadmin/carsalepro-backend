import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './auth.decorators';
import { AuthUser, JwtPayload } from './jwt.types';

/**
 * Global guard scoped to the `/api/v1` prefix only. Legacy mobile routes
 * (`/vin`, `/quota`, `/reports`, `/me`, `/legal`, `/catalog`, `/health`) are
 * left untouched — they authenticate with the X-Device-Id header. Within
 * `/api/v1`, a valid Bearer JWT is required unless the route is @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    // Only protect the website API surface.
    if (!req.path.startsWith('/api/v1')) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // @Public() routes are fully bypassed — no token check, no DB hit.
    if (isPublic) return true;

    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({
        error: { code: 'unauthorized', message: 'Missing bearer token' },
      });
    }

    let payload: JwtPayload;
    try {
      const secret = this.config.get('auth', { infer: true }).jwtSecret;
      payload = this.jwt.verify<JwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException({
        error: { code: 'invalid_token', message: 'Invalid or expired token' },
      });
    }

    // Request-time enforcement of ban / erasure / role / KYC. Loading the user
    // from the DB on every /api/v1 request makes a ban, GDPR erasure, role
    // change, or KYC approval take effect immediately rather than waiting for
    // the 30-day token to expire. The DB row is authoritative for role + KYC.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, kycVerified: true, bannedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt || user.bannedAt) {
      throw new UnauthorizedException({
        error: { code: 'unauthorized', message: 'Account is unavailable' },
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      kycVerified: user.kycVerified,
    };
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
