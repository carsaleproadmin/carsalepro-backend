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
