import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthUser } from './jwt.types';
import { ROLES_KEY } from './auth.decorators';

/**
 * Enforces @Roles(...) on a route. Runs after JwtAuthGuard has set req.user.
 *
 * A super admin passes every `@Roles(Role.ADMIN)` route (DEN-299): it is an
 * admin with one more right. So the admin controllers keep `Role.ADMIN`, and a
 * route only for super admins says `@Roles(Role.SUPER_ADMIN)`.
 */
function satisfies(actual: Role, required: Role): boolean {
  return actual === required || (required === Role.ADMIN && actual === Role.SUPER_ADMIN);
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user || !required.some((role) => satisfies(user.role, role))) {
      throw new ForbiddenException({
        error: { code: 'forbidden', message: 'Insufficient role' },
      });
    }
    return true;
  }
}
