import { MONEY_RETRY_BACKOFF_MINUTES, MONEY_RETRY_MAX_ATTEMPTS, planRetry } from './retry-schedule';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const minutesFromNow = (plan: { nextRetryAt: Date | null }): number =>
  (plan.nextRetryAt!.getTime() - NOW) / 60_000;

describe('planRetry — the shared payout/refund backoff', () => {
  it('walks the published schedule, one step per attempt', () => {
    const steps = MONEY_RETRY_BACKOFF_MINUTES.slice(0, MONEY_RETRY_MAX_ATTEMPTS - 1);
    steps.forEach((expectedMinutes, index) => {
      const plan = planRetry(index, { now: NOW });
      expect(plan.attempts).toBe(index + 1);
      expect(plan.terminal).toBe(false);
      expect(minutesFromNow(plan)).toBe(expectedMinutes);
    });
  });

  it('goes terminal exactly at the cap, and stays there', () => {
    const atCap = planRetry(MONEY_RETRY_MAX_ATTEMPTS - 1, { now: NOW });
    expect(atCap.attempts).toBe(MONEY_RETRY_MAX_ATTEMPTS);
    expect(atCap.terminal).toBe(true);
    // Null, not "some far future date": the cron filters on nextRetryAt, so a
    // date here would keep a row that needs a human in the automatic queue.
    expect(atCap.nextRetryAt).toBeNull();

    const past = planRetry(MONEY_RETRY_MAX_ATTEMPTS + 4, { now: NOW });
    expect(past.terminal).toBe(true);
    expect(past.nextRetryAt).toBeNull();
  });

  it('treats a fatal provider error as terminal on the first attempt', () => {
    const plan = planRetry(0, { fatal: true, now: NOW });
    expect(plan.attempts).toBe(1);
    expect(plan.terminal).toBe(true);
    expect(plan.nextRetryAt).toBeNull();
  });

  it('never emits attempts below 1, whatever the stored counter says', () => {
    expect(planRetry(-3, { now: NOW }).attempts).toBe(1);
  });

  it('is monotonic — every step waits at least as long as the one before', () => {
    for (let i = 1; i < MONEY_RETRY_BACKOFF_MINUTES.length; i++) {
      expect(MONEY_RETRY_BACKOFF_MINUTES[i]).toBeGreaterThan(MONEY_RETRY_BACKOFF_MINUTES[i - 1]);
    }
  });
});
