import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';

/**
 * A thin typed client over the CarsXE REST API.
 *
 * It does three things and nothing else: it sends the key, it decides what to
 * retry, and it turns every possible outcome into one of three answers. All the
 * meaning lives in `carsxe.mapper.ts`, which is pure and testable because this
 * file keeps the network out of it.
 *
 * THE THREE ANSWERS ARE NOT INTERCHANGEABLE.
 *
 * - `ok`     — the source answered about this car.
 * - `empty`  — the source answered and holds nothing for this car. A normal
 *              outcome, not an incident: `VinHistoryService` detects it through
 *              `MIN_SELLABLE_RECORD_COUNT` and refunds the buyer without paging
 *              anyone.
 * - `failed` — we never got an answer. The section is `unavailable`, not empty,
 *              because printing "no theft records" for a database that did not
 *              respond is a false clean bill of health.
 *
 * RETRIES COST MONEY, SO THEY ARE NARROW. A timeout or a 5xx is retried; a 4xx
 * never is. A 4xx is an ANSWER — the VIN is malformed, the plan does not include
 * this endpoint, the record does not exist — and repeating the request spends
 * another lookup to be told the same thing. `/history` is $4.99 a call.
 */

export const CARSXE_BASE_URL = 'https://api.carsxe.com';

/** Which of the five datasets a call is for. */
export type CarsxeEndpointId = 'history' | 'specs' | 'marketvalue' | 'recalls' | 'lienTheft';

