import { VinHistoryPayloadV1, VinHistorySummary } from './vin-history-payload-v1';

/** DI token for the active provider. One provider is bound per process. */
export const VIN_HISTORY_PROVIDER = Symbol('VIN_HISTORY_PROVIDER');

/**
 * A source of VIN provenance data.
 *
 * `configured` mirrors `StripeService.configured`: it answers "may this
 * provider be CHARGED for?", not "does it return something". That distinction
 * is the whole safety property of this feature — the mock provider always
 * returns data (so the free preview and the e2e suite work everywhere) but
 * reports itself as unconfigured in production, and `POST /unlock` refuses with
 * 503 rather than taking money for invented history.
 *
 * `preview` exists as a separate method on purpose. Real providers expose a free
 * "how many records do we hold for this VIN?" probe, and a paid full fetch. If
 * the free preview called `fetch`, every anonymous visitor typing a VIN into the
 * homepage would spend money.
 */
export interface VinHistoryProvider {
  /** Stable identifier, stored on every cached report and purchase row. */
  readonly name: string;

  /** True when the payload is generated rather than sourced from records. */
  readonly synthetic: boolean;

  /** True when this provider may back a PAID unlock. */
  get configured(): boolean;

  /** Free availability probe — counts and flags only. Must not be billable. */
  preview(vin: string): Promise<VinHistorySummary>;

  /** The billable full lookup. */
  fetch(vin: string): Promise<VinHistoryPayloadV1>;
}
