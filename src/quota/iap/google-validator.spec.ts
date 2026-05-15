import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { GoogleValidator } from './google-validator';
import { IapValidationError } from './iap.types';

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

function makeServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    client_email: 'iap-validator@carsalepro.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

async function buildValidator(http: HttpService, saJson: string, productIds: string[] = []) {
  const mod = await Test.createTestingModule({
    providers: [
      GoogleValidator,
      { provide: HttpService, useValue: http },
      {
        provide: ConfigService,
        useValue: {
          get: () => ({
            bundleId: 'com.carsalepro.app',
            apple: { sharedSecret: '', issuerId: '', keyId: '', privateKey: '', useSandboxFirst: false },
            google: {
              packageName: 'com.carsalepro.app',
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

describe('GoogleValidator', () => {
  it('returns isConfigured=false when SA json is missing', async () => {
    const v = await buildValidator(mockHttp(), '');
    expect(v.isConfigured()).toBe(false);
    await expect(
      v.validate({ platform: 'android', receipt: 'tok', productId: 'p' }),
    ).rejects.toThrow(/GOOGLE_PLAY_SA_JSON/);
  });

  it('returns isConfigured=true with a parseable SA json', async () => {
    const v = await buildValidator(mockHttp(), makeServiceAccountJson());
    expect(v.isConfigured()).toBe(true);
  });

  it('requires productId for android', async () => {
    const v = await buildValidator(mockHttp(), makeServiceAccountJson());
    await expect(v.validate({ platform: 'android', receipt: 'tok' })).rejects.toThrow(
      /productId/,
    );
  });

  it('validates a one-time product purchase', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      of(axiosResp({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' })),
    );
    http.get.mockReturnValueOnce(
      of(
        axiosResp({
          purchaseState: 0,
          consumptionState: 1,
          orderId: 'GPA.0000-0000-0000-0001',
          purchaseTimeMillis: '1716470000000',
        }),
      ),
    );
    const v = await buildValidator(http, makeServiceAccountJson());
    const res = await v.validate({
      platform: 'android',
      receipt: 'play-token',
      productId: 'carsalepro_pro_lifetime',
    });
    expect(res.valid).toBe(true);
    expect(res.transactionId).toBe('GPA.0000-0000-0000-0001');
    expect(res.provider).toBe('google-play');
  });

  it('validates a subscription purchase', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      of(axiosResp({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' })),
    );
    http.get.mockReturnValueOnce(
      of(
        axiosResp({
          paymentState: 1,
          autoRenewing: true,
          orderId: 'GPA.SUB-0001',
          startTimeMillis: '1716470000000',
          expiryTimeMillis: '1719062000000',
        }),
      ),
    );
    const v = await buildValidator(http, makeServiceAccountJson(), ['carsalepro_pro_monthly']);
    const res = await v.validate({
      platform: 'android',
      receipt: 'sub-token',
      productId: 'carsalepro_pro_monthly',
    });
    expect(res.valid).toBe(true);
    expect(res.expiresAt?.getTime()).toBe(1719062000000);
  });

  it('rejects when Google returns 400/404', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      of(axiosResp({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' })),
    );
    http.get.mockReturnValueOnce(throwError(() => axiosError(400, 'The purchase token is invalid.')));
    const v = await buildValidator(http, makeServiceAccountJson());
    await expect(
      v.validate({ platform: 'android', receipt: 'bogus', productId: 'p' }),
    ).rejects.toBeInstanceOf(IapValidationError);
  });

  it('rejects when product is in pending state', async () => {
    const http = mockHttp();
    http.post.mockReturnValueOnce(
      of(axiosResp({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' })),
    );
    http.get.mockReturnValueOnce(
      of(axiosResp({ purchaseState: 2, orderId: 'GPA.x', purchaseTimeMillis: '1' })),
    );
    const v = await buildValidator(http, makeServiceAccountJson());
    await expect(
      v.validate({ platform: 'android', receipt: 'tok', productId: 'p' }),
    ).rejects.toThrow(/pending|not "purchased"/);
  });
});
