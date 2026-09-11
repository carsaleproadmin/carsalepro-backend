/**
 * Why an admin cancelled an order or resolved a dispute (DEN-294).
 *
 * The reason is stored as an `OrderEvent` of its own type, with the decision in
 * `payload`. Two rules come with it:
 *
 * - **Only admins see it.** `OrdersService.getDetail` drops this event type from
 *   the timeline it gives to every role, and the admin order detail reads it
 *   back as a separate `decisions` list. Whether the customer and the inspector
 *   should also see the reason is a decision for the client; until then, the
 *   text is internal.
 * - **The timeline is unchanged.** A new event type in the shared timeline would
 *   need a label in all 35 catalogues and would show the customer an entry that
 *   explains nothing to them.
 */
export const ADMIN_DECISION_EVENT = 'admin_decision';

export const ADMIN_REASON_MIN_LENGTH = 10;
export const ADMIN_REASON_MAX_LENGTH = 1000;

export interface AdminDecision {
  action: 'cancel' | 'resolve_dispute';
  reason: string;
  /** The refund percent the admin chose; null when the decision has none. */
  refundPercent: number | null;
  /** Set only for `resolve_dispute`. */
  resolution: 'customer' | 'inspector' | null;
}

/**
 * Read a stored decision back. The payload is JSON from the database, so every
 * field is checked; a row that does not match gives null and is skipped, and it
 * never breaks the admin page.
 */
export function readAdminDecision(payload: unknown): AdminDecision | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.action !== 'cancel' && p.action !== 'resolve_dispute') return null;
  if (typeof p.reason !== 'string') return null;
  return {
    action: p.action,
    reason: p.reason,
    refundPercent: typeof p.refundPercent === 'number' ? p.refundPercent : null,
    resolution: p.resolution === 'customer' || p.resolution === 'inspector' ? p.resolution : null,
  };
}
