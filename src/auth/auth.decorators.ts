import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from './jwt.types';

/** Marks a route as public — the JWT guard skips it (e.g. login, register). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Marks a `@Public()` route as OPTIONALLY authenticated: a missing, malformed
 * or expired token is not an error, but a valid one still resolves the caller
 * into `req.user`.
 *
 * `@Public()` on its own is a full bypass — no token check, no DB hit — so
 * `@CurrentUser('id')` on a public route yields `undefined` even when the
 * request carried a perfectly good Bearer token. That is fine for login or a
 * webhook, and wrong for a route that is open to visitors but still wants to
 * know who is asking (`POST /api/v1/orders/quote`: an anonymous caller gets a
 * price, a signed-in caller additionally gets waitlisted and is excluded from
 * their own candidate list).
 *
 * Use together with `@Public()`.
 */
export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_OPTIONAL_AUTH_KEY, true);

/** Restricts a route to the given roles (checked by RolesGuard). */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated user (or one of its fields) into a handler. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | unknown => {
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    return data && user ? user[data] : user;
  },
);
