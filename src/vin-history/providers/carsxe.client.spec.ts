// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no real network, no Nest container.
/**
 * The CarsXE client: what it retries, what it refuses to retry, and how it tells
 * "there is no record" apart from "we never got an answer".
 *
 * ⚠️ THE HTTP LAYER IS FAKED AND NOTHING HERE REACHES CARSXE. The account is on
 * a Sandbox tier with one lifetime `/history` call and it must stay unspent.
 *
 * Most of these assertions are about MONEY. `/history` is $4.99 a call, so a
 * retry rule that is one branch too generous turns a bad request into a bill.
 */

import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { CarsxeClient } from './carsxe.client';

const VIN = 'WBAFR7C57CC811956';
const API_KEY = 'sandbox-key-do-not-log';

type Answer = { status: number; data: unknown } | { throws: AxiosError };

interface Recorded {
  url: string;
  params: Record<string, unknown>;
  timeout: number | undefined;
}

function client(answers: Answer[], apiKey = API_KEY): { client: CarsxeClient; sent: Recorded[] } {
  const sent: Recorded[] = [];
  let index = 0;

  const http = {
    get: (url: string, config: { params: Record<string, unknown>; timeout: number }) => {
      sent.push({ url, params: config.params, timeout: config.timeout });
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
    get: () => ({ apiKey, provider: 'carsxe', allowSyntheticSale: false }),
  } as unknown as ConfigService<AppConfig, true>;

  const instance = new CarsxeClient(http, config);
  // Retries are exercised, the waiting is not.
  instance.sleep = async () => undefined;
  return { client: instance, sent };
}

function timeoutError(): AxiosError {
  const err = new Error('timeout of 30000ms exceeded') as AxiosError;
  err.code = 'ECONNABORTED';
  return err;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('CarsxeClient — the request itself', () => {
  it('sends the key as a query PARAMETER, never in the path', async () => {
    // Params, so the key cannot end up in a logged URL or in an interceptor's
    // request record.
    const { client: c, sent } = client([{ status: 200, data: { success: true } }]);
    await c.history(VIN);

    expect(sent[0].url).toBe('https://api.carsxe.com/history');
    expect(sent[0].url).not.toContain(API_KEY);
    expect(sent[0].params).toEqual({ key: API_KEY, vin: VIN });
  });

  it('gives the expensive endpoint a longer timeout than the cheap ones', async () => {
    const { client: c, sent } = client([{ status: 200, data: { success: true } }]);
    await c.history(VIN);
    await c.specs(VIN);
    expect(sent[0].timeout).toBe(30_000);
    expect(sent[1].timeout).toBe(10_000);
  });

  it('makes no call at all without a key', async () => {
    const { client: c, sent } = client([{ status: 200, data: { success: true } }], '');
    const result = await c.history(VIN);

    expect(c.configured).toBe(false);
    expect(result).toEqual({ status: 'failed', reason: 'carsxe_api_key_not_configured' });
    expect(sent).toHaveLength(0);
  });
});

describe('CarsxeClient — classifying an answer', () => {
  it('returns ok for a 200 with success true', async () => {
    const { client: c } = client([{ status: 200, data: { success: true, events: [] } }]);
    await expect(c.lienTheft(VIN)).resolves.toEqual({
      status: 'ok',
      body: { success: true, events: [] },
    });
  });

  it('returns ok for a 200 that carries no success flag at all', async () => {
    const { client: c } = client([{ status: 200, data: { recalls: [] } }]);
    const result = await c.recalls(VIN);
    expect(result.status).toBe('ok');
  });

  it('returns empty for a 404', async () => {
    const { client: c, sent } = client([{ status: 404, data: { error: 'not found' } }]);
    await expect(c.history(VIN)).resolves.toEqual({ status: 'empty', reason: 'http_404' });
    expect(sent).toHaveLength(1);
  });

  it('⚠️ trusts the body over the status: HTTP 500 with success:false is EMPTY', async () => {
    /*
     * The legacy quirk, and the reason `validateStatus` is disabled in the
     * client. Some v1 endpoints report a validation error or a missing record as
     * HTTP 500 with `success: false` in the body. Read as a server error it
     * would be retried — twice, on the $4.99 endpoint — to be told the same
     * thing each time.
     */
    const { client: c, sent } = client([
      { status: 500, data: { success: false, error: 'report_not_found' } },
    ]);

    await expect(c.history(VIN)).resolves.toEqual({
      status: 'empty',
      reason: 'report_not_found',
    });
    expect(sent).toHaveLength(1);
  });

  it('returns empty for a plain success:false with no message', async () => {
    const { client: c } = client([{ status: 200, data: { success: false } }]);
    await expect(c.history(VIN)).resolves.toEqual({ status: 'empty', reason: 'success_false' });
  });

  it('⚠️ calls a credential or billing refusal FAILED, never empty', async () => {
    /*
     * These arrive dressed exactly like "no record for this VIN", and the
     * difference decides whether anybody finds out. Classified `empty`, an
     * expired key would quietly refund every buyer and alert nobody — the
     * product would look unpopular while it was in fact dead. Classified
     * `failed` it throws, which refunds AND pages an admin.
     */
    const cases = [
      { success: false, error: 'Invalid API key' },
      { success: false, error: 'You are not subscribed to this endpoint' },
      { success: false, message: 'Insufficient credits remaining on your plan' },
    ];
    for (const data of cases) {
      const { client: c } = client([{ status: 200, data }]);
      const result = await c.history(VIN);
      expect(result.status).toBe('failed');
    }
  });

  it('calls a 401 failed without inspecting anything else', async () => {
    const { client: c, sent } = client([{ status: 401, data: { success: false } }]);
    await expect(c.history(VIN)).resolves.toEqual({
      status: 'failed',
      reason: 'credentials:401',
    });
    expect(sent).toHaveLength(1);
  });

  it('calls a 200 that is not an object failed', async () => {
    // An edge proxy answering with HTML, not the API answering about a car.
    const { client: c } = client([{ status: 200, data: '<html>502 Bad Gateway</html>' }]);
    await expect(c.specs(VIN)).resolves.toEqual({ status: 'failed', reason: 'non_object_body' });
  });
});

describe('CarsxeClient — what is retried, and what is not', () => {
  it('NEVER retries a 4xx', async () => {
    /*
     * A 4xx is an ANSWER — malformed VIN, endpoint not on the plan, no record.
     * Repeating it spends another lookup to be told the same thing, and on
     * `/history` that is $4.99 for nothing.
     */
    const { client: c, sent } = client([{ status: 400, data: { error: 'invalid vin' } }]);
    await expect(c.history(VIN)).resolves.toEqual({ status: 'failed', reason: 'http_400' });
    expect(sent).toHaveLength(1);
  });

  it('retries a 5xx that really is a server error, then gives up', async () => {
    const { client: c, sent } = client([{ status: 502, data: { error: 'bad gateway' } }]);
    await expect(c.specs(VIN)).resolves.toEqual({ status: 'failed', reason: 'http_502' });
    // Two extra attempts on a cheap endpoint.
    expect(sent).toHaveLength(3);
  });

  it('retries a timeout', async () => {
    const { client: c, sent } = client([{ throws: timeoutError() }]);
    const result = await c.specs(VIN);
    expect(result).toEqual({ status: 'failed', reason: 'transport:ECONNABORTED' });
    expect(sent).toHaveLength(3);
  });

  it('retries the expensive endpoint ONCE, not twice', async () => {
    // A timeout may mean the lookup completed upstream and was billed. Each
    // further attempt risks paying twice for one report.
    const { client: c, sent } = client([{ throws: timeoutError() }]);
    await c.history(VIN);
    expect(sent).toHaveLength(2);
  });

  it('succeeds on the retry and returns the good body', async () => {
    const { client: c, sent } = client([
      { status: 503, data: {} },
      { status: 200, data: { success: true, attributes: { make: 'BMW' } } },
    ]);
    const result = await c.specs(VIN);

    expect(result).toEqual({ status: 'ok', body: { success: true, attributes: { make: 'BMW' } } });
    expect(sent).toHaveLength(2);
  });

  it('never rejects, whatever happens', async () => {
    // Five of these are fanned out with Promise.allSettled and a rejection here
    // would take four healthy sections down with one dead endpoint.
    const boom = new Error('socket hang up') as AxiosError;
    boom.code = 'ECONNRESET';
    const { client: c } = client([{ throws: boom }]);
    await expect(c.marketValue(VIN)).resolves.toEqual({
      status: 'failed',
      reason: 'transport:ECONNRESET',
    });
  });
});

describe('CarsxeClient — secrets and bodies stay out of the logs', () => {
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
          error: `Rate limit exceeded for key ${API_KEY}`,
          currentTitleInformation: { titleNumber: 'CA9911223344' },
        },
      },
    ]);
    await c.history(VIN);

    const log = written.join('\n');
    expect(log).not.toContain(API_KEY);
    expect(log).not.toContain('CA9911223344');
  });
});
