import { Role } from '@prisma/client';

/**
 * The roles that open the admin panel (DEN-299).
 *
 * A super admin is an admin with one more right: to manage the other admins.
 * So every check that asks "is this person an admin?" must accept both roles.
 * Use these helpers for that question. Do not compare with `Role.ADMIN` alone,
 * because that check silently locks the super admin out.
 */
export const ADMIN_ROLES: readonly Role[] = [Role.ADMIN, Role.SUPER_ADMIN];

export function isAdminRole(role: Role | null | undefined): boolean {
  return role != null && ADMIN_ROLES.includes(role);
}
