import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { applePrivateKeyFromEnv } from '../../config/configuration';
import { AppleValidator, appleCredentialStatus, classifyAppleReceipt } from './apple-validator';
import { base64url } from './iap-encoding';
import { IapValidationError, PRO_PRODUCT_ID } from './iap.types';

const BUNDLE = 'net.carsalepro.app';
const TX_ID = '2000000123456789';
const PROD = 'https://api.storekit.itunes.apple.com';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function mockHttp(): jest.Mocked<HttpService> {
  return { post: jest.fn(), get: jest.fn() } as unknown as jest.Mocked<HttpService>;
}

function axiosResp<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} as never };
}

function axiosError(status: number, data: unknown = {}): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

/** A compact JWS with an unchecked signature, as StoreKit 2 and Apple's API both send. */
function jws(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', x5c: ['MIIB...'] }));
  return `${header}.${base64url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: TX_ID,
    originalTransactionId: TX_ID,
    bundleId: BUNDLE,
    productId: PRO_PRODUCT_ID,
    type: 'Non-Consumable',
    environment: 'Production',
    purchaseDate: 1_760_000_000_000,
    ...overrides,
  };
}

/** What `GET /inApps/v1/transactions/{id}` answers. */
function serverApiAnswer(overrides: Record<string, unknown> = {}) {
  return of(axiosResp({ signedTransactionInfo: jws(transaction(overrides)) }));
}

const serverApiCreds = {
  issuerId: '57246542-96fe-1a63-e053-0824d011072a',
  keyId: '2X9R4HXF34',
  privateKey: PEM,
};
const noCreds = { issuerId: '', keyId: '', privateKey: '' };

function config(
  apple: Partial<{
    sharedSecret: string;
    issuerId: string;
    keyId: string;
    privateKey: string;
    useSandboxFirst: boolean;
  }>,
) {
  return {
    bundleId: BUNDLE,
    apple: { sharedSecret: '', ...serverApiCreds, useSandboxFirst: false, ...apple },
    google: { packageName: BUNDLE, serviceAccountJson: '', subscriptionProductIds: [] },
    mode: 'server' as const,
  };
}

async function buildValidator(http: HttpService, apple: Parameters<typeof config>[0] = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      AppleValidator,
      { provide: HttpService, useValue: http },
      { provide: ConfigService, useValue: { get: () => config(apple) } },
    ],
  }).compile();
  return mod.get(AppleValidator);
}

async function rejection(promise: Promise<unknown>): Promise<IapValidationError> {
  const err = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IapValidationError);
  return err as IapValidationError;
}

describe('classifyAppleReceipt', () => {
  it('tells a StoreKit 2 JWS, a transaction id and an app receipt apart', () => {
    expect(classifyAppleReceipt(jws(transaction()))).toBe('jws');
    expect(classifyAppleReceipt(TX_ID)).toBe('transaction-id');
    expect(classifyAppleReceipt('MIIT8QYJKoZIhvcNAQcCoIIT4jCCE94CAQEx+/=')).toBe('app-receipt');
  });
});

describe('AppleValidator - StoreKit 2 JWS (App Store Server API)', () => {
  it("accepts a JWS: looks the transaction up and checks Apple's copy", async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(serverApiAnswer());
    const v = await buildValidator(http);

    const res = await v.validate({ platform: 'ios', receipt: jws(transaction()) });

    expect(res).toMatchObject({
      valid: true,
      provider: 'apple-storekit2',
      productId: PRO_PRODUCT_ID,
      transactionId: TX_ID,
      storeTransactionId: TX_ID,
      bundleId: BUNDLE,
      environment: 'Production',
    });
    expect(http.get).toHaveBeenCalledTimes(1);
    const [url, options] = http.get.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${PROD}/inApps/v1/transactions/${TX_ID}`);

    // The bearer token is an ES256 JWT signed with APPLE_PRIVATE_KEY.
    const token = options.headers.Authorization.replace(/^Bearer /, '');
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: serverApiCreds.keyId, typ: 'JWT' });
    expect(claims).toMatchObject({
      iss: serverApiCreds.issuerId,
      aud: 'appstoreconnect-v1',
      bid: BUNDLE,
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig, 'base64url'),
      ),
    ).toBe(true);
  });

  it("refuses the wrong bundle in Apple's answer", async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(serverApiAnswer({ bundleId: 'com.someoneelse.app' }));
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_bundle_mismatch');
    expect(err.unavailable).toBe(false);
  });

  it('refuses a device JWS of another bundle before any network call', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);

    const err = await rejection(
      v.validate({
        platform: 'ios',
        receipt: jws(transaction({ bundleId: 'com.someoneelse.app' })),
      }),
    );
    expect(err.code).toBe('iap_bundle_mismatch');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('refuses the wrong product', async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(serverApiAnswer({ productId: 'some_other_product' }));
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_product_mismatch');
  });

  it('refuses a revoked (refunded) purchase', async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(
      serverApiAnswer({ revocationDate: 1_760_100_000_000, revocationReason: 0 }),
    );
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_purchase_revoked');
  });

  it('falls back to the sandbox on 404 / 4040010 from production', async () => {
    const http = mockHttp();
    http.get
      .mockReturnValueOnce(
        throwError(() =>
          axiosError(404, { errorCode: 4040010, errorMessage: 'Transaction id not found.' }),
        ),
      )
      .mockReturnValueOnce(serverApiAnswer({ environment: 'Sandbox' }));
    const v = await buildValidator(http);

    const res = await v.validate({ platform: 'ios', receipt: jws(transaction()) });

    expect(res.environment).toBe('Sandbox');
    expect(http.get.mock.calls.map((call) => call[0])).toEqual([
      `${PROD}/inApps/v1/transactions/${TX_ID}`,
      `${SANDBOX}/inApps/v1/transactions/${TX_ID}`,
    ]);
  });

  it('asks the sandbox first when the device JWS says Sandbox', async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(serverApiAnswer({ environment: 'Sandbox' }));
    const v = await buildValidator(http);

    await v.validate({ platform: 'ios', receipt: jws(transaction({ environment: 'Sandbox' })) });
    expect(http.get.mock.calls[0][0]).toBe(`${SANDBOX}/inApps/v1/transactions/${TX_ID}`);
  });

  it('refuses a transaction that neither environment knows', async () => {
    const http = mockHttp();
    http.get
      .mockReturnValueOnce(throwError(() => axiosError(404, { errorCode: 4040010 })))
      .mockReturnValueOnce(throwError(() => axiosError(404, { errorCode: 4040010 })));
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_transaction_not_found');
    expect(err.unavailable).toBe(false);
  });

  it('refuses a JWS whose payload names no transaction', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);

    const err = await rejection(
      v.validate({
        platform: 'ios',
        receipt: jws({ bundleId: BUNDLE, productId: PRO_PRODUCT_ID }),
      }),
    );
    expect(err.code).toBe('iap_receipt_malformed');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('is unavailable (not rejected) when Apple refuses our credentials', async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(throwError(() => axiosError(401)));
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_store_auth_failed');
    expect(err.unavailable).toBe(true);
  });

  it.each([
    ['a 503', () => axiosError(503)],
    ['a 429', () => axiosError(429)],
    [
      'a timeout',
      () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }),
    ],
  ])('is unavailable on %s, and does not try the other environment', async (_label, makeErr) => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(throwError(makeErr));
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_store_unavailable');
    expect(err.unavailable).toBe(true);
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('is not configured without the App Store Server API key, even with a shared secret', async () => {
    const http = mockHttp();
    const v = await buildValidator(http, { ...noCreds, sharedSecret: 'secret-xyz' });

    const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
    expect(err.code).toBe('iap_not_configured');
    expect(err.unavailable).toBe(true);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('never logs the JWS', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
    }
    const http = mockHttp();
    http.get.mockReturnValueOnce(throwError(() => axiosError(401)));
    const v = await buildValidator(http);
    const receipt = jws(transaction());

    const err = await rejection(v.validate({ platform: 'ios', receipt }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(receipt.split('.')[1]);
    expect(err.message).not.toContain(receipt.split('.')[1]);
    jest.restoreAllMocks();
  });
});

describe('AppleValidator - bare numeric transaction id', () => {
  // A transaction id is not a secret: it is printed on receipts and e-mails,
  // so anybody who saw one could redeem it.
  it('refuses it with iap_receipt_unsupported and asks Apple nothing', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ platform: 'ios', receipt: TX_ID }));
    expect(err.code).toBe('iap_receipt_unsupported');
    expect(err.unavailable).toBe(false);
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('AppleValidator - error details', () => {
  it('uses originalTransactionId as the purchase id, so a restore maps to the same purchase', async () => {
    const http = mockHttp();
    http.get.mockReturnValueOnce(
      serverApiAnswer({ transactionId: '2000000999', originalTransactionId: TX_ID }),
    );
    const v = await buildValidator(http);

    const res = await v.validate({
      platform: 'ios',
      receipt: jws(transaction({ transactionId: '2000000999' })),
    });
    expect(res.storeTransactionId).toBe(TX_ID);
  });

  it.each([4040002, 4040004, 4040006])(
    'maps the retryable 404 error %d to 503 iap_store_unavailable, without a sandbox fallback',
    async (errorCode) => {
      const http = mockHttp();
      http.get.mockReturnValueOnce(throwError(() => axiosError(404, { errorCode })));
      const v = await buildValidator(http);

      const err = await rejection(v.validate({ platform: 'ios', receipt: jws(transaction()) }));
      expect(err.code).toBe('iap_store_unavailable');
      expect(err.unavailable).toBe(true);
      expect(http.get).toHaveBeenCalledTimes(1);
    },
  );

  it('does not copy an attacker-controlled bundle id into the reason verbatim', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    const hostile = `evil\r\nInjected: line\u202e${'x'.repeat(500)}`;

    const err = await rejection(
      v.validate({ platform: 'ios', receipt: jws(transaction({ bundleId: hostile })) }),
    );
    expect(err.code).toBe('iap_bundle_mismatch');
    expect(err.reason).not.toMatch(/[\r\n\u202e]/);
    expect(err.reason).not.toContain('x'.repeat(65));
  });
});

