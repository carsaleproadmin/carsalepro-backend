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
 *   ASSIGNED    → EN_ROUTE | UNASSIGNED | CANCELLED
 *   EN_ROUTE    → IN_PROGRESS | CANCELLED
 *   IN_PROGRESS → SUBMITTED | DISPUTED
 *   SUBMITTED   → APPROVED | DISPUTED
 *   APPROVED    → COMPLETED
 *   DISPUTED    → REFUNDED | APPROVED | COMPLETED
 *   CANCELLED   → REFUNDED
 *   (COMPLETED, REFUNDED are terminal)
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.CREATED]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.ASSIGNED, OrderStatus.UNASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.UNASSIGNED]: [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.ASSIGNED]: [OrderStatus.EN_ROUTE, OrderStatus.UNASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.EN_ROUTE]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.SUBMITTED, OrderStatus.DISPUTED],
  [OrderStatus.SUBMITTED]: [OrderStatus.APPROVED, OrderStatus.DISPUTED],
  [OrderStatus.APPROVED]: [OrderStatus.COMPLETED],
  [OrderStatus.DISPUTED]: [OrderStatus.REFUNDED, OrderStatus.APPROVED, OrderStatus.COMPLETED],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUNDED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.REFUNDED]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
