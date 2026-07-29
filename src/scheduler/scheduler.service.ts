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
