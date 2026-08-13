import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { VinHistoryPayload } from './vin-history-payload-v2';
import { VinHistoryProvider } from './vin-history.provider';

/**
 * Per-MEMBER caching for a composite VIN history provider.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * `VinHistoryService` already caches, but it caches the thing it SELLS: one
 * `VinHistoryReport` row keyed on `(vin, 'aggregate')` holding the merged
 * report. That is right for the product and wrong for the money. With one key,
 * a miss — an expiry, a new VIN, a cache write that did not happen — re-pays
 * EVERY source behind the report, including the ones whose answer we still
 * hold. Two sources at roughly $8 and roughly $1 a lookup means the cheap way
 * to lose money here is to re-buy a US title ladder in order to refresh a
 * European inspection date.
 *
 * So each member's own answer is cached under that member's own `name`, in the
 * same table, under the same `(vin, provider)` unique key. No migration, no
 * second table, no new expiry mechanism: a run of two members over one VIN
 * leaves three rows — `('WBA…','carsxe')`, `('WBA…','carapi')` and
 * `('WBA…','aggregate')` — each expiring on its own clock. A hit on one source
 * does not re-pay the other.
 *
 * ⚠️ The key is `member.name`, never the composite's. That is the whole point,
 * and it is also why a member's `name` is as frozen as the composite's: rename
 * one and its rows are orphaned silently, exactly as the top-level rename would
 * do, with nothing erroring and the cache simply never hitting again.
 *
 * The cache semantics are lifted from `VinHistoryService.resolveReport` and
 * `rememberEmptyAnswer` on purpose, so there is one story about expiry in this
 * module and not two:
 *
 * - a fresh row is served without calling the member;
 * - a real answer is written with `vinHistoryCacheDays` (30);
 * - an answer holding no records is written with `vinHistoryEmptyCacheDays` (7),
 *   because a source that holds nothing for a VIN today holds nothing for it
 *   tomorrow, and paying to re-learn that every time is an unbounded cost with
 *   no upside — while the short window still lets a VIN that gains its first
 *   record become sellable within the week;
 * - `vinHistoryEmptyCacheDays: 0` disables the empty-answer row entirely, which
 *   is the documented escape and restores the pre-2026-08 behaviour.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE SERVICE. An empty answer is cached here and
 * then RETURNED, not thrown. A member holding nothing is not a failed report: the
 * other member may hold plenty, and the merged report is sellable on the strength
 * of that. Whether the MERGED result has enough to sell stays where it already
 * is — `MIN_SELLABLE_RECORD_COUNT` in `VinHistoryService`, reading the merged
 * summary.
 */
@Injectable()
export class ProviderResponseCache {
  private readonly logger = new Logger(ProviderResponseCache.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Run one member's `fetch` through its own cache row.
   *
   * Throws exactly what the member throws, and nothing else: a cache is not
   * allowed to invent a failure. Everything this class does around the call is
   * best-effort — see `read` and `write`.
   */
  async through(member: VinHistoryProvider, vin: string): Promise<VinHistoryPayload> {
    const normalized = vin.toUpperCase();

    const cached = await this.read(normalized, member.name);
    if (cached) {
      this.logger.log(`Cache hit for ${member.name} on ${normalized} — no call made`);
      return cached;
    }

    const payload = await member.fetch(normalized);
    await this.write(normalized, member.name, payload);
    return payload;
  }

  /**
   * The fresh row for this member and VIN, or null.
   *
   * A read failure is a MISS, not an error. The alternative is failing a lookup
   * a paying customer is waiting for because of a database hiccup on the
   * optimisation in front of it; the cost of the miss is one extra provider
   * call, which is exactly what this class exists to avoid but not at that
   * price. A payload we cannot recognise is a miss for the same reason — a row
   * written by an older shape must not crash a reader, it must simply be
   * refetched and overwritten.
   */
  private async read(vin: string, provider: string): Promise<VinHistoryPayload | null> {
    try {
      const row = await this.prisma.vinHistoryReport.findUnique({
        where: { vin_provider: { vin, provider } },
      });
      if (!row || row.expiresAt.getTime() <= Date.now()) return null;

      const payload = row.payload as unknown;
      if (!isPayloadShaped(payload)) {
        this.logger.warn(
          `Cached ${provider} payload for ${vin} is not a recognisable VIN history payload — refetching`,
        );
        return null;
      }
      return payload;
    } catch (err) {
      this.logger.warn(
        `Could not read the ${provider} cache row for ${vin}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Remember one member's answer.
   *
   * ⚠️ NEVER THROWS. The member has already been called and, on a billable
   * source, already been paid for. Losing the row costs one future lookup;
   * letting the write's failure escape costs the lookup we just bought, the
   * customer's report, and — through `VinHistoryService.failAndRefund` — an
   * admin alert for a fetch that actually succeeded.
   */
  private async write(vin: string, provider: string, payload: VinHistoryPayload): Promise<void> {
    try {
      const recordCount = recordCountOf(payload);
      const days = await this.settings.getNumber(
        recordCount > 0 ? 'vinHistoryCacheDays' : 'vinHistoryEmptyCacheDays',
      );

      // Zero (or a nonsense value) means "do not remember this". It is only ever
      // reachable for the empty case — `vinHistoryCacheDays` is a positive
      // setting — and it is the documented way to stop remembering empties.
      if (!Number.isFinite(days) || days <= 0) return;

      const expiresAt = new Date(Date.now() + days * 86_400_000);
      const data = {
        payload: payload as unknown as Prisma.InputJsonValue,
        recordCount,
        expiresAt,
      };

      await this.prisma.vinHistoryReport.upsert({
        where: { vin_provider: { vin, provider } },
        create: { vin, provider, ...data },
        // An existing row here is stale by definition — a fresh one would have
        // been served by `read` and this code never reached. The member was
        // asked again, so its answer and its clock both start over.
        update: { ...data, fetchedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `Could not cache the ${provider} answer for ${vin}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * `summary.recordCount`, defensively.
 *
 * The value arrives from a provider mapper on the write path and from a JSON
 * column on the read path, and neither is a compiler-checked guarantee at
 * runtime. An unreadable count is treated as zero, which caches the answer under
 * the SHORT expiry — the conservative direction, since it costs one more lookup
 * rather than serving a suspect payload for thirty days.
 */
function recordCountOf(payload: VinHistoryPayload): number {
  const count = payload?.summary?.recordCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

/** The minimum a cached row must look like before a reader will trust it. */
function isPayloadShaped(value: unknown): value is VinHistoryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VinHistoryPayload>;
  return (
    (candidate.schemaVersion === 1 || candidate.schemaVersion === 2) &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null
  );
}
