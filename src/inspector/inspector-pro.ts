import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Mobile PRO as a condition for inspector work (DEN-376).
 *
 * An inspector has PRO when ONE of these is true:
 *  - a device linked to the account (`DeviceLink`) has `DeviceQuota.isPro`;
 *  - an admin gave PRO by hand (`InspectorProfile.proGrantedAt`).
 *
 * PRO is a one-time purchase, so there is no expiry to check.
 *
 * Without PRO the inspector gets no new work: dispatch skips them, and the
 * offer, out-of-range list and counter-offer routes refuse them. Orders that
 * they already hold are NOT touched, so they can finish them.
 */

export const INSPECTOR_PRO_REQUIRED = 'inspector_pro_required';

/**
 * The same rule as `inspectorHasPro`, as a SQL condition for the dispatch
 * query. `alias` is the `inspector_profile` alias in that query.
 */
export function inspectorProSql(alias: string): Prisma.Sql {
  const ip = Prisma.raw(alias);
  return Prisma.sql`(
    ${ip}.pro_granted_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM device_link dl
      JOIN device_quota dq ON dq.device_id = dl.device_id
      WHERE dl.user_id = ${ip}.user_id AND dq.is_pro = true
    )
  )`;
}

type ProReader = Pick<PrismaClient, 'inspectorProfile' | 'deviceLink' | 'deviceQuota'>;

export interface InspectorProStatus {
  hasPro: boolean;
  /** Where PRO comes from. Both can be true at the same time. */
  fromDevice: boolean;
  grantedByAdmin: boolean;
  grantedAt: Date | null;
}

export async function inspectorProStatus(
  prisma: ProReader,
  userId: string,
): Promise<InspectorProStatus> {
  const [profile, links] = await Promise.all([
    prisma.inspectorProfile.findUnique({
      where: { userId },
      select: { proGrantedAt: true },
    }),
    prisma.deviceLink.findMany({ where: { userId }, select: { deviceId: true } }),
  ]);
  const fromDevice =
    links.length > 0 &&
    (await prisma.deviceQuota.count({
      where: { deviceId: { in: links.map((l) => l.deviceId) }, isPro: true },
    })) > 0;
  const grantedAt = profile?.proGrantedAt ?? null;
  return {
    hasPro: fromDevice || grantedAt !== null,
    fromDevice,
    grantedByAdmin: grantedAt !== null,
    grantedAt,
  };
}

export async function inspectorHasPro(prisma: ProReader, userId: string): Promise<boolean> {
  return (await inspectorProStatus(prisma, userId)).hasPro;
}

/** Throws 403 `inspector_pro_required` when the inspector has no PRO. */
export async function assertInspectorPro(prisma: ProReader, userId: string): Promise<void> {
  if (await inspectorHasPro(prisma, userId)) return;
  throw new ForbiddenException({
    error: {
      code: INSPECTOR_PRO_REQUIRED,
      message: 'Get CarSalePro PRO in the mobile app and link the device to take orders',
    },
  });
}
