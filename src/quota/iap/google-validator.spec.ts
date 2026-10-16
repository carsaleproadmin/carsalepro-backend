import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { GoogleValidator, googleCredentialStatus } from './google-validator';
import { IapValidationError, PRO_PRODUCT_ID } from './iap.types';

const PACKAGE = 'net.carsalepro.app';
const PLAY = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

function mockHttp(): jest.Mocked<HttpService> {
  return { post: jest.fn(), get: jest.fn() } as unknown as jest.Mocked<HttpService>;
}

function axiosResp<T>(data: T, status = 200): AxiosResponse<T> {
  return { data, status, statusText: 'OK', headers: {}, config: {} as never };
}

function axiosError(status: number, message: string): unknown {
  return Object.assign(new Error(message), {
    response: { status, data: { error: { message } } },
  });
}

const oauthOk = () =>
  of(axiosResp({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' }));

function makeServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    client_email: 'iap-validator@carsalepro.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

const SA_JSON = makeServiceAccountJson();

async function buildValidator(http: HttpService, saJson = SA_JSON, productIds: string[] = []) {
  const mod = await Test.createTestingModule({
    providers: [
      GoogleValidator,
      { provide: HttpService, useValue: http },
      {
        provide: ConfigService,
        useValue: {
          get: () => ({
            bundleId: PACKAGE,
            apple: {
              sharedSecret: '',
              issuerId: '',
              keyId: '',
              privateKey: '',
              useSandboxFirst: false,
            },
            google: {
              packageName: PACKAGE,
              serviceAccountJson: saJson,
              subscriptionProductIds: productIds,
            },
            mode: 'server',
          }),
        },
      },
    ],
  }).compile();
  return mod.get(GoogleValidator);
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

const proRequest = {
  platform: 'android' as const,
  receipt: 'play-token',
  productId: PRO_PRODUCT_ID,
};

describe('GoogleValidator', () => {
  it('returns isConfigured=false when SA json is missing', async () => {
    const v = await buildValidator(mockHttp(), '');
    expect(v.isConfigured()).toBe(false);
    const err = await rejection(v.validate(proRequest));
    expect(err.code).toBe('iap_not_configured');
    expect(err.reason).toMatch(/GOOGLE_PLAY_SA_JSON/);
  });

  it('returns isConfigured=true with a parseable SA json', async () => {
    const v = await buildValidator(mockHttp());
    expect(v.isConfigured()).toBe(true);
  });

  it('requires productId for android', async () => {
    const v = await buildValidator(mockHttp());
    const err = await rejection(v.validate({ platform: 'android', receipt: 'tok' }));
    expect(err.code).toBe('iap_product_id_required');
  });

  it('refuses any product other than PRO before calling Play', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    const err = await rejection(
      v.validate({ platform: 'android', receipt: 'tok', productId: 'carsalepro_pro_monthly' }),
    );
    expect(err.code).toBe('iap_product_mismatch');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('validates a PRO purchase through purchases.products.get and acknowledges it', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk()).mockReturnValueOnce(of(axiosResp({})));
    http.get.mockReturnValueOnce(
      of(
        axiosResp({
          purchaseState: 0,
          acknowledgementState: 0,
          consumptionState: 0,
          orderId: 'GPA.0000-0000-0000-0001',
          purchaseTimeMillis: '1716470000000',
        }),
      ),
    );
    const v = await buildValidator(http);

    const res = await v.validate(proRequest);

    expect(res).toMatchObject({
      valid: true,
      transactionId: 'GPA.0000-0000-0000-0001',
      storeTransactionId: 'GPA.0000-0000-0000-0001',
      provider: 'google-play',
      bundleId: PACKAGE,
    });
    // The route matters as much as the verdict. PRO is a one-time managed
    // product, so it must reach /purchases/products/ - never
    // /purchases/subscriptions/, where Play answers 404 for it.
    const getUrl = http.get.mock.calls[0][0] as string;
    expect(getUrl).toBe(
      `${PLAY}/${PACKAGE}/purchases/products/${PRO_PRODUCT_ID}/tokens/play-token`,
    );
    expect(http.get.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer ya29.test' },
    });

    // Call 0 is OAuth; call 1 is the acknowledgement.
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(http.post.mock.calls[1][0]).toBe(`${getUrl}:acknowledge`);
    expect(http.post.mock.calls[1][2]).toMatchObject({
      headers: { Authorization: 'Bearer ya29.test' },
    });
  });

  it('does not acknowledge a purchase that is already acknowledged', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(
      of(axiosResp({ purchaseState: 0, acknowledgementState: 1, orderId: 'GPA.x' })),
    );
    const v = await buildValidator(http);

    await v.validate(proRequest);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('still grants when the acknowledgement fails (the app acknowledges too)', async () => {
    const http = mockHttp();
    http.post
      .mockReturnValueOnce(oauthOk())
      .mockReturnValueOnce(throwError(() => axiosError(503, 'backend error')));
    http.get.mockReturnValueOnce(
      of(axiosResp({ purchaseState: 0, acknowledgementState: 0, orderId: 'GPA.x' })),
    );
    const v = await buildValidator(http);

    await expect(v.validate(proRequest)).resolves.toMatchObject({ valid: true });
  });

  it.each([
    ['cancelled (1)', { purchaseState: 1 }],
    ['pending (2)', { purchaseState: 2 }],
    ['missing', {}],
  ])('refuses a purchase whose state is %s, and acknowledges nothing', async (_label, body) => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(
      of(axiosResp({ orderId: 'GPA.x', acknowledgementState: 0, ...body })),
    );
    const v = await buildValidator(http);

    const err = await rejection(v.validate(proRequest));
    expect(err.code).toBe('iap_purchase_not_completed');
    expect(err.unavailable).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('refuses when Play names a different product', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(of(axiosResp({ purchaseState: 0, productId: 'other' })));
    const v = await buildValidator(http);

    expect((await rejection(v.validate(proRequest))).code).toBe('iap_product_mismatch');
  });

  it('rejects when Google returns 400/404', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(
      throwError(() => axiosError(400, 'The purchase token is invalid.')),
    );
    const v = await buildValidator(http);

    const err = await rejection(v.validate({ ...proRequest, receipt: 'bogus' }));
    expect(err.code).toBe('iap_store_rejected');
    expect(err.unavailable).toBe(false);
  });

  it('is unavailable (not rejected) when Play refuses the service account', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(
      throwError(() => axiosError(403, 'The current user has insufficient permissions')),
    );
    const v = await buildValidator(http);

    const err = await rejection(v.validate(proRequest));
    expect(err.code).toBe('iap_store_auth_failed');
    expect(err.unavailable).toBe(true);
  });

  it('is unavailable on a Play outage', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(throwError(() => axiosError(500, 'Backend Error')));
    const v = await buildValidator(http);

    const err = await rejection(v.validate(proRequest));
    expect(err.code).toBe('iap_store_unavailable');
    expect(err.unavailable).toBe(true);
  });

  it('is unavailable when the OAuth token cannot be fetched', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(throwError(() => new Error('socket hang up')));
    const v = await buildValidator(http);

    const err = await rejection(v.validate(proRequest));
    expect(err.code).toBe('iap_store_unavailable');
    expect(http.get).not.toHaveBeenCalled();
  });

  // There is no subscription path any more. Even a stale
  // GOOGLE_PLAY_SUBSCRIPTION_IDS that lists the PRO id must not reroute it.
  it('ignores GOOGLE_PLAY_SUBSCRIPTION_IDS and refuses any other product', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(of(axiosResp({ purchaseState: 0, orderId: 'GPA.x' })));
    const v = await buildValidator(http, SA_JSON, [PRO_PRODUCT_ID, 'example_legacy_subscription']);

    await v.validate(proRequest);
    expect(http.get.mock.calls[0][0]).toContain('/purchases/products/');

    const err = await rejection(
      v.validate({
        platform: 'android',
        receipt: 'sub-token',
        productId: 'example_legacy_subscription',
      }),
    );
    expect(err.code).toBe('iap_product_mismatch');
  });

  it('identifies a purchase without an orderId by a digest of its token, never the token', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(oauthOk());
    http.get.mockReturnValueOnce(of(axiosResp({ purchaseState: 0, acknowledgementState: 1 })));
    const v = await buildValidator(http);

    const res = await v.validate(proRequest);
    expect(res.storeTransactionId).toMatch(/^token-sha256:[0-9a-f]{64}$/);
    expect(res.storeTransactionId).not.toContain(proRequest.receipt);
  });

  it('does not copy an attacker-controlled product id into the reason verbatim', async () => {
    const v = await buildValidator(mockHttp());
    const err = await rejection(
      v.validate({
        platform: 'android',
        receipt: 'tok',
        productId: `a\u0000b\n${'y'.repeat(200)}`,
      }),
    );
    expect(err.reason).not.toContain('\u0000');
    expect(err.reason).not.toContain('\n');
    expect(err.reason).not.toContain('y'.repeat(65));
  });
});

describe('googleCredentialStatus', () => {
  it('loads the private key, not only the JSON', () => {
    expect(googleCredentialStatus('')).toBe('missing');
    expect(googleCredentialStatus('{not json')).toBe('unparseable');
    expect(googleCredentialStatus(SA_JSON)).toBe('ok');
    expect(googleCredentialStatus(Buffer.from(SA_JSON).toString('base64'))).toBe('ok');
    const broken = JSON.stringify({ ...JSON.parse(SA_JSON), private_key: 'not-a-pem' });
    expect(googleCredentialStatus(broken)).toBe('invalid_key');
  });
});
