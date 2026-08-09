import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KycService } from '../kyc/kyc.service';
import { ListingsService } from '../listings/listings.service';
import { LegalContractService } from '../legal/legal-contract.service';
import { OrdersService } from '../orders/orders.service';

/**
 * Scheduled automation (E11). Reuses the existing deferred job methods on the
 * domain services — those already emit notifications where appropriate
 * (auto-approve → order.approved, listing expire → listing.expiring).
 *
 * The WHOLE scheduler is gated off when NODE_ENV==='test' OR
 * SCHEDULER_ENABLED==='false': every job short-circuits via `disabled`, so no
 * background timers do work during tests or in a deployment that runs the
 * scheduler in a dedicated worker only. Each job is wrapped in try/catch and
 * logs a one-line summary of how many rows it affected.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly disabled =
    process.env.NODE_ENV === 'test' || process.env.SCHEDULER_ENABLED === 'false';

  constructor(
    private readonly orders: OrdersService,
    private readonly listings: ListingsService,
    private readonly kyc: KycService,
    private readonly legalContract: LegalContractService,
  ) {
    if (this.disabled) {
      this.logger.log('Scheduler disabled (NODE_ENV=test or SCHEDULER_ENABLED=false)');
    } else {
      this.logger.log('Scheduler enabled (in-process)');
    }
  }

  /** Every minute: expire stale PENDING offers and cascade dispatch. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'expire-stale-offers' })
  async expireStaleOffers(): Promise<void> {
    if (this.disabled) return;
    try {
      const { expired } = await this.orders.expireStaleOffers();
      if (expired > 0) this.logger.log(`expireStaleOffers: ${expired} offer(s) expired`);
    } catch (err) {
      this.logger.error(`expireStaleOffers failed: ${(err as Error).message}`);
    }
  }

  /** Hourly: auto-approve overdue SUBMITTED orders + expire overdue listings. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'hourly-sweeps' })
  async hourlySweeps(): Promise<void> {
    if (this.disabled) return;
    try {
      const { approved } = await this.orders.autoApproveOverdue();
      if (approved > 0) this.logger.log(`autoApproveOverdue: ${approved} order(s) approved`);
    } catch (err) {
      this.logger.error(`autoApproveOverdue failed: ${(err as Error).message}`);
    }
    try {
      const expired = await this.listings.expireOverdue();
      if (expired > 0) this.logger.log(`expireOverdue: ${expired} listing(s) expired`);
    } catch (err) {
      this.logger.error(`listing expireOverdue failed: ${(err as Error).message}`);
    }
    try {
      // Contracts whose inline PDF render failed (R2 blip, transient error).
      const { attempted, rendered } = await this.legalContract.backfillMissingPdfs();
      if (attempted > 0) {
        this.logger.log(`backfillMissingPdfs: ${rendered}/${attempted} contract PDF(s) rendered`);
      }
    } catch (err) {
      this.logger.error(`backfillMissingPdfs failed: ${(err as Error).message}`);
    }
  }

  /**
   * Every five minutes: orders nobody accepted inside the search window get
   * their authorization hold released and are cancelled.
   *
   * Five minutes, not hourly, because this holds real money on a real card. The
   * window itself is `orderSearchWindowMinutes` (six hours); the granularity of
   * this job is only how far past the deadline a hold may linger.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'expire-unfilled-searches' })
  async expireUnfilledSearches(): Promise<void> {
    if (this.disabled) return;
    try {
      const { expired } = await this.orders.expireUnfilledSearches();
      if (expired > 0) {
        this.logger.log(`expireUnfilledSearches: ${expired} order(s) cancelled, holds released`);
      }
    } catch (err) {
      this.logger.error(`expireUnfilledSearches failed: ${(err as Error).message}`);
    }
  }

  /**
   * Every fifteen minutes: a payment whose webhook never arrived.
   *
   * Insurance, NOT the plan — Stripe must be subscribed to
   * `payment_intent.amount_capturable_updated` before manual capture deploys,
   * or every order authorizes and sits in CREATED, and this job becomes the only
   * thing moving them. There is no `EVERY_15_MINUTES` in CronExpression, hence
   * the literal.
   */
  @Cron('0 */15 * * * *', { name: 'reconcile-stuck-order-payments' })
  async reconcileStuckOrderPayments(): Promise<void> {
    if (this.disabled) return;
    try {
      const { scanned, advanced } = await this.orders.reconcileStuckOrderPayments();
      if (scanned > 0) {
        this.logger.log(
          `reconcileStuckOrderPayments: ${scanned} scanned, ${advanced} driven to the right state`,
        );
      }
    } catch (err) {
      this.logger.error(`reconcileStuckOrderPayments failed: ${(err as Error).message}`);
    }
  }

  /**
   * Every ten minutes: retry payouts whose backoff has elapsed. Separate from
   * the hourly sweep because a stuck payout is money owed — the first retry
   * should land in minutes, not at the top of the next hour.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'retry-stuck-payouts' })
  async retryStuckPayouts(): Promise<void> {
    if (this.disabled) return;
    try {
      const { retried, settled } = await this.orders.retryStuckPayouts();
      if (retried > 0) {
        this.logger.log(`retryStuckPayouts: ${retried} attempted, ${settled} settled`);
      }
    } catch (err) {
      this.logger.error(`retryStuckPayouts failed: ${(err as Error).message}`);
    }
  }

  /**
   * Every ten minutes: retry refunds whose backoff has elapsed. Money owed BACK
   * to a customer is as urgent as money owed to an inspector, and a refund the
   * provider refused is invisible to the customer — they simply never see it.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'retry-stuck-refunds' })
  async retryStuckRefunds(): Promise<void> {
    if (this.disabled) return;
    try {
      const { retried, settled } = await this.orders.retryStuckRefunds();
      if (retried > 0) {
        this.logger.log(`retryStuckRefunds: ${retried} attempted, ${settled} settled`);
      }
    } catch (err) {
      this.logger.error(`retryStuckRefunds failed: ${(err as Error).message}`);
    }
  }

  /**
   * Nightly: copy the showroom photos of report-backed listings into the public
   * bucket, so their images get permanent URLs.
   *
   * Publication already mirrors, so this pass exists for the backlog: every
   * listing published before the public bucket was configured, plus anything a
   * transient R2 failure left unstamped. Batched at 50 because each photo is a
   * download from one bucket and an upload to another; a nightly run that tries
   * to drain years of history in one pass is how a "harmless" cron takes the
   * service down.
   *
   * A no-op when `R2_PUBLIC_*` is unset — which is the normal state, and the
   * whole point of the per-row design.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'mirror-showroom-photos' })
  async mirrorShowroomPhotos(): Promise<void> {
    if (this.disabled) return;
    try {
      const { scanned, mirrored } = await this.listings.mirrorPendingShowroomPhotos(50);
      if (scanned > 0) {
        this.logger.log(`mirrorPendingShowroomPhotos: ${scanned} scanned, ${mirrored} mirrored`);
      }
    } catch (err) {
      this.logger.error(`mirrorPendingShowroomPhotos failed: ${(err as Error).message}`);
    }
  }

  /** Daily: purge old KYC documents past the retention window. */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'purge-old-kyc' })
  async purgeOldKyc(): Promise<void> {
    if (this.disabled) return;
    try {
      const purged = await this.kyc.purgeOldDocuments();
      if (purged > 0) this.logger.log(`purgeOldDocuments: ${purged} document(s) purged`);
    } catch (err) {
      this.logger.error(`purgeOldDocuments failed: ${(err as Error).message}`);
    }
  }
}
