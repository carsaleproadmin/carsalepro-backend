import { Prisma } from '@prisma/client';

/**
 * The payments that count as revenue inside a time window.
 *
 * Order money is authorized when the order is created and captured when an
 * inspector accepts, which can be days later. Revenue is the CAPTURE, so the
 * window applies to `capturedAt`. Before DEN-293 the window applied to
 * `createdAt`: an order authorized yesterday and captured today was not in
 * today's revenue, and a 30-day summary lost the orders authorized before its
 * first day.
 *
 * A payment without `capturedAt` was not authorized first and captured later -
 * a Checkout payment, or an order paid before manual capture. For those, the
 * creation time is the time the money was taken.
 *
 * The dashboard and the finance summary both use this filter, so the two
 * figures cannot disagree about which day a payment belongs to.
 */
export function revenueInWindow(window: Prisma.DateTimeFilter): Prisma.PaymentWhereInput {
  return {
    status: 'succeeded',
    OR: [{ capturedAt: window }, { capturedAt: null, createdAt: window }],
  };
}
