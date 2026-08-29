/**
 * The base fee an inspector has set for themselves, held inside the bounds the
 * platform allows (DEN-213).
 *
 * ONLY THE BASE is the inspector's to move. The kilometre and minute rates
 * describe the DRIVE, not the work: two inspectors covering the same distance
 * burn the same fuel and the same hour, and the kilometre rate is anchored to a
 * published tax figure that an individual cannot renegotiate. The base is the
 * part that is genuinely about this person - their experience, their equipment,
 * how busy they are.
 */

/**
 * The window, in cents. Owner's decision of 2026-08-28: a flat 5 to 500 EUR.
 *
 * It replaced a +/-30 % band around the platform base. The trade is worth
 * writing down rather than rediscovering:
 *
 *  - A PERCENTAGE followed the regional tariffs, so the window was proportional
 *    wherever the platform priced. A flat window does not: 5 to 500 EUR is a
 *    wide range against a 39 EUR base and a very different statement against a
 *    regional base of 20.
 *  - In exchange it is a number an inspector can be told without arithmetic,
 *    and it does not move under them when an operator edits a tariff.
 *
 * The floor is not zero on purpose. A zero base is not a discount, it is an
 * inspector working the travel fee alone, and it invites buying the queue at a
 * loss. The ceiling is what stops the only inspector in a rural region asking
 * any number at all, because the customer there has nothing to compare against.
 */
export const INSPECTOR_BASE_FEE_MIN_CENTS = 500;
export const INSPECTOR_BASE_FEE_MAX_CENTS = 50_000;

export interface InspectorBaseFeeBounds {
  minCents: number;
  maxCents: number;
}

/**
 * The window an inspector's base fee must stay inside.
 *
 * It takes no arguments today. It stays a FUNCTION rather than a bare constant
 * because the window has already been proportional once and may be again - a
 * per-region ceiling is the obvious next request - and every caller reading it
 * through one entry point is what makes that a one-file change.
 */
export function inspectorBaseFeeBounds(): InspectorBaseFeeBounds {
  return { minCents: INSPECTOR_BASE_FEE_MIN_CENTS, maxCents: INSPECTOR_BASE_FEE_MAX_CENTS };
}

/**
 * The base to price with: the inspector's own, held inside the bounds, or the
 * platform's when they have not set one.
 *
 * CLAMPED rather than refused, and that is the important half. The bound moves
 * - an operator edits it, a region gets its own - and a stored value that was
 * legal when it was typed must not take the inspector out of dispatch,
 * silently, weeks later. Refusing an out-of-range number belongs at the point
 * where it is TYPED, where a person is present to be told.
 */
export function effectiveBaseFeeCents(
  inspectorBaseCents: number | null | undefined,
  platformBaseCents: number,
): number {
  if (inspectorBaseCents == null || !Number.isFinite(inspectorBaseCents)) {
    return platformBaseCents;
  }
  const { minCents, maxCents } = inspectorBaseFeeBounds();
  return Math.min(maxCents, Math.max(minCents, Math.round(inspectorBaseCents)));
}
