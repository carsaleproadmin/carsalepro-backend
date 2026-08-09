import { OrderStatus } from '@prisma/client';

/**
 * Allowed order status transitions — the single source of truth. Any status
 * change in OrdersService MUST go through {@link canTransition} (enforced in
 * `OrdersService.transition`). Illegal edges are rejected with 409
 * `illegal_transition`.
 *
 * Edge list:
 *   CREATED     → PAID | CANCELLED
 *   PAID        → ASSIGNED | UNASSIGNED | CANCELLED
 *   UNASSIGNED  → ASSIGNED | CANCELLED
 *   ASSIGNED    → EN_ROUTE | CANCELLED
 *   EN_ROUTE    → IN_PROGRESS | CANCELLED
 *   IN_PROGRESS → SUBMITTED | DISPUTED
 *   SUBMITTED   → APPROVED | DISPUTED
 *   APPROVED    → COMPLETED
 *   DISPUTED    → REFUNDED | APPROVED | COMPLETED
 *   CANCELLED   → REFUNDED
 *   (COMPLETED, REFUNDED are terminal)
 *
 * **`ASSIGNED → UNASSIGNED` was deleted when manual capture shipped.** Nothing
 * ever performed it: losing an inspector after assignment is a cancellation or
 * a dispute, never a return to the search pool. Under manual capture keeping it
 * would have been actively unsafe — the money is CAPTURED the moment an
 * inspector accepts, so an order pushed back to UNASSIGNED would re-enter the
 * pool still carrying its `searchExpiresAt` deadline, and `expireUnfilledSearches`
 * would then try to release a hold that no longer exists: a captured order
 * cancelled, and a customer told nothing was ever taken.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.CREATED]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.ASSIGNED, OrderStatus.UNASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.UNASSIGNED]: [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.ASSIGNED]: [OrderStatus.EN_ROUTE, OrderStatus.CANCELLED],
  [OrderStatus.EN_ROUTE]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.SUBMITTED, OrderStatus.DISPUTED],
  [OrderStatus.SUBMITTED]: [OrderStatus.APPROVED, OrderStatus.DISPUTED],
  [OrderStatus.APPROVED]: [OrderStatus.COMPLETED],
  [OrderStatus.DISPUTED]: [OrderStatus.REFUNDED, OrderStatus.APPROVED, OrderStatus.COMPLETED],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUNDED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.REFUNDED]: [],
};

/** Statuses where the assigned inspector may attach the completed report. */
export const ATTACHABLE_REPORT_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.IN_PROGRESS,
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
