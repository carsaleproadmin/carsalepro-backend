import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';

/**
 * A thin typed client over the CarAPI REST API (https://api.carapi.dev/v1).
 *
 * It does four things and nothing else: it sends the key, it paces the calls, it
 * decides what to retry, and it turns every possible outcome into one of three
 * answers. All the meaning lives in `carapi.mapper.ts`, which is pure and
 * testable because this file keeps the network out of it.
 *
 * THE THREE ANSWERS ARE NOT INTERCHANGEABLE (same contract as the CarsXE
 * client, deliberately — a second provider that classified outcomes differently
 * would make the coverage map mean two things):
 *
 * - `ok`     — the source answered about this car.
 * - `empty`  — the source answered and holds nothing for this car. A normal
 *              outcome, not an incident.
 * - `failed` — we never got an answer. The section is `unavailable`, not empty,
 *              because printing "not stolen" for a register that did not respond
 *              is a false clean bill of health.
 *
 * AUTH IS A QUERY PARAMETER, NOT A HEADER. `?token=<key>` — confirmed against
 * the live API. An `Authorization: Bearer` header is ignored and the call is
 * refused. It goes in `params` so the key is never part of a URL string this
 * process could log.
 *
 * EVERY ENDPOINT BUT ONE COSTS A CREDIT, INCLUDING ITS FAILURES. A 400, a 404
 * and a 503 are each billed exactly like a full answer. That is why retries are
 * narrow (timeout and 5xx only, never a 4xx) and why nothing here fans out.
 * `/account` is the sole free call.
 *
 * ⚠️ `GET /photos/{vin}` IS DELIBERATELY NOT IMPLEMENTED — see the note at the
 * foot of the endpoint table.
 */

export const CARAPI_BASE_URL = 'https://api.carapi.dev/v1';

/** Which dataset a call is for. */
export type CarapiEndpointId =
  | 'vinDecode'
  | 'mileageHistory'
  | 'stolenCheck'
  | 'inspection'
  | 'valuation'
  | 'timeToSell'
  | 'account';

/**
 * The only two countries the inspection endpoint serves.
 *
 * Asking it about anything else is a credit spent to be told no. Typed rather
 * than a bare string so a caller cannot pass 'DE' and pay for the lesson.
 */
export type CarapiInspectionCountry = 'CZ' | 'SK';

