import { VinHistoryPayloadV1, VinHistorySummary } from './vin-history-payload-v1';

/** DI token for the active provider. One provider is bound per process. */
export const VIN_HISTORY_PROVIDER = Symbol('VIN_HISTORY_PROVIDER');

/**
 * Per-array record counts for the free preview.
 *
 * Every field is `number | null`, and the difference matters: `0` is "the
 * provider looked and holds none", `null` is "the provider does not publish
 * this number". Collapsing the second into the first prints "0 accident
 * records" next to a car nobody checked for accidents — the strongest possible
 * claim, made out of an absence of data.
 *
 * These are NOT part of `VinHistorySummary`, and `VinHistorySummary` is not
 * extended in place, because that type is stored inside every cached
 * `VinHistoryPayloadV1` at `schemaVersion: 1`. Adding required fields to it
 * would invalidate every payload already sold.
 */
export interface VinHistoryPreviewCounts {
  mileageRecordCount: number | null;
  damageRecordCount: number | null;
  registrationCount: number | null;
  recallCount: number | null;
  inspectionCount: number | null;
}

/**
 * What `preview()` answers with: the stored summary shape plus the counts the
 * preview page needs and the summary never carried.
 *
 * Those five counters were hardcoded zeros in the preview response for as long
 * as the feature existed. The reason was here, in the contract, not in the
 * service: there was nowhere for a provider to PUT them.
 */
export interface VinHistoryPreviewSummary extends VinHistorySummary, VinHistoryPreviewCounts {}

/**
 * A source of VIN provenance data.
 *
 * `configured` mirrors `StripeService.configured`: it answers "may this
 * provider be CHARGED for?", not "does it return something". That distinction
 * is the whole safety property of this feature — the mock provider always
 * returns data (so the free preview and the e2e suite work everywhere) but
 * reports itself as unconfigured in production unless an operator has
 * explicitly opted in, and `POST /unlock` refuses with 503 rather than taking
 * money for invented history.
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
  preview(vin: string): Promise<VinHistoryPreviewSummary>;

  /** The billable full lookup. */
  fetch(vin: string): Promise<VinHistoryPayloadV1>;
}
