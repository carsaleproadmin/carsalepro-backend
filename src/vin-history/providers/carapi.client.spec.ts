// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no real network, no Nest container.
/**
 * The CarAPI client: what it retries, what it refuses to retry, how it paces
 * itself, and how it tells "there is no record" apart from "we never got an
 * answer".
 *
 * ⚠️ THE HTTP LAYER IS FAKED AND NOTHING HERE REACHES CARAPI. Seven credits
 * remain on the key and they are reserved; the responses below are the bodies
 * captured on 2026-08-12 and stored in `test/fixtures/carapi/`.
 *
 * Most of these assertions are about MONEY. Every endpoint costs a credit
 * including its failures, so a retry rule one branch too generous turns a bad
 * request into a bill, and a fan-out turns six calls into six refusals.
 */

import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import { of, throwError } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { CarapiClient, carapiRemainingCredits } from './carapi.client';

const VIN = 'WBAKU210X00R62021';
const API_KEY = 'carapi-key-do-not-log';

function fixture<T = Record<string, unknown>>(name: string): T {
  const path = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'carapi', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

type Answer = { status: number; data: unknown } | { throws: AxiosError };

interface Recorded {
  url: string;
  params: Record<string, unknown>;
  timeout: number | undefined;
  headers: Record<string, unknown> | undefined;
}

function client(answers: Answer[], apiKey = API_KEY): { client: CarapiClient; sent: Recorded[] } {
  const sent: Recorded[] = [];
  let index = 0;

  const http = {
    get: (
      url: string,
      config: { params: Record<string, unknown>; timeout: number; headers?: Record<string, unknown> },
    ) => {
      sent.push({ url, params: config.params, timeout: config.timeout, headers: config.headers });
      // The last answer repeats, so a test only has to describe what changes.
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if ('throws' in answer) return throwError(() => answer.throws);
      return of({
        status: answer.status,
        data: answer.data,
        statusText: '',
        headers: {},
        config: {},
      } as AxiosResponse<unknown>);
    },
  } as unknown as HttpService;

  const config = {
    // The CarsXE key sits beside it and must never be the one that goes out.
    get: () => ({ apiKey: 'carsxe-key', carapiKey: apiKey, provider: 'carapi', allowSyntheticSale: false }),
  } as unknown as ConfigService<AppConfig, true>;

  const instance = new CarapiClient(http, config);
  // Retries and pacing are exercised, the waiting is not.
  instance.sleep = async () => undefined;
  return { client: instance, sent };
}

function timeoutError(): AxiosError {
  const err = new Error('timeout of 15000ms exceeded') as AxiosError;
  err.code = 'ECONNABORTED';
  return err;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('CarapiClient — the request itself', () => {
  it('⚠️ sends the key as the `token` QUERY PARAMETER, never as a header', async () => {
    // Confirmed live: an Authorization header is ignored and the call refused.
    // As a param rather than in the URL string, so the key cannot end up in a
    // logged URL or in an interceptor's request record.
    const { client: c, sent } = client([{ status: 200, data: { vin: VIN } }]);
    await c.vinDecode(VIN);

    expect(sent[0].url).toBe(`https://api.carapi.dev/v1/vin-decode/${VIN}`);
    expect(sent[0].url).not.toContain(API_KEY);
    expect(sent[0].params).toEqual({ token: API_KEY });
    expect(sent[0].headers).toBeUndefined();
  });

  it('sends the CarAPI key, not the CarsXE key sitting next to it in config', async () => {
    const { client: c, sent } = client([{ status: 200, data: {} }]);
    await c.vinDecode(VIN);
    expect(sent[0].params.token).toBe(API_KEY);
    expect(sent[0].params.token).not.toBe('carsxe-key');
  });

  it('puts the VIN in the path for the VIN-keyed endpoints and in the query for the rest', async () => {
    const { client: c, sent } = client([{ status: 200, data: {} }]);
    await c.mileageHistory(VIN);
    await c.stolenCheck(VIN);
    await c.inspection(VIN, 'CZ');
    await c.valuation({ make: 'bmw', model: 'x6', year: 2016, country: 'DE' });
    await c.timeToSell({ make: 'bmw', model: 'x6', country: 'DE' });

    expect(sent[0].url).toBe(`https://api.carapi.dev/v1/mileage-history/${VIN}`);
    expect(sent[1].url).toBe(`https://api.carapi.dev/v1/stolen-check/${VIN}`);
    expect(sent[2].url).toBe(`https://api.carapi.dev/v1/inspection/${VIN}`);
    expect(sent[2].params).toEqual({ country: 'CZ', token: API_KEY });
    expect(sent[3].url).toBe('https://api.carapi.dev/v1/vehicle-valuation');
    expect(sent[3].params).toEqual({ make: 'bmw', model: 'x6', year: 2016, country: 'DE', token: API_KEY });
    expect(sent[4].url).toBe('https://api.carapi.dev/v1/time-to-sell');
  });

  it('makes no call at all without a key', async () => {
    const { client: c, sent } = client([{ status: 200, data: {} }], '');
    const result = await c.vinDecode(VIN);

    expect(c.configured).toBe(false);
    expect(result).toEqual({ status: 'failed', reason: 'carapi_api_key_not_configured' });
    expect(sent).toHaveLength(0);
  });

  it('⚠️ has no /photos method, in any spelling', async () => {
    /*
     * Every URL that endpoint returns embeds OUR API KEY as its `token`
     * parameter. Storing one puts a live credential in the database; rendering
     * one puts it in a paid PDF and in the browser's history. There is no image
     * proxy in this project to strip it behind, so the endpoint is not wired at
     * all — and this assertion is here so that adding it is a deliberate act
     * with a failing test attached, not a convenient afternoon.
     */
    const { client: c } = client([{ status: 200, data: {} }]);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(c));
    expect(methods.filter((name) => /photo/i.test(name))).toEqual([]);
  });
});

describe('CarapiClient — classifying an answer', () => {
  it('returns ok with the captured decode body', async () => {
    const body = fixture('vin-decode.eu-bmw-x6.json');
    const { client: c } = client([{ status: 200, data: body }]);
    await expect(c.vinDecode(VIN)).resolves.toEqual({ status: 'ok', body });
  });

  it('⚠️ calls the 400 "Invalid VIN" answer EMPTY, not failed, and never retries it', async () => {
    /*
     * The captured 400 for WVWZZZ1KZAW123456 — a syntactically valid VW VIN.
     * It may mean the string failed the provider's own check-digit test, or it
     * may mean the provider holds no record and reports that as invalid input.
     * We cannot tell from the outside, and it cost a credit either way.
     *
     * `empty` because both readings lead to the same place: nothing to fetch,
     * retrying changes nothing, the buyer is refunded. `failed` would page an
     * admin every time a European VIN missed.
     */
    const { client: c, sent } = client([{ status: 400, data: fixture('vin-decode.invalid.json') }]);

    await expect(c.vinDecode('WVWZZZ1KZAW123456')).resolves.toEqual({
      status: 'empty',
      reason: 'invalid_vin',
    });
    expect(sent).toHaveLength(1);
  });

  it('calls the valuation miss empty, whichever status it arrives under', async () => {
    // Coverage there is per MODEL, not merely per country: the BMW X6 missed in
    // a country where the VW Golf is priced.
    for (const status of [200, 400, 404]) {
      const { client: c, sent } = client([
        { status, data: fixture('valuation.de.not-found.json') },
      ]);
      const result = await c.valuation({ make: 'bmw', model: 'x6', year: 2016, country: 'DE' });

      expect(result.status).toBe('empty');
      expect(sent).toHaveLength(1);
    }
  });

  it('⚠️ calls a credential or billing refusal FAILED, never empty', async () => {
    /*
     * These arrive dressed exactly like "no record for this VIN", and the
     * difference decides whether anybody finds out. Classified `empty`, an
     * exhausted key would quietly refund every buyer and alert nobody — the
     * product would look unpopular while it was in fact dead.
     */
    const cases = [
      { status: 401, data: { error: 'Unauthorized' } },
      { status: 403, data: { error: 'Forbidden' } },
      { status: 200, data: { error: 'Invalid API token' } },
      { status: 200, data: { error: 'You have no credits remaining' } },
    ];
    for (const answer of cases) {
      const { client: c } = client([answer]);
      const result = await c.vinDecode(VIN);
      expect(result.status).toBe('failed');
    }
  });

  it('⚠️ calls a 429 failed and does NOT retry it', async () => {
    /*
     * 10 requests a minute. The answer to a refusal is the pacer below, not
     * another request — and a 4xx is never retried here whatever it says.
     */
    const { client: c, sent } = client([
      {
        status: 429,
        data: { code: 'rate_limited', error: 'Rate limit exceeded. Retry after 34 seconds.' },
      },
    ]);

    await expect(c.mileageHistory(VIN)).resolves.toEqual({ status: 'failed', reason: 'rate_limited' });
    expect(sent).toHaveLength(1);
  });

  it('does not mistake a rate limit for a billing problem', async () => {
    // 'limit' and 'quota' live in the same sentence family; the 429 is checked
    // first so an operator reading the logs is told the right thing.
    const { client: c } = client([{ status: 429, data: { code: 'rate_limited', error: 'quota' } }]);
    const result = await c.stolenCheck(VIN);
    expect(result).toEqual({ status: 'failed', reason: 'rate_limited' });
  });

  it('calls a 200 that is not an object failed', async () => {
    // An edge proxy answering with HTML, not the API answering about a car.
    const { client: c } = client([{ status: 200, data: '<html>502 Bad Gateway</html>' }]);
    await expect(c.vinDecode(VIN)).resolves.toEqual({ status: 'failed', reason: 'non_object_body' });
  });

  it('calls a 200 carrying only an unrecognised error failed', async () => {
    const { client: c } = client([{ status: 200, data: { error: 'Something went sideways' } }]);
    const result = await c.stolenCheck(VIN);
    expect(result.status).toBe('failed');
  });
});

describe('CarapiClient — what is retried, and what is not', () => {
  it('NEVER retries a 4xx', async () => {
    // A 4xx is an ANSWER. Repeating it spends another credit to be told the
    // same thing.
    const { client: c, sent } = client([{ status: 422, data: { error: 'bad country' } }]);
    await expect(c.inspection(VIN, 'CZ')).resolves.toEqual({ status: 'failed', reason: 'http_422' });
    expect(sent).toHaveLength(1);
  });

  it('retries a 5xx ONCE — every endpoint here is billable', async () => {
    // CarsXE gives its cheap endpoints two retries because only /history is
    // expensive. Here every call costs the same single credit, so they all get
    // the expensive endpoint's budget: one extra attempt, never two.
    const { client: c, sent } = client([{ status: 503, data: { error: 'service unavailable' } }]);
    await expect(c.mileageHistory(VIN)).resolves.toEqual({ status: 'failed', reason: 'http_503' });
    expect(sent).toHaveLength(2);
  });

  it('retries a timeout once and then gives up', async () => {
    const { client: c, sent } = client([{ throws: timeoutError() }]);
    await expect(c.vinDecode(VIN)).resolves.toEqual({
      status: 'failed',
      reason: 'transport:ECONNABORTED',
    });
    expect(sent).toHaveLength(2);
  });

  it('succeeds on the retry and returns the good body', async () => {
    const body = fixture('stolen-check.eu-bmw-x6.json');
    const { client: c, sent } = client([{ status: 502, data: {} }, { status: 200, data: body }]);

    await expect(c.stolenCheck(VIN)).resolves.toEqual({ status: 'ok', body });
    expect(sent).toHaveLength(2);
  });

  it('never rejects, whatever happens', async () => {
    const boom = new Error('socket hang up') as AxiosError;
    boom.code = 'ECONNRESET';
    const { client: c } = client([{ throws: boom }]);
    await expect(c.timeToSell({ make: 'bmw', model: 'x6', country: 'DE' })).resolves.toEqual({
      status: 'failed',
      reason: 'transport:ECONNRESET',
    });
  });
});

describe('CarapiClient — pacing, because the limit is ten a minute', () => {
  it('waits for a slot rather than sending an eleventh request inside the minute', async () => {
    const { client: c, sent } = client([{ status: 200, data: {} }]);
    let clock = 1_000_000;
    const waits: number[] = [];
    c.now = () => clock;
    c.sleep = async (ms) => {
      waits.push(ms);
      clock += ms;
    };

    for (let i = 0; i < 11; i += 1) await c.stolenCheck(VIN);

    // Ten went straight out; the eleventh waited for the first one's slot to
    // fall out of the rolling window.
    expect(waits).toEqual([60_000]);
    expect(sent).toHaveLength(11);
  });

  it('does not wait when the window has already rolled over', async () => {
    const { client: c } = client([{ status: 200, data: {} }]);
    let clock = 1_000_000;
    const waits: number[] = [];
    c.now = () => clock;
    c.sleep = async (ms) => {
      waits.push(ms);
      clock += ms;
    };

    for (let i = 0; i < 10; i += 1) await c.stolenCheck(VIN);
    clock += 60_001;
    await c.stolenCheck(VIN);

    expect(waits).toEqual([]);
  });
});

describe('CarapiClient — one bundle, in sequence', () => {
  const decode = fixture('vin-decode.eu-bmw-x6.json');

  it('⚠️ calls the six endpoints ONE AT A TIME, in order', async () => {
    /*
     * Never Promise.all. Six simultaneous requests trip the ten-a-minute limit
     * against themselves, and a refused request is still a spent credit.
     */
    const { client: c, sent } = client([{ status: 200, data: decode }]);
    await c.bundle(VIN, { inspectionCountry: 'CZ', marketCountry: 'DE' });

    expect(sent.map((r) => r.url.replace('https://api.carapi.dev/v1', ''))).toEqual([
      `/vin-decode/${VIN}`,
      `/mileage-history/${VIN}`,
      `/stolen-check/${VIN}`,
      `/inspection/${VIN}`,
      '/vehicle-valuation',
      '/time-to-sell',
    ]);
  });

  it('⚠️ stops after an empty decode instead of spending five more credits', async () => {
    const { client: c, sent } = client([{ status: 400, data: fixture('vin-decode.invalid.json') }]);
    const bundle = await c.bundle('WVWZZZ1KZAW123456', { inspectionCountry: 'CZ', marketCountry: 'DE' });

    expect(sent).toHaveLength(1);
    expect(bundle.vinDecode.status).toBe('empty');
    expect(bundle.mileageHistory).toEqual({
      status: 'skipped',
      reason: 'vin_not_in_provider_database',
    });
    expect(bundle.timeToSell.status).toBe('skipped');
  });

  it('builds the model-keyed queries from the decode, lower case', async () => {
    const { client: c, sent } = client([{ status: 200, data: decode }]);
    await c.bundle(VIN, { marketCountry: 'DE' });

    const valuation = sent.find((r) => r.url.endsWith('/vehicle-valuation'));
    expect(valuation?.params).toEqual({ make: 'bmw', model: 'x6', year: 2016, country: 'DE', token: API_KEY });
  });

  it('⚠️ uses the REGISTRATION year for the valuation query, and only there', async () => {
    /*
     * CarAPI publishes no model year. `registrationDate` is the only year in the
     * response — good enough to look a valuation up with, and deliberately never
     * written into the payload as a model year, where it would be invented.
     */
    const { client: c, sent } = client([{ status: 200, data: decode }]);
    await c.bundle(VIN, { marketCountry: 'DE' });
    expect(sent.find((r) => r.url.endsWith('/vehicle-valuation'))?.params.year).toBe(2016);

    const noDate = { ...decode, specifications: { make: 'BMW', model: 'X6' } };
    const second = client([{ status: 200, data: noDate }]);
    const bundle = await second.client.bundle(VIN, { marketCountry: 'DE' });

    // No year, no valuation call — the endpoint requires one and a guessed year
    // prices a different car.
    expect(bundle.valuation).toEqual({ status: 'skipped', reason: 'no_year_for_valuation' });
    // Time-to-sell needs no year, so it still runs.
    expect(second.sent.some((r) => r.url.endsWith('/time-to-sell'))).toBe(true);
  });

  it('skips the country-keyed calls nobody asked for, and records what was asked', async () => {
    const { client: c, sent } = client([{ status: 200, data: decode }]);
    const bundle = await c.bundle(VIN);

    expect(sent).toHaveLength(3);
    expect(bundle.inspection).toEqual({
      status: 'skipped',
      reason: 'no_inspection_country_requested',
    });
    expect(bundle.valuation.status).toBe('skipped');
    expect(bundle.request).toEqual({ inspectionCountry: null, marketCountry: null });
  });

  it('carries a failed section without losing the ones that answered', async () => {
    const { client: c } = client([
      { status: 200, data: decode },
      { status: 500, data: {} },
      { status: 500, data: {} },
      { status: 200, data: fixture('stolen-check.eu-bmw-x6.json') },
    ]);
    const bundle = await c.bundle(VIN);

    expect(bundle.vinDecode.status).toBe('ok');
    expect(bundle.mileageHistory.status).toBe('failed');
    expect(bundle.stolenCheck.status).toBe('ok');
  });
});

describe('CarapiClient — the free call', () => {
  it('reads the remaining balance from whichever key the account body used', () => {
    expect(carapiRemainingCredits({ credits: 7 })).toBe(7);
    expect(carapiRemainingCredits({ remainingCredits: '12' })).toBe(12);
    expect(carapiRemainingCredits({ credits: { remaining: 3 } })).toBe(3);
  });

  it('⚠️ answers null, never 0, for a body it does not recognise', () => {
    // The /account shape is the one thing here that was never captured. `null`
    // is "it did not tell us"; `0` would be "the key is exhausted", and a caller
    // reading the second from the first stops attempting lookups it can afford.
    expect(carapiRemainingCredits({ plan: 'free' })).toBeNull();
    expect(carapiRemainingCredits(null)).toBeNull();
  });
});

describe('CarapiClient — secrets and bodies stay out of the logs', () => {
  it('never writes the API key or a response body to a log line', async () => {
    const written: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      written.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      written.push(String(message));
    });

    // A body that carries the key back at us AND a paid artefact beside it.
    const { client: c } = client([
      {
        status: 500,
        data: {
          error: `Invalid api key ${API_KEY}`,
          mileageHistory: [{ mileage: 239556, createdAt: '2026-06-01T08:03:39.771Z' }],
        },
      },
    ]);
    await c.mileageHistory(VIN);

    const log = written.join('\n');
    expect(log).not.toContain(API_KEY);
    expect(log).not.toContain('239556');
  });
});
