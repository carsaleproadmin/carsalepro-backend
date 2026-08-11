import { Injectable, Logger } from '@nestjs/common';
import { vinHistoryCoverage } from '../../vin/vin.util';
import { VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { VinHistoryPreviewSummary, VinHistoryProvider } from '../vin-history.provider';
import {
  CarsxeClient,
  CarsxeCallResult,
  CarsxeLienTheftResponse,
  CarsxeRawBundle,
  CarsxeRecallsResponse,
  CarsxeSection,
} from './carsxe.client';
import { mapCarsxeToPayloadV2, vehicleFromCarsxeSpecs } from './carsxe.mapper';

/**
 * The CarsXE-backed VIN history provider.
 *
 * It fans five endpoints out at once, hands whatever came back to a pure mapper,
 * and answers with a `VinHistoryPayloadV2`. Every decision about WHAT a response
 * means lives in the mapper; every decision about WHETHER to make a call lives
 * here.
 */

/** A `/history` transport failure — the only thing here worth failing a sale for. */
export class CarsxeHistoryUnavailableError extends Error {
  constructor(vin: string, reason: string) {
    super(`CarsXE /history did not answer for ${vin} (${reason})`);
    this.name = 'CarsxeHistoryUnavailableError';
  }
}

/** Why the two US-only endpoints were not called. Surfaced in `sources[]`. */
const NOT_US_MARKET = 'vin_not_us_market';

@Injectable()
export class CarsxeVinHistoryProvider implements VinHistoryProvider {
  private readonly logger = new Logger(CarsxeVinHistoryProvider.name);

  /**
   * ⚠️ FROZEN LITERAL. This string is written onto every `VinHistoryReport` row
   * (it is half of the `vin_provider` unique key) and onto every
   * `VinHistoryPurchase`, and it is baked into the R2 keys of both the archived
   * JSON and the rendered PDF (`vin-history/<provider>/<vin>/…`). Changing it
   * orphans every cached report, every purchase's provenance and every stored
   * document at once, silently — nothing would error, the cache would simply
   * never hit again and old purchases would point at a provider that no longer
   * exists. It can never change.
   */
  readonly name = 'carsxe';

  /** Sourced from records. Never generated, so never anything but false. */
  readonly synthetic = false;

  constructor(private readonly client: CarsxeClient) {}

  /** A key is the only thing standing between us and a 401 per purchase. */
  get configured(): boolean {
    return this.client.configured;
  }

  /**
   * Whether this source can hold anything for this VIN, decided offline.
   *
   * Delegated whole to `vinHistoryCoverage`, whose doc comment explains why the
   * check digit and not the region character: a German-built BMW sold in
   * California carries a `W` VIN and a complete US title ladder, and a region
   * gate would refuse precisely the imports this product exists to check.
   */
  covers(vin: string): 'supported' | 'not_covered' | 'invalid_vin' {
    return vinHistoryCoverage(vin);
  }

  /**
   * ⚠️ NO FREE PROBE. `null`, always, and without touching the network.
   *
   * CarsXE has no unbilled endpoint — `/specs` and `/marketvalue` are cheap, not
   * free. `GET /api/v1/vin-history/:vin/preview` is `@Public()` and rate-limited
   * at twenty requests a minute, so a single call from here would let an
   * anonymous visitor spend our money at twenty lookups a minute, from a page
   * that exists to be crawled. `null` is the honest answer: this provider
   * publishes no counts before payment, and the caller must show the price and
   * the free decode rather than counters it invented.
   */
  async preview(_vin: string): Promise<VinHistoryPreviewSummary | null> {
    return null;
  }

  /**
   * The billable lookup: five calls, one payload.
   *
   * `Promise.allSettled` because a secondary endpoint must never be able to fail
   * the purchase. A missing market valuation is a section marked `unavailable`
   * on a report that is otherwise complete; only `/history` failing to answer at
   * all is worth throwing over.
   */
  async fetch(vin: string): Promise<VinHistoryPayloadV2> {
    const normalized = vin.toUpperCase();

    /*
     * ⚠️ `/v1/recalls` and `/v1/lien-theft` are US-only databases that DO NOT
     * SAY SO. Asked about a European VIN they answer `success: true` with zero
     * events — an empty result from a database that was never searched. Rendered
     * straight through that becomes "no theft record found" and "no open
     * recalls", which is a false clean bill of health on a document someone paid
     * for. Skipping them marks both sections `not_covered`, which says the true
     * thing: we did not check, because this source cannot.
     */
    const usMarket = this.covers(normalized) === 'supported';
    if (!usMarket) {
      this.logger.warn(
        `CarsXE: ${normalized} is not a US-market VIN — skipping recalls and lien/theft`,
      );
    }

    const skipped: CarsxeSection<never> = { status: 'skipped', reason: NOT_US_MARKET };

    const [history, specs, marketValue, recalls, lienTheft] = await Promise.allSettled([
      this.client.history(normalized),
      this.client.specs(normalized),
      this.client.marketValue(normalized),
      usMarket
        ? this.client.recalls(normalized)
        : Promise.resolve<CarsxeCallResult<CarsxeRecallsResponse>>({
            status: 'failed',
            reason: NOT_US_MARKET,
          }),
      usMarket
        ? this.client.lienTheft(normalized)
        : Promise.resolve<CarsxeCallResult<CarsxeLienTheftResponse>>({
            status: 'failed',
            reason: NOT_US_MARKET,
          }),
    ]);

    const bundle: CarsxeRawBundle = {
      history: settled(history),
      specs: settled(specs),
      marketValue: settled(marketValue),
      recalls: usMarket ? settled(recalls) : skipped,
      lienTheft: usMarket ? settled(lienTheft) : skipped,
    };

    /*
     * The one fatal case, and it is deliberately narrow. `failed` means we never
     * got an answer — a timeout, a dead endpoint, a rejected key — and selling a
     * report with no history in it would be selling nothing. It throws, the
     * service refunds AND alerts, and an operator finds out the integration is
     * down.
     *
     * `empty` is NOT this. See below.
     */
    if (bundle.history.status === 'failed') {
      throw new CarsxeHistoryUnavailableError(normalized, bundle.history.reason);
    }

    const payload = mapCarsxeToPayloadV2(bundle, {
      vin: normalized,
      provider: this.name,
      generatedAt: new Date().toISOString(),
      // Built from the /specs response we already paid for, rather than a second
      // decode: the same call that gives us equipment names the car.
      vehicle: vehicleFromCarsxeSpecs(bundle.specs),
    });

    /*
     * An `empty` /history returns a well-formed payload with `recordCount: 0`
     * and does NOT throw. NMVTIS holding nothing for a VIN is a normal outcome —
     * by every consumer review of this category of provider, the most common
     * one. `VinHistoryService` sees the zero through `MIN_SELLABLE_RECORD_COUNT`
     * and refunds in full, quietly. Throwing here would produce the same refund
     * plus an admin alert for every such lookup, which trains operators to
     * ignore the channel that also carries "the refund did not go through".
     */
    if (bundle.history.status === 'empty') {
      this.logger.log(
        `CarsXE holds no history for ${normalized} (${bundle.history.reason}) — returning an empty report`,
      );
    }

    return payload;
  }
}

/**
 * A settled promise as a section.
 *
 * The client never rejects, so a rejection here is a bug in our own code rather
 * than a provider outage — and it is still handled, because a programming error
 * in one of five parallel calls must not cost a paying customer the other four.
 */
function settled<T>(result: PromiseSettledResult<CarsxeCallResult<T>>): CarsxeSection<T> {
  if (result.status === 'fulfilled') return result.value;
  return { status: 'failed', reason: `client_threw:${(result.reason as Error)?.message ?? 'unknown'}` };
}
