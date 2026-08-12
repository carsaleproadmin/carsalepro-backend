import { Injectable, Logger } from '@nestjs/common';
import { VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { VinHistoryPreviewSummary, VinHistoryProvider } from '../vin-history.provider';
import { CarapiClient, CarapiInspectionCountry } from './carapi.client';
import { mapCarapiToPayloadV2 } from './carapi.mapper';

/**
 * The CarAPI-backed source.
 *
 * One bundle of lookups per report, handed whole to a pure mapper. Every
 * decision about WHAT an answer means lives in the mapper; every decision about
 * WHETHER to ask lives here.
 */

/** A `/vin-decode` that never answered — the only failure worth a refund. */
export class CarapiDecodeUnavailableError extends Error {
  constructor(vin: string, reason: string) {
    super(`CarAPI did not answer for ${vin} (${reason})`);
    this.name = 'CarapiDecodeUnavailableError';
  }
}

/**
 * Which technical-inspection register to query.
 *
 * The endpoint accepts CZ or SK and nothing else, and **we cannot know which
 * one applies** — no CarAPI response says where a vehicle is registered.
 * `manufacturer.country` is the country the car was BUILT in, which for a Czech
 * Škoda and a German BMW sold in Prague gives opposite and equally wrong
 * answers.
 *
 * So one register is asked, and Czechia is the larger of the two. A miss costs
 * one credit and the section reports itself uncovered, which is the honest
 * outcome — far better than the alternative of asking both and paying twice to
 * be wrong once.
 */
const INSPECTION_COUNTRY: CarapiInspectionCountry = 'CZ';

/**
 * The market the valuation and the time-to-sell figures describe.
 *
 * The BUYER's market, not the car's. Someone reading this report is deciding
 * whether to buy a car in Germany, so a German price and a German selling time
 * are the useful answers even for an import. Wiring it to the vehicle's origin
 * would price a Czech car for the Czech market and tell a German buyer nothing.
 */
const MARKET_COUNTRY = 'DE';

@Injectable()
export class CarapiVinHistoryProvider implements VinHistoryProvider {
  private readonly logger = new Logger(CarapiVinHistoryProvider.name);

  /**
   * ⚠️ FROZEN LITERAL. It is half of the `(vin, provider)` unique key on the
   * response cache, so renaming it orphans every cached CarAPI answer at once —
   * silently, because nothing errors and the cache simply never hits again.
   */
  readonly name = 'carapi';

  /** Sourced from records, never generated. */
  readonly synthetic = false;

  constructor(private readonly client: CarapiClient) {}

  get configured(): boolean {
    return this.client.configured;
  }

  /**
   * NO `covers()` — deliberately, and it is not an oversight.
   *
   * Its absence means "covers everything", which is right here: this source is
   * gated by database membership, not by geography or by a titling rule, and it
   * answers for European cars that the US-shaped check-digit test refuses. The
   * composite provider gates selling on VIN FORMAT alone, and a VIN this source
   * happens not to hold costs one credit and reports itself empty.
   */

  /**
   * ⚠️ NO FREE PROBE. `null`, always, without touching the network.
   *
   * Every CarAPI endpoint is billable — a `400`, a `404` and a `503` all cost a
   * credit — and the preview route is public, anonymous and rate-limited at
   * twenty requests a minute. One call from here would let a visitor spend our
   * money at twenty lookups a minute from a page built to be crawled.
   */
  async preview(_vin: string): Promise<VinHistoryPreviewSummary | null> {
    return null;
  }

  /**
   * The billable lookup: one sequenced bundle, one payload.
   *
   * The client sequences rather than parallelises on purpose — six calls fired
   * at once land inside the same tick and trip the ten-per-minute limiter, which
   * costs credits for answers we then throw away.
   */
  async fetch(vin: string): Promise<VinHistoryPayloadV2> {
    const normalized = vin.toUpperCase();

    const bundle = await this.client.bundle(normalized, {
      inspectionCountry: INSPECTION_COUNTRY,
      marketCountry: MARKET_COUNTRY,
    });

    /*
     * The one fatal case, and it is narrow. `failed` means no answer arrived at
     * all — a timeout, a dead endpoint, a rejected key. Everything downstream in
     * this bundle is keyed off the decode, so without it there is nothing to
     * sell and an operator needs to know the integration is down.
     *
     * `empty` is NOT this, and the difference matters: CarAPI reports a VIN it
     * does not hold as `400 Invalid VIN`, which may mean "malformed" or may mean
     * "not in our database" — the API does not distinguish them. Either way it
     * is a normal outcome, the payload comes back well formed with nothing in
     * it, and the composite decides whether the other source rescued the report.
     */
    if (bundle.vinDecode.status === 'failed') {
      throw new CarapiDecodeUnavailableError(normalized, bundle.vinDecode.reason);
    }

    if (bundle.vinDecode.status === 'empty') {
      this.logger.log(`CarAPI holds no record for ${normalized} — returning an empty report`);
    }

    return mapCarapiToPayloadV2(bundle, {
      vin: normalized,
      provider: this.name,
      generatedAt: new Date().toISOString(),
    });
  }
}
