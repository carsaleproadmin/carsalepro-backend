import { Role } from '@prisma/client';
import { banDenial, roleChangeDenial } from './role-policy';
import { ADMIN_ROLES, isAdminRole } from '../auth/roles';

const { USER, ADMIN, SUPER_ADMIN } = Role;

describe('roleChangeDenial (DEN-299)', () => {
  it.each([
    // actor, target, next, expected
    [ADMIN, USER, ADMIN, null],
    [ADMIN, ADMIN, USER, 'super_admin_required'],
    [ADMIN, USER, SUPER_ADMIN, 'super_admin_required'],
    [ADMIN, ADMIN, SUPER_ADMIN, 'super_admin_required'],
    [ADMIN, SUPER_ADMIN, ADMIN, 'super_admin_required'],
    [ADMIN, SUPER_ADMIN, USER, 'super_admin_required'],
    [SUPER_ADMIN, USER, ADMIN, null],
    [SUPER_ADMIN, ADMIN, USER, null],
    [SUPER_ADMIN, USER, SUPER_ADMIN, null],
    [SUPER_ADMIN, ADMIN, SUPER_ADMIN, null],
    [SUPER_ADMIN, SUPER_ADMIN, ADMIN, null],
  ] as const)('%s changing %s to %s -> %s', (actor, target, next, expected) => {
    expect(roleChangeDenial(actor, target, next, false)).toBe(expected);
  });

  it('refuses nothing when the role does not change', () => {
    expect(roleChangeDenial(ADMIN, ADMIN, ADMIN, false)).toBeNull();
    expect(roleChangeDenial(ADMIN, SUPER_ADMIN, SUPER_ADMIN, false)).toBeNull();
  });

  it('does not let anybody demote themselves', () => {
    expect(roleChangeDenial(ADMIN, ADMIN, USER, true)).toBe('cannot_demote_self');
    expect(roleChangeDenial(SUPER_ADMIN, SUPER_ADMIN, ADMIN, true)).toBe('cannot_demote_self');
    expect(roleChangeDenial(SUPER_ADMIN, SUPER_ADMIN, USER, true)).toBe('cannot_demote_self');
  });

  it('does not let an admin make themselves a super admin', () => {
    expect(roleChangeDenial(ADMIN, ADMIN, SUPER_ADMIN, true)).toBe('super_admin_required');
  });
});

describe('banDenial (DEN-299)', () => {
  it('lets an admin ban a user, and only a super admin ban an admin', () => {
    expect(banDenial(ADMIN, USER)).toBeNull();
    expect(banDenial(ADMIN, ADMIN)).toBe('super_admin_required');
    expect(banDenial(ADMIN, SUPER_ADMIN)).toBe('super_admin_required');
    expect(banDenial(SUPER_ADMIN, USER)).toBeNull();
    expect(banDenial(SUPER_ADMIN, ADMIN)).toBeNull();
    expect(banDenial(SUPER_ADMIN, SUPER_ADMIN)).toBeNull();
  });
});

describe('isAdminRole', () => {
  it('accepts both admin roles and nothing else', () => {
    expect(ADMIN_ROLES).toEqual([ADMIN, SUPER_ADMIN]);
    expect(isAdminRole(ADMIN)).toBe(true);
    expect(isAdminRole(SUPER_ADMIN)).toBe(true);
    expect(isAdminRole(USER)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});
