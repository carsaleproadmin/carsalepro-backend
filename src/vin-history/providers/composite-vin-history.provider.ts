import { Injectable, Logger } from '@nestjs/common';
import { isVinFormat } from '../../vin/vin.util';
import { mergeVinHistoryPayloads, VinHistoryMergeMember } from '../merge-vin-history';
import { ProviderResponseCache } from '../provider-response.cache';
import { VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { VinHistoryPreviewSummary, VinHistoryProvider } from '../vin-history.provider';

/**
 * One report from several sources.
 *
 * It is a `VinHistoryProvider` like any other, which is the point: nothing above
 * it — not `VinHistoryService`, not the controller, not the PDF renderer — knows
 * there is more than one source behind a report. It owns three decisions and
 * delegates everything else:
 *
 *  - WHICH members to call (the configured ones, all of them, in parallel);
 *  - WHAT a member's failure costs (nothing, unless they all fail);
 *  - WHERE each member's answer is cached (`ProviderResponseCache`, per member).
 *
 * What a merged report MEANS lives in `merge-vin-history.ts`, which is pure and
 * where every rule about double counting, blended valuations and recomputed
 * odometer flags is tested.
 */

/**
 * Every source failed. The one thing worth failing a sale for.
 *
 * `VinHistoryService` catches this, refunds the buyer in full and alerts every
 * admin — which is right, because it means the integration is down rather than
 * that this particular car has no records. A single member failing is NOT this:
 * the report is produced from the rest and says in `sources[]` which one did not
 * answer.
 */
export class AllVinHistorySourcesFailedError extends Error {
  constructor(vin: string, reasons: string[]) {
    super(
      `Every VIN history source failed for ${vin}` +
        (reasons.length > 0 ? ` (${reasons.join('; ')})` : ' (no source was configured)'),
    );
    this.name = 'AllVinHistorySourcesFailedError';
  }
}

@Injectable()
export class CompositeVinHistoryProvider implements VinHistoryProvider {
  private readonly logger = new Logger(CompositeVinHistoryProvider.name);

  /**
   * ⚠️ FROZEN LITERAL, for exactly the reasons a single source's name is frozen.
   * It is half of the `vin_provider` unique key on every cached merged report, it
   * is stamped on every `VinHistoryPurchase`, and it is baked into the R2 keys of
   * both the archived JSON and the rendered PDF (`vin-history/<provider>/<vin>/…`).
   * Renaming it orphans every cached report, every purchase's provenance and every
   * stored document at once, silently: nothing errors, the cache simply never hits
   * again and old purchases point at a provider that no longer exists.
   *
   * It says 'aggregate' and not the members' names on purpose too — the set of
   * members is expected to change, and the stored key must not.
   */
  readonly name = 'aggregate';

  /**
   * Sourced from records. A merged report is only ever synthetic if every member
   * that contributed to it was, and that is decided per payload by the merge —
   * this flag describes the PROVIDER, and this provider is not a generator.
   */
  readonly synthetic = false;

  constructor(
    private readonly members: VinHistoryProvider[],
    private readonly cache: ProviderResponseCache,
  ) {}

  /**
   * ANY member being usable makes the composite usable.
   *
   * `configured` answers "may this be CHARGED for?", and one working source is a
   * report worth selling — smaller than two, never nothing. With no member
   * configured it is false, so `POST /unlock` answers 503 and takes no money.
   */
  get configured(): boolean {
    return this.members.some((member) => member.configured);
  }

  /**
   * FORMAT ONLY: seventeen characters from the VIN alphabet, and nothing else.
   *
   * ⚠️ THE CHECK DIGIT IS DELIBERATELY NOT THE GATE ANY MORE. It was, and it was
   * the right gate for one US-only source: `vinHistoryCoverage` in
   * `src/vin/vin.util.ts` explains the reasoning, which still holds for the
   * member that reads it — 49 CFR 565 makes position 9 mandatory for US-market
   * vehicles and optional elsewhere, so a computing check digit is a good proxy
   * for "NMVTIS may hold a title ladder for this car".
   *
   * As the SELLING gate for a composite it is now wrong, and wrong in the
   * expensive direction: a European domestic VIN typically does not compute, and
   * refusing it here refuses the very cars a European source can describe in
   * full. That check digit keeps its job — deciding whether the US-only member
   * bothers to call its US-only endpoints — one level down, inside the member
   * that owns it.
   *
   * `not_covered` is therefore never returned. A VIN this composite cannot
   * describe is one no member holds anything for, and that is not knowable for
   * free; it surfaces as an empty answer at fetch time and refunds through
   * `MIN_SELLABLE_RECORD_COUNT`, which is the path that already exists for it.
   */
  covers(vin: string): 'supported' | 'not_covered' | 'invalid_vin' {
    return isVinFormat(vin) ? 'supported' : 'invalid_vin';
  }

  /**
   * ⚠️ NO FREE PROBE. `null`, always, and without touching the network.
   *
   * Not one member publishes an unbilled count — cheap is not free — and
   * `GET /api/v1/vin-history/:vin/preview` is `@Public()`, anonymous and
   * crawlable at twenty requests a minute. A single call from here lets a
   * stranger spend our money at that rate, times the number of members. `null`
   * means "this provider has no free probe", which the caller renders as no
   * counters at all — never as zeros, which would tell a visitor the car is clean
   * on the strength of never having looked.
   */
  async preview(_vin: string): Promise<VinHistoryPreviewSummary | null> {
    return null;
  }

  /**
   * Every member at once, each through its own cache row, then merged.
   *
   * `Promise.allSettled`, so one source being down costs its own section and
   * nothing else — the buyer keeps everything the other source holds, and
   * `sources[]` says which one did not answer rather than letting its absence
   * read as "nothing to report".
   *
   * Only CONFIGURED members are called. An unconfigured one cannot answer, and
   * recording it as `failed` would put an operator's missing API key on a
   * customer's report as though a source had broken.
   */
  async fetch(vin: string): Promise<VinHistoryPayloadV2> {
    const normalized = vin.toUpperCase();
    const usable = this.members.filter((member) => member.configured);

    const settled = await Promise.allSettled(
      usable.map((member) => this.cache.through(member, normalized)),
    );

    const failures: string[] = [];
    const members: VinHistoryMergeMember[] = usable.map((member, index) => {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        return { name: member.name, payload: result.value, failed: false };
      }

      const reason = (result.reason as Error)?.message ?? 'unknown';
      failures.push(`${member.name}: ${reason}`);
      // Loud, because a member failing is invisible to the buyer by design — the
      // report is still produced — and an integration that is quietly down for a
      // week is how a two-source product becomes a one-source product.
      this.logger.error(`VIN history member ${member.name} failed for ${normalized}: ${reason}`);
      return { name: member.name, payload: null, failed: true };
    });

    /*
     * The only fatal case: nobody answered. That covers a genuine outage and the
     * no-member-configured misconfiguration alike, and both deserve the same
     * treatment — a full refund and an admin alert — because in both the buyer
     * paid and there is nothing whatsoever to give them. One survivor is not this:
     * a partial report is a real report, and it says what is missing.
     */
    if (members.length === 0 || members.every((m) => m.failed)) {
      throw new AllVinHistorySourcesFailedError(normalized, failures);
    }

    return mergeVinHistoryPayloads({
      vin: normalized,
      // OUR name, not a member's. It is what the payload is stored and sold under.
      provider: this.name,
      generatedAt: new Date().toISOString(),
      members,
    });
  }
}
