import { STRIPE_BUSINESS_TYPES } from '../payments/stripe.service';
import {
  normalizeCountryCode,
  resolveConnectAccountParams,
  type ConnectAccountRequest,
  type StoredConnectAccount,
} from './connect-account-params';

const PLATFORM = 'DE';

const stored = (over: Partial<StoredConnectAccount> = {}): StoredConnectAccount => ({
  accountId: null,
  country: null,
  businessType: null,
  ...over,
});

/** Resolve and assert success in one step — every case below expects one or the other. */
function resolve(request: ConnectAccountRequest, account = stored(), platform = PLATFORM) {
  const result = resolveConnectAccountParams(request, account, platform);
  if (!result.ok) throw new Error(`expected a resolution, got ${result.code}`);
  return result.params;
}

describe('normalizeCountryCode', () => {
  it.each([
    ['pl', 'PL'],
    ['  de  ', 'DE'],
    ['Ee', 'EE'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeCountryCode(input)).toBe(expected);
  });

  it.each([['DEU'], ['D'], [''], ['D1'], ['  '], ['🇩🇪']])('refuses %s', (input) => {
    expect(normalizeCountryCode(input)).toBeNull();
  });

  it('refuses a non-string', () => {
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(undefined)).toBeNull();
  });

  /*
   * The shape is the ONLY rule. `ZZ` is not an assigned country and Stripe will
   * refuse it — from Stripe, at the moment of the call, which is the point: a
   * roster of supported countries kept here would refuse a country the day
   * Stripe adds it.
   */
  it('accepts a well-shaped code it cannot vouch for', () => {
    expect(normalizeCountryCode('zz')).toBe('ZZ');
  });
});

describe('resolveConnectAccountParams — the freedom this exists for', () => {
  it('takes the country the inspector named', () => {
    expect(resolve({ country: 'pl' }).country).toBe('PL');
  });

  it('accepts every one of Stripe’s four business types', () => {
    for (const businessType of STRIPE_BUSINESS_TYPES) {
      expect(resolve({ businessType }).businessType).toBe(businessType);
    }
  });

  /*
   * The old behaviour, now the fallback: an empty request from a client that
   * predates both fields must keep landing where it always did. That is why the
   * platform country is the LAST resort and not the first answer.
   */
  it('falls back to the platform country, and leaves the business type unset', () => {
    const params = resolve({});
    expect(params.country).toBe('DE');
    expect(params.businessType).toBeNull();
  });

  it('prefers a stored choice over the platform country', () => {
    expect(resolve({}, stored({ country: 'AT' })).country).toBe('AT');
  });

  it('prefers the request over a stored choice while no account exists', () => {
    const params = resolve({ country: 'ES', businessType: 'company' }, stored({ country: 'AT', businessType: 'individual' }));
    expect(params.country).toBe('ES');
    expect(params.businessType).toBe('company');
  });

  it('normalises a lower-case business type', () => {
    expect(resolve({ businessType: ' Company ' }).businessType).toBe('company');
  });

  it('treats an empty string as "not answered" rather than as a value', () => {
    const params = resolve({ country: '', businessType: '' }, stored({ country: 'IT' }));
    expect(params.country).toBe('IT');
    expect(params.businessType).toBeNull();
  });

  it('falls back to DE when the platform country itself is unusable', () => {
    expect(resolve({}, stored(), 'nonsense').country).toBe('DE');
  });

  it('refuses a malformed country', () => {
    const result = resolveConnectAccountParams({ country: 'DEU' }, stored(), PLATFORM);
    expect(result).toEqual({ ok: false, code: 'country_invalid', requested: 'DEU' });
  });

  it('refuses a business type Stripe does not have', () => {
    const result = resolveConnectAccountParams({ businessType: 'freelancer' }, stored(), PLATFORM);
    expect(result).toEqual({ ok: false, code: 'business_type_invalid', requested: 'freelancer' });
  });

  /*
   * A stored value that is no longer a Stripe business type (a hand-edited row,
   * or a value Stripe retires) must not be echoed back as one. It reads as
   * "unanswered", so Express asks again — which is recoverable, unlike shipping
   * a bad enum member to a client that switches on it.
   */
  it('ignores a stored business type that is not one of Stripe’s', () => {
    expect(resolve({}, stored({ businessType: 'sole_trader' })).businessType).toBeNull();
  });
});

describe('resolveConnectAccountParams — the country lock', () => {
  it('refuses another country once an account exists', () => {
    const result = resolveConnectAccountParams(
      { country: 'FR' },
      stored({ accountId: 'acct_1', country: 'DE' }),
      PLATFORM,
    );
    expect(result).toEqual({ ok: false, code: 'country_locked', stored: 'DE', requested: 'FR' });
  });

  it('allows a request naming the country the account is already in', () => {
    const params = resolve({ country: 'de' }, stored({ accountId: 'acct_1', country: 'DE' }));
    expect(params.country).toBe('DE');
  });

  /*
   * An account created before the column existed was created in the platform
   * country — that is what the code sent, and what the 20260819100000 migration
   * backfills. Reading a null as "unknown, so anything goes" would let a request
   * name FR, pass the lock, and be recorded against a German account that Stripe
   * will never relocate.
   */
  it('treats a legacy account with no stored country as belonging to the platform country', () => {
    const result = resolveConnectAccountParams(
      { country: 'FR' },
      stored({ accountId: 'acct_legacy' }),
      PLATFORM,
    );
    expect(result).toEqual({ ok: false, code: 'country_locked', stored: 'DE', requested: 'FR' });
    expect(resolve({}, stored({ accountId: 'acct_legacy' })).country).toBe('DE');
  });

  it('reports a business-type change on an existing account, so Stripe can be told', () => {
    const params = resolve(
      { businessType: 'company' },
      stored({ accountId: 'acct_1', country: 'DE', businessType: 'individual' }),
    );
    expect(params).toEqual({ country: 'DE', businessType: 'company', businessTypeChanged: true });
  });

  it('reports no change when the business type is repeated', () => {
    const params = resolve(
      { businessType: 'individual' },
      stored({ accountId: 'acct_1', country: 'DE', businessType: 'individual' }),
    );
    expect(params.businessTypeChanged).toBe(false);
  });

  /*
   * Nothing to tell Stripe when there is no account yet: the value travels in
   * `accounts.create`. A true here would cost an `accounts.update` call against
   * an account id that does not exist.
   */
  it('reports no change before an account exists', () => {
    expect(resolve({ businessType: 'company' }).businessTypeChanged).toBe(false);
  });
});
