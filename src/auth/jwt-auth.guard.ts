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
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    // Only protect the website API surface.
    if (!req.path.startsWith('/api/v1')) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({
        error: { code: 'unauthorized', message: 'Missing bearer token' },
      });
    }

    try {
      const secret = this.config.get('auth', { infer: true }).jwtSecret;
      const payload = this.jwt.verify<JwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
      });
      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        kycVerified: payload.kycVerified,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        error: { code: 'invalid_token', message: 'Invalid or expired token' },
      });
    }
  }

  private extractToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