export type CarapiCallResult<T> =
  | { status: 'ok'; body: T }
  | { status: 'empty'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * A call result, or the fourth case the client itself never produces: a call the
 * caller decided not to make. Kept apart from `empty` because a section nobody
 * queried is `not_covered` and a section that came back empty is `covered`.
 */
export type CarapiSection<T> = CarapiCallResult<T> | { status: 'skipped'; reason: string };

// ---------------------------------------------------------------------------
// Raw response shapes
// ---------------------------------------------------------------------------

/*
 * ✅ THESE SHAPES WERE CAPTURED FROM THE LIVE API on 2026-08-12 and are stored
 * verbatim in `test/fixtures/carapi/`. That is the opposite situation to the
 * CarsXE client next door, whose shapes are hand-authored from prose docs.
 *
 * They are still typed as `unknown` per field. Not because the key names are in
 * doubt, but because the mapper must degrade one field rather than throw if the
 * provider renames or re-types something later, and `unknown` is what forces
 * every read through a checked reader instead of a cast.
 */

export interface CarapiEnvelope {
  [key: string]: unknown;
}

/** `GET /vin-decode/{vin}` — 10 specification fields plus ~50 features. */
export interface CarapiVinDecodeResponse extends CarapiEnvelope {
  vin?: unknown;
  specifications?: unknown;
  /** ⚠️ The BUILD manufacturer — never where the car is registered. */
  manufacturer?: unknown;
  features?: unknown;
  plateNumber?: unknown;
}

/** `GET /mileage-history/{vin}` — readings newest first, no unit field. */
export interface CarapiMileageHistoryResponse extends CarapiEnvelope {
  vin?: unknown;
  totalRecords?: unknown;
  mileageHistory?: unknown;
}

/** `GET /stolen-check/{vin}` — a boolean plus the per-country register map. */
export interface CarapiStolenCheckResponse extends CarapiEnvelope {
  vin?: unknown;
  stolen?: unknown;
  /** ⚠️ Which registers were searched. The boolean alone has no scope. */
  countries?: unknown;
}

/** `GET /inspection/{vin}?country=CZ|SK` — validity dates, never pass/fail. */
export interface CarapiInspectionResponse extends CarapiEnvelope {
  vin?: unknown;
  country?: unknown;
  inspection?: unknown;
}

/** `GET /vehicle-valuation?make&model&year&country` — one scalar price. */
export interface CarapiValuationResponse extends CarapiEnvelope {
  make?: unknown;
  model?: unknown;
  year?: unknown;
  valuationPrice?: unknown;
  currency?: unknown;
  country?: unknown;
}

/** `GET /time-to-sell?make&model&country` — median days plus the quartiles. */
export interface CarapiTimeToSellResponse extends CarapiEnvelope {
  make?: unknown;
  model?: unknown;
  country?: unknown;
  medianDaysToSell?: unknown;
  p25Days?: unknown;
  p75Days?: unknown;
}

/**
 * `GET /account` — the free one, reporting the remaining balance.
 *
 * ⚠️ UNVERIFIED, and the only shape in this file that is. No response was
 * captured: the fixtures were taken with seven credits left and reserved, and
 * capturing this one would have proved nothing about the paid endpoints. The
 * key names below are therefore a guess, which is exactly why
 * `carapiRemainingCredits` probes several spellings and answers `null` rather
 * than `0` when it recognises none of them — `null`-is-not-`0` applies hardest
 * to a number that decides whether we may attempt a paid lookup at all.
 */
export interface CarapiAccountResponse extends CarapiEnvelope {
  credits?: unknown;
  remainingCredits?: unknown;
  creditsRemaining?: unknown;
  balance?: unknown;
}

/** Everything one bundle of lookups produced, in the shape the mapper consumes. */
export interface CarapiRawBundle {
  vinDecode: CarapiSection<CarapiVinDecodeResponse>;
  mileageHistory: CarapiSection<CarapiMileageHistoryResponse>;
  stolenCheck: CarapiSection<CarapiStolenCheckResponse>;
  inspection: CarapiSection<CarapiInspectionResponse>;
  valuation: CarapiSection<CarapiValuationResponse>;
  timeToSell: CarapiSection<CarapiTimeToSellResponse>;
  /** What was ASKED, so the mapper can label an answer that omits its own scope. */
  request: {
    inspectionCountry: CarapiInspectionCountry | null;
    marketCountry: string | null;
  };
}

/** What a caller wants looked up beyond the three VIN-keyed endpoints. */
export interface CarapiBundleRequest {
  /** Which technical-inspection register to query. Omit to skip the call. */
  inspectionCountry?: CarapiInspectionCountry | null;
  /**
   * The market the valuation and time-to-sell figures are for — the buyer's
   * country, not the car's. Omit to skip both calls.
   */
  marketCountry?: string | null;
  /** Overrides for the decode-derived query terms, when the caller knows better. */
  make?: string | null;
  model?: string | null;
  year?: number | null;
}

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

interface CarapiEndpointSpec {
  /** Built per call: four of the seven put the VIN in the PATH. */
  path: (vin: string) => string;
  timeoutMs: number;
  /** Extra attempts after the first. */
  retries: number;
  /** The provider's own name for the dataset, printed on the report. */
  dataset: string;
  /** False for `/account` alone — every other call is billed, answer or not. */
  billable: boolean;
}

/*
 * ONE RETRY ON EVERY BILLABLE ENDPOINT, never two.
 *
 * A timeout may mean the lookup completed upstream and was billed, so each
 * further attempt risks paying twice for one section. CarsXE gives its cheap
 * endpoints two retries because only its `/history` call is expensive; here
 * every call costs the same single credit, so they all get the expensive
 * endpoint's budget. `/account` is free and gets two.
 */
const ENDPOINTS: Record<CarapiEndpointId, CarapiEndpointSpec> = {
  vinDecode: {
    path: (vin) => `/vin-decode/${encodeURIComponent(vin)}`,
    timeoutMs: 15_000,
    retries: 1,
    dataset: 'CarAPI VIN Decode',
    billable: true,
  },
  mileageHistory: {
    path: (vin) => `/mileage-history/${encodeURIComponent(vin)}`,
    timeoutMs: 15_000,
    retries: 1,
    dataset: 'CarAPI Mileage History',
    billable: true,
  },
  stolenCheck: {
    path: (vin) => `/stolen-check/${encodeURIComponent(vin)}`,
    timeoutMs: 10_000,
    retries: 1,
    dataset: 'CarAPI Stolen Check',
    billable: true,
  },
  inspection: {
    path: (vin) => `/inspection/${encodeURIComponent(vin)}`,
    timeoutMs: 10_000,
    retries: 1,
    dataset: 'CarAPI Technical Inspection',
    billable: true,
  },
  valuation: {
    path: () => '/vehicle-valuation',
    timeoutMs: 10_000,
    retries: 1,
    dataset: 'CarAPI Vehicle Valuation',
    billable: true,
  },
  timeToSell: {
    path: () => '/time-to-sell',
    timeoutMs: 10_000,
    retries: 1,
    dataset: 'CarAPI Time to Sell',
    billable: true,
  },
  account: {
    path: () => '/account',
    timeoutMs: 8_000,
    retries: 2,
    dataset: 'CarAPI Account',
    billable: false,
  },
};

/*
 * ⚠️ `GET /photos/{vin}` IS NOT AND MUST NOT BE IMPLEMENTED.
 *
 * Every URL in that response embeds OUR API KEY as its `token` query parameter.
 * Storing one puts a live credential in the database; rendering one puts it in a
 * paid PDF, in the browser's history and in any referrer header the image
 * triggers. This project has no image proxy to strip it behind, and adding a
 * table full of self-authenticating URLs is not a photo feature, it is a key
 * leak with pictures on it. Adding the endpoint means building the proxy first.
 */

export function carapiDataset(id: CarapiEndpointId): string {
  return ENDPOINTS[id].dataset;
}

const RETRY_BACKOFF_MS = 400;

/**
 * The published rate limit: 10 requests a minute, per key.
 *
 * A bundle is six calls. Fired at once they arrive inside the same tick and the
 * burst refuses itself — and every refusal that got as far as the meter is a
 * credit gone. So the calls are SEQUENCED, and this pacer is the belt to that
 * pair of braces: it spaces requests so a second unlock running beside the first
 * waits for a slot instead of being told no.
 *
 * It is per PROCESS, not per key. Two web dynos with the same key can still
 * overrun it between them, which is why a 429 is still handled as a terminal
 * answer below rather than treated as impossible.
 */
const RATE_LIMIT_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Wording that means the KEY or the PLAN is the problem, not the car.
 *
 * These can arrive with an ordinary-looking status, and the difference is the
 * whole ballgame: an exhausted key classified as `empty` would quietly refund
 * every buyer and alert nobody, so the product would look merely unpopular while
 * it was in fact broken. Classified `failed` it throws, which refunds AND pages
 * an admin.
 *
 * No trailing \b, deliberately — 'credit' has to match 'credits'.
 */
const CREDENTIAL_FAILURE =
  /api[\s_-]?key|\btoken\b|unauthor|forbidden|not\s+subscrib|subscription|credit|quota|\bplan\b|billing|payment/i;

/**
 * ⚠️ `400 {"error":"Invalid VIN: VIN is invalid."}` MEANS ONE OF TWO THINGS AND
 * THE RESPONSE DOES NOT SAY WHICH.
 *
 * Observed against `WVWZZZ1KZAW123456`, a syntactically valid VW VIN. It may
 * mean the string failed the provider's own check-digit validation, or it may
 * mean the provider simply holds no record for it and reports that as an invalid
 * input. We cannot tell from the outside, and it costs a credit either way.
 *
 * It is classified `empty`, not `failed`, because both readings lead to the same
 * place: there is nothing here to fetch, retrying changes nothing, and the buyer
 * gets refunded rather than an admin getting paged. Calling it `failed` would
 * page someone every time a European VIN missed.
 */
const INVALID_VIN_ANSWER = /invalid\s+vin/i;

/**
 * The provider's wording for "we looked and hold nothing", seen on the
 * valuation miss: coverage there is per MODEL, not merely per country.
 */
const NOTHING_HELD = /not\s+found|no\s+(record|data|match|results?)/i;

/** The 429 body's own machine-readable code. */
const RATE_LIMITED_CODE = /rate[_\s-]?limit/i;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

@Injectable()
export class CarapiClient {
  private readonly logger = new Logger(CarapiClient.name);
  private readonly apiKey: string;
  /** Timestamps of the requests already sent inside the rolling window. */
  private readonly recentCalls: number[] = [];

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
    private readonly baseUrl: string = CARAPI_BASE_URL,
  ) {
    this.apiKey = config.get('vinHistory', { infer: true }).carapiKey;
  }

  /** Overridden in tests so a retry or a pacing wait does not really wait. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Overridden in tests so the rate-limit window can be driven by hand. */
  now: () => number = () => Date.now();

  /** No key, no calls. Mirrors `StripeService.configured`. */
  get configured(): boolean {
    return this.apiKey !== '';
  }

  vinDecode(vin: string): Promise<CarapiCallResult<CarapiVinDecodeResponse>> {
    return this.call<CarapiVinDecodeResponse>('vinDecode', vin);
  }

  mileageHistory(vin: string): Promise<CarapiCallResult<CarapiMileageHistoryResponse>> {
    return this.call<CarapiMileageHistoryResponse>('mileageHistory', vin);
  }

  stolenCheck(vin: string): Promise<CarapiCallResult<CarapiStolenCheckResponse>> {
    return this.call<CarapiStolenCheckResponse>('stolenCheck', vin);
  }

  inspection(
    vin: string,
    country: CarapiInspectionCountry,
  ): Promise<CarapiCallResult<CarapiInspectionResponse>> {
    return this.call<CarapiInspectionResponse>('inspection', vin, { country });
  }

  valuation(query: {
    make: string;
    model: string;
    year: number;
    country: string;
  }): Promise<CarapiCallResult<CarapiValuationResponse>> {
    return this.call<CarapiValuationResponse>('valuation', '', query);
  }

  timeToSell(query: {
    make: string;
    model: string;
    country: string;
  }): Promise<CarapiCallResult<CarapiTimeToSellResponse>> {
    return this.call<CarapiTimeToSellResponse>('timeToSell', '', query);
  }

  /** The only free call. Used to read the remaining balance, never for a VIN. */
  account(): Promise<CarapiCallResult<CarapiAccountResponse>> {
    return this.call<CarapiAccountResponse>('account', '');
  }

  /**
   * Everything one report needs, IN SEQUENCE.
   *
   * Never `Promise.all`. Six simultaneous requests trip the 10-a-minute limit
   * against themselves, and a refused request is still a spent credit. Awaiting
   * them one at a time also means a decode that comes back `empty` — the "invalid
   * VIN" answer above — stops the bundle before five more credits are spent on a
   * car this source has never heard of.
   */
  async bundle(vin: string, request: CarapiBundleRequest = {}): Promise<CarapiRawBundle> {
    const inspectionCountry = request.inspectionCountry ?? null;
    const marketCountry = request.marketCountry ?? null;
    const requested = { inspectionCountry, marketCountry };

    const vinDecode = await this.vinDecode(vin);

    // The decode is the cheapest possible proof that this VIN exists here. If it
    // holds nothing, the other five endpoints hold nothing either, and five more
    // credits would buy five more of the same answer.
    if (vinDecode.status === 'empty') {
      const skipped = { status: 'skipped', reason: 'vin_not_in_provider_database' } as const;
      return {
        vinDecode,
        mileageHistory: skipped,
        stolenCheck: skipped,
        inspection: skipped,
        valuation: skipped,
        timeToSell: skipped,
        request: requested,
      };
    }

    const mileageHistory = await this.mileageHistory(vin);
    const stolenCheck = await this.stolenCheck(vin);

    const inspection: CarapiSection<CarapiInspectionResponse> = inspectionCountry
      ? await this.inspection(vin, inspectionCountry)
      : { status: 'skipped', reason: 'no_inspection_country_requested' };

    /*
     * The valuation and time-to-sell endpoints are keyed by make/model/year, not
     * by VIN, so their query has to be built from the decode. Observed working
     * form is lower case ('bmw', 'x6').
     */
    const query = this.queryTerms(vinDecode, request);

    let valuation: CarapiSection<CarapiValuationResponse> = {
      status: 'skipped',
      reason: 'no_market_country_requested',
    };
    let timeToSell: CarapiSection<CarapiTimeToSellResponse> = {
      status: 'skipped',
      reason: 'no_market_country_requested',
    };

    if (marketCountry !== null && query.make !== null && query.model !== null) {
      valuation =
        query.year !== null
          ? await this.valuation({
              make: query.make,
              model: query.model,
              year: query.year,
              country: marketCountry,
            })
          : // The endpoint requires a year and the decode carries none we trust.
            { status: 'skipped', reason: 'no_year_for_valuation' };

      timeToSell = await this.timeToSell({
        make: query.make,
        model: query.model,
        country: marketCountry,
      });
    }

    return { vinDecode, mileageHistory, stolenCheck, inspection, valuation, timeToSell, request: requested };
  }

  /**
   * The three scalars the model-keyed endpoints need, read off the decode.
   *
   * ⚠️ `year` IS THE REGISTRATION YEAR, NOT A MODEL YEAR. CarAPI publishes no
   * model year at all; `specifications.registrationDate` is the only year in the
   * response. It is close enough to look a valuation up with — a car is normally
   * registered in or near its model year — and it is deliberately used ONLY as a
   * query parameter here. It never reaches the payload as `vehicle.modelYear`,
   * where it would be a fact we invented.
   */
  private queryTerms(
    decode: CarapiCallResult<CarapiVinDecodeResponse>,
    request: CarapiBundleRequest,
  ): { make: string | null; model: string | null; year: number | null } {
    const specs =
      decode.status === 'ok' && isRecord(decode.body.specifications)
        ? decode.body.specifications
        : null;

    const term = (value: unknown): string | null => {
      if (typeof value !== 'string' || value.trim() === '') return null;
      return value.trim().toLowerCase();
    };

    const registrationYear = (): number | null => {
      const raw = specs?.registrationDate;
      if (typeof raw !== 'string') return null;
      const year = Number.parseInt(raw.slice(0, 4), 10);
      return Number.isFinite(year) && year > 1900 ? year : null;
    };

    return {
      make: term(request.make) ?? term(specs?.make),
      model: term(request.model) ?? term(specs?.model),
      year: request.year ?? registrationYear(),
    };
  }

  /**
   * One endpoint, with its own timeout and its own retry budget.
   *
   * Never rejects. A thrown promise here would take the rest of the bundle down
   * because one endpoint was unreachable, and the buyer would lose the sections
   * that did answer.
   */
  private async call<T>(
    id: CarapiEndpointId,
    vin: string,
    params: Record<string, string | number> = {},
  ): Promise<CarapiCallResult<T>> {
    if (!this.configured) {
      return { status: 'failed', reason: 'carapi_api_key_not_configured' };
    }

    const spec = ENDPOINTS[id];
    let lastReason = 'no_attempt_made';

    for (let attempt = 0; attempt <= spec.retries; attempt += 1) {
      await this.takeRateLimitSlot();
      const outcome = await this.attempt<T>(spec, vin, params);
      if (outcome.kind === 'terminal') return outcome.result;

      lastReason = outcome.reason;
      if (attempt < spec.retries) {
        this.logger.warn(
          `CarAPI ${id} for ${vin} failed (${lastReason}) — retry ${attempt + 1}/${spec.retries}`,
        );
        await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }

    this.logger.error(`CarAPI ${id} for ${vin} gave up after retries: ${lastReason}`);
    return { status: 'failed', reason: lastReason };
  }

  /**
   * Hold a slot in the rolling minute, waiting for one if the window is full.
   *
   * One sleep, never a loop: a pacer that could spin is worse than a 429, which
   * is at least an answer. If the wait was not enough the request goes out
   * anyway and `classify` deals with the refusal.
   */
  private async takeRateLimitSlot(): Promise<void> {
    this.pruneRateLimitWindow();
    if (this.recentCalls.length >= RATE_LIMIT_PER_WINDOW) {
      const waitMs = this.recentCalls[0] + RATE_LIMIT_WINDOW_MS - this.now();
      if (waitMs > 0) {
        this.logger.warn(`CarAPI rate-limit pacing: waiting ${waitMs} ms for a slot`);
        await this.sleep(waitMs);
      }
      this.pruneRateLimitWindow();
    }
    this.recentCalls.push(this.now());
  }

  private pruneRateLimitWindow(): void {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    while (this.recentCalls.length > 0 && this.recentCalls[0] <= cutoff) {
      this.recentCalls.shift();
    }
  }

  /** A single request, classified. `retryable` means transport, never an answer. */
  private async attempt<T>(
    spec: CarapiEndpointSpec,
    vin: string,
    params: Record<string, string | number>,
  ): Promise<{ kind: 'terminal'; result: CarapiCallResult<T> } | { kind: 'retryable'; reason: string }> {
    let response: AxiosResponse<unknown>;
    try {
      response = await firstValueFrom(
        this.http.get<unknown>(`${this.baseUrl}${spec.path(vin)}`, {
          // ⚠️ The key is a QUERY PARAMETER for this provider, not a header. As
          // params rather than in the URL string, so it never appears in a URL
          // this process could log or an interceptor could record.
          params: { ...params, token: this.apiKey },
          timeout: spec.timeoutMs,
          // Every status comes back as a response rather than a rejection, so
          // the body can be read before the status is judged. A 400 here carries
          // the sentence that decides whether this is an empty answer or a
          // broken request, and axios would otherwise hide it inside an error.
          validateStatus: () => true,
        }),
      );
    } catch (err) {
      // Only transport reaches here: a timeout, a reset, a DNS failure. None of
      // them is an answer, and a request that never arrived was not billed.
      const axiosError = err as AxiosError;
      return { kind: 'retryable', reason: `transport:${axiosError.code ?? 'unknown'}` };
    }

    return this.classify<T>(response, spec, vin);
  }

  private classify<T>(
    response: AxiosResponse<unknown>,
    spec: CarapiEndpointSpec,
    vin: string,
  ): { kind: 'terminal'; result: CarapiCallResult<T> } | { kind: 'retryable'; reason: string } {
    const { status, data } = response;
    const body = isRecord(data) ? data : null;
    const errorText = this.redact(readErrorText(body));
    const code = typeof body?.code === 'string' ? body.code : '';

    // 1. Rate limiting first, because its message mentions a limit and would
    //    otherwise read as a billing refusal below. TERMINAL, not retried: it is
    //    a 4xx, and the answer to it is the pacer, not another request.
    if (status === 429 || RATE_LIMITED_CODE.test(code)) {
      this.logger.error(`CarAPI ${spec.path(vin)} was rate limited (HTTP ${status})`);
      return { kind: 'terminal', result: { status: 'failed', reason: 'rate_limited' } };
    }

    // 2. Credentials and billing, which arrive dressed as a negative answer
    //    about the car and are nothing of the sort.
    if (status === 401 || status === 403 || (errorText !== '' && CREDENTIAL_FAILURE.test(errorText))) {
      this.logger.error(`CarAPI ${spec.path(vin)} refused the credentials (HTTP ${status})`);
      return { kind: 'terminal', result: { status: 'failed', reason: `credentials:${status}` } };
    }

    // 3. ⚠️ "Invalid VIN" is an EMPTY answer, not a failure. See
    //    INVALID_VIN_ANSWER: it may mean malformed or it may mean "not in our
    //    database", and there is nothing to fetch either way.
    if (errorText !== '' && INVALID_VIN_ANSWER.test(errorText)) {
      return { kind: 'terminal', result: { status: 'empty', reason: 'invalid_vin' } };
    }

    // 4. "Not found for this make, model and year" — the source answered and
    //    holds nothing. Also a finding, also not a failure.
    if (status === 404 || (errorText !== '' && NOTHING_HELD.test(errorText))) {
      return {
        kind: 'terminal',
        result: { status: 'empty', reason: errorText === '' ? 'http_404' : errorText.slice(0, 200) },
      };
    }

    // 5. Only now is a 5xx a real server error, and the only status worth
    //    spending another credit on.
    if (status >= 500) return { kind: 'retryable', reason: `http_${status}` };

    // 6. Any other 4xx is an answer we do not like. Never retried — repeating it
    //    spends a credit to be told the same thing.
    if (status >= 400) {
      return { kind: 'terminal', result: { status: 'failed', reason: `http_${status}` } };
    }

    if (!body) {
      // 200 with HTML or a bare string: an edge proxy, not the API.
      this.logger.error(`CarAPI ${spec.path(vin)} returned a non-object body (HTTP ${status})`);
      return { kind: 'terminal', result: { status: 'failed', reason: 'non_object_body' } };
    }

    // A 2xx that carries only an error sentence we did not recognise. Trusting
    // the status here would hand the mapper an error object to read as a car.
    if (errorText !== '') {
      return { kind: 'terminal', result: { status: 'failed', reason: errorText.slice(0, 200) } };
    }

    return { kind: 'terminal', result: { status: 'ok', body: body as T } };
  }

  /** Belt and braces: the key must never reach a log line, from any direction. */
  private redact(text: string): string {
    if (this.apiKey === '' || text === '') return text;
    return text.split(this.apiKey).join('***');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The provider's own words for what went wrong, from whichever key it used.
 *
 * Only ever the error field — never the whole body, which is the paid artefact
 * and has no business in a log file.
 */
function readErrorText(body: Record<string, unknown> | null): string {
  if (!body) return '';
  for (const key of ['error', 'message', 'error_message', 'errorMessage', 'detail', 'reason']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (isRecord(value) && typeof value.message === 'string') return value.message.trim();
  }
  return '';
}

/**
 * Credits left on the key, from the free `/account` call.
 *
 * ⚠️ The key names are UNVERIFIED — see `CarapiAccountResponse`. `null` means
 * "this response did not tell us", which is not "no credits left": a caller that
 * read the second from the first would stop attempting lookups the key can
 * perfectly well afford, or attempt ones it cannot.
 */
export function carapiRemainingCredits(body: CarapiAccountResponse | null | undefined): number | null {
  if (!isRecord(body)) return null;
  for (const key of ['remainingCredits', 'creditsRemaining', 'credits', 'creditsLeft', 'remaining', 'available', 'balance', 'quota']) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    // `{ credits: { remaining: 7 } }` is as likely a shape as the flat one.
    if (isRecord(value)) {
      const nested = carapiRemainingCredits(value as CarapiAccountResponse);
      if (nested !== null) return nested;
    }
  }
  return null;
}
