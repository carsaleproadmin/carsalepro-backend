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
 * How far from the platform's base an inspector may go, either way.
 *
 * A bound is not paternalism, it is what keeps the quote meaningful. Without a
 * ceiling, the single inspector covering a rural region can ask any number at
 * all, because the customer has no alternative to compare against; without a
 * floor, an inspector can buy the queue by working at a loss and then leave the
 * platform holding jobs nobody else will take at that price.
 *
 * A PERCENT of the platform base rather than a fixed span in euros, so it
 * follows the regional tariffs rather than being right in one country and
 * absurd in the next.
 */
export const INSPECTOR_BASE_FEE_TOLERANCE_PERCENT = 30;

export interface InspectorBaseFeeBounds {
  minCents: number;
  maxCents: number;
}

/** The window around a platform base, rounded to whole cents. */
export function inspectorBaseFeeBounds(
  platformBaseCents: number,
  tolerancePercent: number = INSPECTOR_BASE_FEE_TOLERANCE_PERCENT,
): InspectorBaseFeeBounds {
  const base = Math.max(0, Math.round(platformBaseCents));
  const tolerance = Math.min(100, Math.max(0, tolerancePercent));
  const span = Math.round((base * tolerance) / 100);
  return { minCents: base - span, maxCents: base + span };
}

/**
 * The base to price with: the inspector's own, held inside the bounds, or the
 * platform's when they have not set one.
 *
 * CLAMPED rather than refused, and that is the important half. The bound moves
 * - a regional tariff changes, an operator edits the tolerance - and a stored
 * value that was legal when it was typed must not take the inspector out of
 * dispatch, silently, weeks later. Refusing an out-of-range number belongs at
 * the point where it is TYPED, where a person is present to be told.
 */
export function effectiveBaseFeeCents(
  inspectorBaseCents: number | null | undefined,
  platformBaseCents: number,
  tolerancePercent: number = INSPECTOR_BASE_FEE_TOLERANCE_PERCENT,
): number {
  if (inspectorBaseCents == null || !Number.isFinite(inspectorBaseCents)) {
    return platformBaseCents;
  }
  const { minCents, maxCents } = inspectorBaseFeeBounds(platformBaseCents, tolerancePercent);
  return Math.min(maxCents, Math.max(minCents, Math.round(inspectorBaseCents)));
}
