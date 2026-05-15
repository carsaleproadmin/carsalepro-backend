import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AxiosResponse } from 'axios';
import { of } from 'rxjs';
import { AppleValidator } from './apple-validator';
import { IapValidationError } from './iap.types';

function mockHttp(): jest.Mocked<HttpService> {
  return { post: jest.fn(), get: jest.fn() } as unknown as jest.Mocked<HttpService>;
}

function axiosResp<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} as never };
}

const baseConfig = {
  bundleId: 'com.carsalepro.app',
  apple: {
    sharedSecret: 'secret-xyz',
    issuerId: '',
    keyId: '',
    privateKey: '',
    useSandboxFirst: false,
  },
  google: { packageName: '', serviceAccountJson: '', subscriptionProductIds: [] },
  mode: 'server' as const,
};

async function buildValidator(http: HttpService, overrides: Partial<typeof baseConfig> = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      AppleValidator,
      { provide: HttpService, useValue: http },
      {
        provide: ConfigService,
        useValue: { get: () => ({ ...baseConfig, ...overrides }) },
      },
    ],
  }).compile();
  return mod.get(AppleValidator);
}

describe('AppleValidator (verifyReceipt)', () => {
  it('accepts a valid production receipt and parses bundle id + latest_receipt_info', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    http.post.mockReturnValueOnce(
      of(
        axiosResp({
          status: 0,
          environment: 'Production',
          receipt: { bundle_id: 'com.carsalepro.app' },
          latest_receipt_info: [
            {
              product_id: 'carsalepro_pro_monthly',
              transaction_id: '1000000999000001',
              original_transaction_id: '1000000999000001',
              purchase_date_ms: '1716470000000',
              expires_date_ms: '1719062000000',
            },
          ],
        }),
      ),
    );
    const res = await v.validate({ platform: 'ios', receipt: 'base64-blob' });
    expect(res.valid).toBe(true);
    expect(res.productId).toBe('carsalepro_pro_monthly');
    expect(res.transactionId).toBe('1000000999000001');
    expect(res.environment).toBe('Production');
    expect(res.provider).toBe('apple-verifyreceipt');
  });

  it('falls back to sandbox when prod returns 21007', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    http.post
      .mockReturnValueOnce(of(axiosResp({ status: 21007 })))
      .mockReturnValueOnce(
        of(
          axiosResp({
            status: 0,
            environment: 'Sandbox',
            receipt: { bundle_id: 'com.carsalepro.app' },
            latest_receipt_info: [
              {
                product_id: 'carsalepro_pro_monthly',
                transaction_id: '2000000111222333',
                purchase_date_ms: '1716470000000',
              },
            ],
          }),
        ),
      );
    const res = await v.validate({ platform: 'ios', receipt: 'sandbox-blob' });
    expect(res.environment).toBe('Sandbox');
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('rejects on bundle-id mismatch', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    http.post.mockReturnValueOnce(
      of(
        axiosResp({
          status: 0,
          environment: 'Production',
          receipt: { bundle_id: 'com.someoneelse.app' },
          latest_receipt_info: [
            { product_id: 'x', transaction_id: '1', purchase_date_ms: '1' },
          ],
        }),
      ),
    );
    await expect(v.validate({ platform: 'ios', receipt: 'b' })).rejects.toBeInstanceOf(
      IapValidationError,
    );
  });

  it('maps non-zero status to a friendly error message', async () => {
    const http = mockHttp();
    const v = await buildValidator(http);
    http.post
      .mockReturnValueOnce(of(axiosResp({ status: 21003 })))
      .mockReturnValueOnce(of(axiosResp({ status: 21003 })));
    await expect(v.validate({ platform: 'ios', receipt: 'b' })).rejects.toThrow(
      /Receipt could not be authenticated/,
    );
  });

  it('refuses when no credentials are configured', async () => {
    const http = mockHttp();
    const v = await buildValidator(http, {
      apple: { ...baseConfig.apple, sharedSecret: '' },
    });
    await expect(v.validate({ platform: 'ios', receipt: 'b' })).rejects.toThrow(
      /No Apple credentials configured/,
    );
  });
});
