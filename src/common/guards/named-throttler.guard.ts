import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { internalKeyFromEnv, resolveClientIp, type ClientIpRequest } from '../client-ip';

/**
 * `THROTTLER:LIMIT` from `@nestjs/throttler` 6.5.0
 * (`dist/throttler.constants.js`). The constants module is NOT re-exported from
 * the package index — `dist/index.d.ts` exports the options/storage interfaces,
 * the decorator, the exception, the guard, the module and the service, and
 * nothing else — so the literal is inlined here rather than deep-imported from
 * `@nestjs/throttler/dist/...`, which would break on any internal reshuffle.
 * `@Throttle({ <name>: { limit, ttl } })` writes metadata under this key
 * suffixed with the throttler name.
 */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/**
 * Makes named throttlers opt-in.
 *
 * `ThrottlerGuard.canActivate` loops over EVERY configured throttler on EVERY
 * route and requires all of them to pass. With two buckets registered —
 * `default` at 120/min and `lookup` at 20/min — that meant the tighter `lookup`
 * bucket silently capped the entire API at 20 requests per minute per IP,
 * including routes that had explicitly raised their own limit: the mobile photo
 * upload asks for `{ default: { limit: 40 } }`, but the 21st upload still got a
 * 429 from `lookup`, and a full inspection carries far more than 20 photos, so
 * no complete report could finish its cloud backup in one pass.
 *
 * Here a named throttler other than `default` applies ONLY to routes that asked
 * for it with `@Throttle({ <name>: … })`. `default` keeps applying everywhere,
 * which is what makes it the default.
 */
@Injectable()
export class NamedThrottlerGuard extends ThrottlerGuard {
  /** DEN-417. Count the client, not the proxy node. See `client-ip.ts`. */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return resolveClientIp(req as unknown as ClientIpRequest, internalKeyFromEnv());
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = requestProps.throttler.name ?? 'default';

    if (name !== 'default') {
      const optedIn = this.reflector.getAllAndOverride(THROTTLER_LIMIT + name, [
        requestProps.context.getHandler(),
        requestProps.context.getClass(),
      ]);
      // No metadata for this bucket on this route (or its controller) → the
      // route never asked for it. Pass without touching the storage, so the
      // bucket does not even accumulate hits for unrelated traffic.
      if (optedIn === undefined || optedIn === null) return true;
    }

    return super.handleRequest(requestProps);
  }
}
