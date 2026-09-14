import { Role } from '@prisma/client';
import { isAdminRole } from '../auth/roles';

/**
 * Who may change whose role or ban state (DEN-299). Pure, so the rules are
 * tested as a table in `role-policy.spec.ts`.
 *
 * | Action                                   | ADMIN | SUPER_ADMIN |
 * |------------------------------------------|-------|-------------|
 * | Promote a user to admin                  | yes   | yes         |
 * | Demote an admin to user                  | no    | yes         |
 * | Give or remove the super admin role      | no    | yes         |
 * | Ban or unban an admin or a super admin   | no    | yes         |
 *
 * The counts (last admin, last super admin) need the database and stay in
 * `AdminUsersService`.
 */
export type RoleDenial = 'cannot_demote_self' | 'super_admin_required';

const RANK: Record<Role, number> = {
  [Role.USER]: 0,
  [Role.ADMIN]: 1,
  [Role.SUPER_ADMIN]: 2,
};

export function roleChangeDenial(
  actorRole: Role,
  targetRole: Role,
  nextRole: Role,
  isSelf: boolean,
): RoleDenial | null {
  if (targetRole === nextRole) return null; // no change, nothing to refuse
  if (isSelf && RANK[nextRole] < RANK[targetRole]) return 'cannot_demote_self';
  if (actorRole === Role.SUPER_ADMIN) return null;
  // An admin can do one thing here: make a user an admin.
  if (targetRole === Role.USER && nextRole === Role.ADMIN) return null;
  return 'super_admin_required';
}

/**
 * Ban and unban follow the demotion rule. Without it, an admin who cannot
 * demote a different admin could ban them, and a ban locks the account out
 * more completely than a demotion.
 */
export function banDenial(actorRole: Role, targetRole: Role): RoleDenial | null {
  return isAdminRole(targetRole) && actorRole !== Role.SUPER_ADMIN
    ? 'super_admin_required'
    : null;
}
