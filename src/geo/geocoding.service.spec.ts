import { of, throwError } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { DEFAULT_COUNTRY_CODE, GeocodingService } from './geocoding.service';

/**
 * The service is constructed directly rather than through a Nest testing
 * module: it takes three collaborators and no lifecycle, so the module would
 * only hide which of them the assertion depends on.
 */
function build(options: {
  token?: string;
  response?: unknown;
  fail?: { status?: number };
  cached?: string | null;
}) {
  const get = jest.fn((_url: string, _config?: unknown) =>
    options.fail
      ? throwError(() => ({ response: { status: options.fail?.status } }))
      : of({ data: options.response }),
  );
  const setWithTtl = jest.fn(async () => undefined);
  const redisGet = jest.fn(async () => options.cached ?? null);

  const service = new GeocodingService(
    { get } as unknown as HttpService,
    { get: redisGet, setWithTtl } as unknown as RedisService,
    { get: () => ({ token: options.token ?? 'test-token' }) } as unknown as ConfigService<
      never,
      true
    >,
  );
  return { service, get, setWithTtl, redisGet };
}

const BERLIN = { lat: 52.52, lng: 13.405 };

/** The live shape of Mapbox Geocoding v6, verified against the API. */
const germany = {
  features: [{ properties: { context: { country: { country_code: 'DE' } } } }],
};

describe('GeocodingService', () => {
  it('reads the country code out of a v6 reverse geocode', async () => {
    const { service, setWithTtl } = build({ response: germany });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBe('DE');
    expect(setWithTtl).toHaveBeenCalled();
  });

  it('upper-cases the provider value', async () => {
    const { service } = build({
      response: { features: [{ properties: { context: { country: { country_code: 'ua' } } } }] },
    });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBe('UA');
  });

  it('asks for the country feature alone', async () => {
    const { service, get } = build({ response: germany });

    await service.countryCodeFor(BERLIN);

    expect(get.mock.calls[0][0]).toContain('types=country');
  });

  // A point at sea returns a well-formed response with no features. It must
  // read as "unknown", not as an error and not as a country.
  it('answers null when the response carries no country', async () => {
    const { service, setWithTtl } = build({ response: { features: [] } });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBeNull();
    expect(setWithTtl).not.toHaveBeenCalled();
  });

  it('answers null on a provider failure instead of throwing', async () => {
    const { service } = build({ fail: { status: 500 } });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBeNull();
  });

  it('answers null on a rate limit instead of throwing', async () => {
    const { service } = build({ fail: { status: 429 } });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBeNull();
  });

  it('does not call the provider when no token is configured', async () => {
    const { service, get } = build({ token: '', response: germany });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('serves a cached country without calling the provider', async () => {
    const { service, get } = build({ cached: 'PL', response: germany });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBe('PL');
    expect(get).not.toHaveBeenCalled();
  });

  // A cache entry that is not a country code must be ignored rather than
  // returned: the caller writes this value into a NOT NULL column.
  it('ignores a malformed cache entry', async () => {
    const { service, get } = build({ cached: 'not-a-code', response: germany });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBe('DE');
    expect(get).toHaveBeenCalled();
  });

  it('rejects a provider value that is not two letters', async () => {
    const { service } = build({
      response: { features: [{ properties: { context: { country: { country_code: 'DEU' } } } }] },
    });

    await expect(service.countryCodeFor(BERLIN)).resolves.toBeNull();
  });

  it('keeps the fallback country in step with the column default', () => {
    expect(DEFAULT_COUNTRY_CODE).toBe('DE');
  });
});
