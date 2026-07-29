// Category: STATE TRANSITIONS. Pure — no DB, no Nest container.
import { OrderStatus } from '@prisma/client';
import { ORDER_TRANSITIONS, canTransition } from './order-state-machine';

const ALL = Object.values(OrderStatus);
const TERMINAL: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.REFUNDED];

/** The edge list as documented in the module's own comment. */
const DOCUMENTED_EDGES: Array<[OrderStatus, OrderStatus]> = [
  [OrderStatus.CREATED, OrderStatus.PAID],
  [OrderStatus.CREATED, OrderStatus.CANCELLED],
  [OrderStatus.PAID, OrderStatus.ASSIGNED],
  [OrderStatus.PAID, OrderStatus.UNASSIGNED],
  [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.UNASSIGNED, OrderStatus.ASSIGNED],
  [OrderStatus.UNASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.ASSIGNED, OrderStatus.EN_ROUTE],
  [OrderStatus.ASSIGNED, OrderStatus.UNASSIGNED],
  [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.EN_ROUTE, OrderStatus.IN_PROGRESS],
  [OrderStatus.EN_ROUTE, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS, OrderStatus.SUBMITTED],
  [OrderStatus.IN_PROGRESS, OrderStatus.DISPUTED],
  [OrderStatus.SUBMITTED, OrderStatus.APPROVED],
  [OrderStatus.SUBMITTED, OrderStatus.DISPUTED],
  [OrderStatus.APPROVED, OrderStatus.COMPLETED],
  [OrderStatus.DISPUTED, OrderStatus.REFUNDED],
  [OrderStatus.DISPUTED, OrderStatus.APPROVED],
  [OrderStatus.DISPUTED, OrderStatus.COMPLETED],
  [OrderStatus.CANCELLED, OrderStatus.REFUNDED],
];

describe('order state machine', () => {
  it('allows exactly the documented edges and nothing else', () => {
    // Enumerated rather than derived from ORDER_TRANSITIONS, so the table and
    // the comment above it cannot silently drift apart. Adding an edge should
    // require editing both — that is the point.
    const allowed = new Set(DOCUMENTED_EDGES.map(([f, t]) => `${f}->${t}`));

    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
      }
    }
    expect(allowed.size).toBe(DOCUMENTED_EDGES.length);
  });

  it('covers every status in the table', () => {
    // A status missing from the map falls through `?? false`, silently making
    // an order unmovable rather than failing loudly.
    for (const status of ALL) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('has no self-transitions', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('treats COMPLETED and REFUNDED as terminal', () => {
    for (const status of TERMINAL) {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('reaches every status from CREATED', () => {
    // An unreachable status is dead code that will eventually be "handled"
    // somewhere and never exercised.
    const seen = new Set<OrderStatus>([OrderStatus.CREATED]);
    const queue: OrderStatus[] = [OrderStatus.CREATED];
    while (queue.length > 0) {
      for (const next of ORDER_TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
  });

  it('lets every non-terminal status reach a terminal one', () => {
    // Otherwise an order can get wedged in a state with no way out.
    for (const start of ALL) {
      if (TERMINAL.includes(start)) continue;

      const seen = new Set<OrderStatus>([start]);
      const queue: OrderStatus[] = [start];
      let escapes = false;
      while (queue.length > 0 && !escapes) {
        for (const next of ORDER_TRANSITIONS[queue.shift()!]) {
          if (TERMINAL.includes(next)) {
            escapes = true;
            break;
          }
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect({ start, escapes }).toEqual({ start, escapes: true });
    }
  });

  it('never skips payment: CREATED cannot reach work states without PAID', () => {
    // Money first. The only way out of CREATED other than PAID is CANCELLED.
    expect(ORDER_TRANSITIONS[OrderStatus.CREATED]).toEqual([
      OrderStatus.PAID,
      OrderStatus.CANCELLED,
    ]);
    for (const to of [
      OrderStatus.ASSIGNED,
      OrderStatus.EN_ROUTE,
      OrderStatus.IN_PROGRESS,
      OrderStatus.SUBMITTED,
      OrderStatus.APPROVED,
      OrderStatus.COMPLETED,
    ]) {
      expect(canTransition(OrderStatus.CREATED, to)).toBe(false);
    }
  });

  it('cannot cancel once work has started', () => {
    // Cancellation carries an automatic refund, so it must not remain available
    // after the inspector is on site.
    for (const from of [
      OrderStatus.IN_PROGRESS,
      OrderStatus.SUBMITTED,
      OrderStatus.APPROVED,
      OrderStatus.DISPUTED,
    ]) {
      expect(canTransition(from, OrderStatus.CANCELLED)).toBe(false);
    }
  });

  it('only reaches COMPLETED through APPROVED or a resolved dispute', () => {
    const intoCompleted = ALL.filter((from) => canTransition(from, OrderStatus.COMPLETED));
    expect(intoCompleted.sort()).toEqual([OrderStatus.APPROVED, OrderStatus.DISPUTED].sort());
  });

  it('only reaches REFUNDED through CANCELLED or a resolved dispute', () => {
    const intoRefunded = ALL.filter((from) => canTransition(from, OrderStatus.REFUNDED));
    expect(intoRefunded.sort()).toEqual([OrderStatus.CANCELLED, OrderStatus.DISPUTED].sort());
  });

  it('is total: an unknown status is refused, not crashed on', () => {
    expect(canTransition('NOT_A_STATUS' as OrderStatus, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.PAID, 'NOT_A_STATUS' as OrderStatus)).toBe(false);
  });
});