describe('AppleValidator - StoreKit 1 app receipt (verifyReceipt fallback)', () => {
  const SK1 = 'MIIT8QYJKoZIhvcNAQcCoIIT4jCCE94CAQEx';

  function receiptAnswer(overrides: Record<string, unknown> = {}) {
    return of(
      axiosResp({
        status: 0,
        environment: 'Production',
        receipt: {
          bundle_id: BUNDLE,
          in_app: [
            {
              product_id: PRO_PRODUCT_ID,
              transaction_id: '1000000999000001',
              original_transaction_id: '1000000999000001',
              purchase_date_ms: '1716470000000',
            },
          ],
        },
        ...overrides,
      }),
    );
  }

  it('uses verifyReceipt when APPLE_SHARED_SECRET is set', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(receiptAnswer());
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    const res = await v.validate({ platform: 'ios', receipt: SK1 });
    expect(res).toMatchObject({
      provider: 'apple-verifyreceipt',
      productId: PRO_PRODUCT_ID,
      transactionId: '1000000999000001',
      storeTransactionId: '1000000999000001',
      environment: 'Production',
    });
    expect(http.post.mock.calls[0][0]).toBe('https://buy.itunes.apple.com/verifyReceipt');
    expect(http.post.mock.calls[0][1]).toMatchObject({ password: 'secret-xyz' });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('falls back to the sandbox when production answers 21007', async () => {
    const http = mockHttp();
    http.post
      .mockReturnValueOnce(of(axiosResp({ status: 21007 })))
      .mockReturnValueOnce(receiptAnswer({ environment: 'Sandbox' }));
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    const res = await v.validate({ platform: 'ios', receipt: SK1 });
    expect(res.environment).toBe('Sandbox');
    expect(http.post.mock.calls[1][0]).toBe('https://sandbox.itunes.apple.com/verifyReceipt');
  });

  it('refuses a receipt that holds no PRO transaction', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      receiptAnswer({
        receipt: { bundle_id: BUNDLE, in_app: [{ product_id: 'other', transaction_id: '1' }] },
      }),
    );
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    expect((await rejection(v.validate({ platform: 'ios', receipt: SK1 }))).code).toBe(
      'iap_product_mismatch',
    );
  });

  it('refuses a receipt of another bundle', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      receiptAnswer({ receipt: { bundle_id: 'com.someoneelse.app', in_app: [] } }),
    );
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    expect((await rejection(v.validate({ platform: 'ios', receipt: SK1 }))).code).toBe(
      'iap_bundle_mismatch',
    );
  });

  it('maps an unauthenticated receipt to iap_store_rejected', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(of(axiosResp({ status: 21003 })));
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    const err = await rejection(v.validate({ platform: 'ios', receipt: SK1 }));
    expect(err.code).toBe('iap_store_rejected');
    expect(err.reason).toMatch(/could not be authenticated/);
  });

  it('is unavailable when verifyReceipt cannot be reached', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      throwError(() => new Error('getaddrinfo ENOTFOUND buy.itunes.apple.com')),
    );
    const v = await buildValidator(http, { sharedSecret: 'secret-xyz' });

    const err = await rejection(v.validate({ platform: 'ios', receipt: SK1 }));
    expect(err.code).toBe('iap_store_unavailable');
    expect(err.unavailable).toBe(true);
  });

  it('refuses an app receipt with iap_receipt_unsupported when APPLE_SHARED_SECRET is not set', async () => {
    const http = mockHttp();
    const v = await buildValidator(http, { sharedSecret: '' });

    const err = await rejection(v.validate({ platform: 'ios', receipt: SK1 }));
    expect(err.code).toBe('iap_receipt_unsupported');
    expect(err.unavailable).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('Apple credentials', () => {
  it('reads a PEM with literal \\n, and a bare base64 body, from one env line', () => {
    const oneLine = PEM.trim().replace(/\n/g, '\\n');
    expect(applePrivateKeyFromEnv(oneLine)).toBe(PEM.trim());

    const body = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const status = appleCredentialStatus({
      ...serverApiCreds,
      privateKey: applePrivateKeyFromEnv(body),
      sharedSecret: '',
    });
    expect(status.serverApi).toBe('ok');
    expect(applePrivateKeyFromEnv(undefined)).toBe('');
  });

  it('tells missing, partial and invalid credentials apart', () => {
    expect(appleCredentialStatus({ ...noCreds, sharedSecret: '' }).serverApi).toBe('missing');
    expect(appleCredentialStatus({ ...noCreds, keyId: 'K', sharedSecret: '' }).serverApi).toBe(
      'partial',
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(
      appleCredentialStatus({ ...serverApiCreds, privateKey: rsa, sharedSecret: '' }).serverApi,
    ).toBe('invalid_key');
    expect(
      appleCredentialStatus({ ...serverApiCreds, privateKey: 'not a key', sharedSecret: '' })
        .serverApi,
    ).toBe('invalid_key');
  });
});
