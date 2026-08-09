/**
 * The retry schedule shared by every queue that moves money: payouts out to
 * inspectors and refunds back to customers.
 *
 * It lives on its own, and is pure, for two reasons.
 *
 * 1. The arithmetic is the whole safety property. `attempts` decides whether a
 *    row is still eligible (the cron filters on `attempts < cap`), so a second
 *    copy of "increment and schedule" that disagrees by one is enough to make a
 *    row invisible to the retry loop while still looking healthy in the queue —
 *    which is exactly what a hand-rolled `attempts: { increment: 1 }` in the
 *    transfer-failed webhook did to payouts.
 * 2. Everything else in the money path needs a database and a Stripe stand-in
 *    to test. This does not, so the schedule itself can be pinned exactly.
 */

/**
 * Minutes to wait before attempt N+1, indexed by the attempt that just failed.
 *
 * 5 min → 15 min → 1 h → 6 h → 1 day → 3 days. Front-loaded because most
 * failures are transient (a rate limit, a connection reset) and should clear
 * within the hour; stretched at the tail because anything still failing after a
 * day is a condition that needs a human, and an automated retry that never gives
 * up turns one broken transfer into a permanent alert.
 */
export const MONEY_RETRY_BACKOFF_MINUTES: readonly number[] = [5, 15, 60, 360, 1440, 4320];

/** Attempts after which a queue row stops retrying by itself. */
export const MONEY_RETRY_MAX_ATTEMPTS = MONEY_RETRY_BACKOFF_MINUTES.length;

export interface RetryPlan {
  /** The attempt that has just been made (1-based). */
  attempts: number;
  /** True when no further automatic attempt will be scheduled. */
  terminal: boolean;
  /** When the cron may try again. Null when terminal — it needs an operator. */
  nextRetryAt: Date | null;
}

/**
 * Plan the next attempt after a failure.
 *
 * `fatal` is for a provider error that no repetition can change — a card error,
 * a charge that does not exist. Six retries against a permanent condition only
 * delay the operator's involvement by three days, so it goes terminal at once
 * and stays visible in the queue instead.
 */
export function planRetry(
  previousAttempts: number,
  opts: { fatal?: boolean; now?: number } = {},
): RetryPlan {
  const attempts = Math.max(0, previousAttempts) + 1;
  const terminal = opts.fatal === true || attempts >= MONEY_RETRY_MAX_ATTEMPTS;
  const minutes =
    MONEY_RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, MONEY_RETRY_BACKOFF_MINUTES.length - 1)];
  const now = opts.now ?? Date.now();
  return {
    attempts,
    terminal,
    nextRetryAt: terminal ? null : new Date(now + minutes * 60_000),
  };
}