export type CarsxeCallResult<T> =
  | { status: 'ok'; body: T }
  | { status: 'empty'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * A call result, or the fourth case the client itself never produces: a call the
 * caller decided not to make. Kept apart from `empty` because a section nobody
 * queried is `not_covered` and a section that came back empty is `covered`.
 */
export type CarsxeSection<T> = CarsxeCallResult<T> | { status: 'skipped'; reason: string };

// ---------------------------------------------------------------------------
// Raw response shapes
// ---------------------------------------------------------------------------

/*
 * ⚠️ THESE SHAPES ARE HAND-AUTHORED FROM THE PUBLISHED SCHEMA AND ARE NOT
 * VERIFIED AGAINST A CAPTURED RESPONSE. The account is on a Sandbox tier with a
 * single lifetime `/history` call, which is deliberately unspent.
 *
 * Every field is therefore optional and most are `unknown`: the mapper probes
 * for several spellings of each key and never assumes one is present. A renamed
 * key must degrade one field, never throw — and the type system is not the thing
 * standing between us and that, the mapper's readers are.
 */

/** Everything CarsXE returns carries this envelope. */
export interface CarsxeEnvelope {
  /** ⚠️ Authoritative — some v1 endpoints report a validation error as HTTP 500. */
  success?: boolean;
  [key: string]: unknown;
}

export interface CarsxeHistoryResponse extends CarsxeEnvelope {
  input?: unknown;
  junkAndSalvageInformation?: unknown;
  insuranceInformation?: unknown;
  /** ⚠️ The provider's WHOLE brand dictionary, identical for every VIN. */
  brandsInformation?: unknown;
  currentTitleInformation?: unknown;
  historyInformation?: unknown;
  vinChanged?: unknown;
  events?: unknown;
}

export interface CarsxeSpecsResponse extends CarsxeEnvelope {
  attributes?: unknown;
  equipment?: unknown;
  colors?: unknown;
  warranties?: unknown;
}

export interface CarsxeMarketValueResponse extends CarsxeEnvelope {
  market_value?: unknown;
  marketValue?: unknown;
}

export interface CarsxeRecallsResponse extends CarsxeEnvelope {
  recalls?: unknown;
}

export interface CarsxeLienTheftResponse extends CarsxeEnvelope {
  events?: unknown;
}

/** Everything one billable lookup produced, in the shape the mapper consumes. */
export interface CarsxeRawBundle {
  history: CarsxeSection<CarsxeHistoryResponse>;
  specs: CarsxeSection<CarsxeSpecsResponse>;
  marketValue: CarsxeSection<CarsxeMarketValueResponse>;
  recalls: CarsxeSection<CarsxeRecallsResponse>;
  lienTheft: CarsxeSection<CarsxeLienTheftResponse>;
}

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

interface CarsxeEndpointSpec {
  path: string;
  timeoutMs: number;
  /** Extra attempts after the first. */
  retries: number;
  /** The provider's own name for the dataset, printed on the report. */
  dataset: string;
}

const ENDPOINTS: Record<CarsxeEndpointId, CarsxeEndpointSpec> = {
  /*
   * The expensive one. It aggregates several state registries, so it is the
   * slowest as well, and it gets exactly ONE retry — a timeout may mean the
   * lookup completed upstream and was billed, so each further attempt risks
   * paying twice for one report.
   */
  history: { path: '/history', timeoutMs: 30_000, retries: 1, dataset: 'NMVTIS' },
  specs: { path: '/specs', timeoutMs: 10_000, retries: 2, dataset: 'CarsXE Vehicle Specifications' },
  marketvalue: { path: '/marketvalue', timeoutMs: 10_000, retries: 2, dataset: 'CarsXE Market Value' },
  recalls: { path: '/v1/recalls', timeoutMs: 10_000, retries: 2, dataset: 'NHTSA' },
  lienTheft: { path: '/v1/lien-theft', timeoutMs: 10_000, retries: 2, dataset: 'CarsXE Lien & Theft' },
};

export function carsxeDataset(id: CarsxeEndpointId): string {
  return ENDPOINTS[id].dataset;
}

const RETRY_BACKOFF_MS = 400;

/**
 * Wording that means the KEY or the PLAN is the problem, not the car.
 *
 * These arrive as `success: false` like a genuine "no record" does, and the
 * difference is the whole ballgame: an expired key classified as `empty` would
 * quietly refund every buyer and alert nobody, so the product would look merely
 * unpopular while it was in fact broken. Classified as `failed` it throws, which
 * refunds AND pages an admin.
 *
 * No trailing \b, deliberately. Wrapping the alternation in \b(…)\b makes every
 * prefix stop matching — 'not subscrib' would not match 'not subscribed', and
 * 'credit' would not match 'credits'. That is exactly how an out-of-credit
 * account gets classified as "this car has no record", refunding every buyer
 * and alerting nobody.
 */
const CREDENTIAL_FAILURE =
  /api[\s_-]?key|unauthor|forbidden|not\s+subscrib|subscription|credit|quota|rate\s*limit|\bplan\b|billing|payment/i;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

@Injectable()
export class CarsxeClient {
  private readonly logger = new Logger(CarsxeClient.name);
  private readonly apiKey: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
    private readonly baseUrl: string = CARSXE_BASE_URL,
  ) {
    this.apiKey = config.get('vinHistory', { infer: true }).apiKey;
  }

  /** Overridden in tests so a retry does not really wait. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** No key, no calls. Mirrors `StripeService.configured`. */
  get configured(): boolean {
    return this.apiKey !== '';
  }

  history(vin: string): Promise<CarsxeCallResult<CarsxeHistoryResponse>> {
    return this.call<CarsxeHistoryResponse>('history', vin);
  }

  specs(vin: string): Promise<CarsxeCallResult<CarsxeSpecsResponse>> {
    return this.call<CarsxeSpecsResponse>('specs', vin);
  }

  marketValue(vin: string): Promise<CarsxeCallResult<CarsxeMarketValueResponse>> {
    return this.call<CarsxeMarketValueResponse>('marketvalue', vin);
  }

  recalls(vin: string): Promise<CarsxeCallResult<CarsxeRecallsResponse>> {
    return this.call<CarsxeRecallsResponse>('recalls', vin);
  }

  lienTheft(vin: string): Promise<CarsxeCallResult<CarsxeLienTheftResponse>> {
    return this.call<CarsxeLienTheftResponse>('lienTheft', vin);
  }

  /**
   * One endpoint, with its own timeout and its own retry budget.
   *
   * Never rejects. Every caller fans several of these out at once and a thrown
   * promise there would take down four sections because one was unreachable.
   */
  private async call<T>(id: CarsxeEndpointId, vin: string): Promise<CarsxeCallResult<T>> {
    if (!this.configured) {
      return { status: 'failed', reason: 'carsxe_api_key_not_configured' };
    }

    const spec = ENDPOINTS[id];
    let lastReason = 'no_attempt_made';

    for (let attempt = 0; attempt <= spec.retries; attempt += 1) {
      const outcome = await this.attempt<T>(spec, vin);
      if (outcome.kind === 'terminal') return outcome.result;

      lastReason = outcome.reason;
      if (attempt < spec.retries) {
        this.logger.warn(
          `CarsXE ${id} for ${vin} failed (${lastReason}) — retry ${attempt + 1}/${spec.retries}`,
        );
        await this.sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }

    this.logger.error(`CarsXE ${id} for ${vin} gave up after retries: ${lastReason}`);
    return { status: 'failed', reason: lastReason };
  }

  /** A single request, classified. `retryable` means transport, never an answer. */
  private async attempt<T>(
    spec: CarsxeEndpointSpec,
    vin: string,
  ): Promise<{ kind: 'terminal'; result: CarsxeCallResult<T> } | { kind: 'retryable'; reason: string }> {
    let response: AxiosResponse<unknown>;
    try {
      response = await firstValueFrom(
        this.http.get<unknown>(`${this.baseUrl}${spec.path}`, {
          // As params, so the key never appears in a URL we might log or that an
          // interceptor might record.
          params: { key: this.apiKey, vin },
          timeout: spec.timeoutMs,
          // Every status comes back as a response rather than a rejection, which
          // is what makes the legacy quirk below inspectable at all: CarsXE
          // reports validation errors on some v1 endpoints as HTTP 500 with
          // `success: false` in the body, and axios would otherwise hand us an
          // exception carrying a status that means the opposite of what happened.
          validateStatus: () => true,
        }),
      );
    } catch (err) {
      // Only transport reaches here now: a timeout, a reset, a DNS failure.
      // None of them is an answer and none of them was billed, so all retry.
      const axiosError = err as AxiosError;
      return {
        kind: 'retryable',
        reason: `transport:${axiosError.code ?? 'unknown'}`,
      };
    }

    return this.classify<T>(response, spec, vin);
  }

  private classify<T>(
    response: AxiosResponse<unknown>,
    spec: CarsxeEndpointSpec,
    vin: string,
  ): { kind: 'terminal'; result: CarsxeCallResult<T> } | { kind: 'retryable'; reason: string } {
    const { status, data } = response;
    const body = isRecord(data) ? data : null;
    const errorText = this.redact(readErrorText(body));

    // 1. Credentials and billing first, because these arrive dressed as a
    //    negative answer about the car and are nothing of the sort.
    if (status === 401 || status === 403 || (errorText !== '' && CREDENTIAL_FAILURE.test(errorText))) {
      this.logger.error(`CarsXE ${spec.path} refused the credentials (HTTP ${status})`);
      return { kind: 'terminal', result: { status: 'failed', reason: `credentials:${status}` } };
    }

    // 2. ⚠️ The body's `success` flag outranks the HTTP status, always. A
    //    `success: false` under an HTTP 500 is CarsXE telling us there is no
    //    record, in the voice of a server crash. Retrying it burns a lookup.
    if (body?.success === false) {
      return {
        kind: 'terminal',
        result: { status: 'empty', reason: errorText === '' ? 'success_false' : errorText.slice(0, 200) },
      };
    }

    if (status === 404) {
      return { kind: 'terminal', result: { status: 'empty', reason: 'http_404' } };
    }

    // 3. Only now is a 5xx a real server error.
    if (status >= 500) return { kind: 'retryable', reason: `http_${status}` };

    // 4. Any other 4xx is an answer we do not like. Never retried — see the
    //    header comment; repeating it spends money and changes nothing.
    if (status >= 400) {
      return { kind: 'terminal', result: { status: 'failed', reason: `http_${status}` } };
    }

    if (!body) {
      // 200 with HTML or a bare string: an edge proxy, not the API.
      this.logger.error(`CarsXE ${spec.path} for ${vin} returned a non-object body (HTTP ${status})`);
      return { kind: 'terminal', result: { status: 'failed', reason: 'non_object_body' } };
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
 * Only ever the error field — never the whole body, which for `/history` is the
 * paid artefact and has no business in a log file.
 */
function readErrorText(body: Record<string, unknown> | null): string {
  if (!body) return '';
  for (const key of ['error', 'message', 'error_message', 'errorMessage', 'reason', 'status']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (isRecord(value) && typeof value.message === 'string') return value.message.trim();
  }
  return '';
}
