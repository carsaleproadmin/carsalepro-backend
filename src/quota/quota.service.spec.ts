import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IapValidatorService } from './iap/iap-validator.service';
import { IAP_MAX_DEVICES_PER_PURCHASE, IapValidationError } from './iap/iap.types';
import { QuotaService } from './quota.service';

const DEVICE = '3f0c2a7e-5d1b-4c3a-9e8f-1a2b3c4d5e6f';
const PURCHASE = '2000000123456789';

function build(validate: jest.Mock, grants: { own?: boolean; holders?: number } = {}) {
  const tx = {
    iapGrant: {
      findUnique: jest.fn().mockResolvedValue(grants.own ? { id: 'g1' } : null),
      count: jest.fn().mockResolvedValue(grants.holders ?? 0),
      create: jest.fn().mockResolvedValue({ id: 'g2' }),
    },
    deviceQuota: { upsert: jest.fn().mockResolvedValue({ isPro: true }) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const config = {
    get: () => ({ freeReportsLimit: 3, enforceFreeLimit: false }),
  } as unknown as ConfigService;
  const iap = { validate, currentMode: 'server' } as unknown as IapValidatorService;
  const service = new QuotaService(prisma as unknown as PrismaService, config as never, iap);
  return { service, prisma, tx };
}

const verified = (overrides: Record<string, unknown> = {}) =>
  jest.fn().mockResolvedValue({
    provider: 'apple-storekit2',
    environment: 'Production',
    storeTransactionId: PURCHASE,
    ...overrides,
  });

const dto = { platform: 'ios' as const, receipt: 'header.payload.signature' };

describe('QuotaService.markPro', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('verdict mapping (server mode)', () => {
    it('answers 400 with a code for a rejected purchase, and grants nothing', async () => {
      const { service, tx } = build(
        jest
          .fn()
          .mockRejectedValue(new IapValidationError('iap_product_mismatch', 'Product mismatch')),
      );
      const err = (await service
        .markPro(DEVICE, dto)
        .catch((e: unknown) => e)) as BadRequestException;

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        error: 'IapValidationFailed',
        code: 'iap_product_mismatch',
        message: 'Product mismatch',
      });
      expect(tx.deviceQuota.upsert).not.toHaveBeenCalled();
    });

    it('answers 503 with a nested domain code when the store is down, and grants nothing', async () => {
      const { service, tx } = build(
        jest
          .fn()
          .mockRejectedValue(new IapValidationError('iap_store_unavailable', 'App Store down')),
      );
      const err = (await service
        .markPro(DEVICE, dto)
        .catch((e: unknown) => e)) as ServiceUnavailableException;

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      // `{ error: { code } }` is what AllExceptionsFilter lets through at 5xx.
      expect(err.getResponse()).toMatchObject({
        error: { code: 'iap_store_unavailable', message: 'App Store down' },
        code: 'iap_store_unavailable',
      });
      expect(tx.deviceQuota.upsert).not.toHaveBeenCalled();
    });

    it('grants nothing on an unexpected validator error', async () => {
      const { service, tx } = build(jest.fn().mockRejectedValue(new TypeError('boom')));
      await expect(service.markPro(DEVICE, dto)).rejects.toBeInstanceOf(TypeError);
      expect(tx.deviceQuota.upsert).not.toHaveBeenCalled();
    });

    it('fails closed (503) when a store verdict carries no purchase id', async () => {
      const { service, tx } = build(verified({ storeTransactionId: undefined }));
      await expect(service.markPro(DEVICE, dto)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(tx.deviceQuota.upsert).not.toHaveBeenCalled();
    });
  });

  describe('device cap per purchase', () => {
    it('records the (purchase, device) pair and grants PRO in one serializable transaction', async () => {
      const { service, prisma, tx } = build(verified(), { holders: 2 });
      await service.markPro(DEVICE, dto);

      expect(tx.iapGrant.create).toHaveBeenCalledWith({
        data: { platform: 'ios', storeTransactionId: PURCHASE, deviceId: DEVICE },
      });
      expect(tx.deviceQuota.upsert).toHaveBeenCalledTimes(1);
      expect((prisma.$transaction.mock.calls[0] as unknown[])[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    });

    it('is idempotent for a device that already holds the purchase, even at the cap', async () => {
      const { service, tx } = build(verified(), {
        own: true,
        holders: IAP_MAX_DEVICES_PER_PURCHASE,
      });
      await service.markPro(DEVICE, dto);

      expect(tx.iapGrant.count).not.toHaveBeenCalled();
      expect(tx.iapGrant.create).not.toHaveBeenCalled();
      expect(tx.deviceQuota.upsert).toHaveBeenCalledTimes(1);
    });

    it(`refuses a new device with 409 iap_device_limit at ${IAP_MAX_DEVICES_PER_PURCHASE} devices`, async () => {
      const { service, tx } = build(verified(), { holders: IAP_MAX_DEVICES_PER_PURCHASE });
      const err = (await service
        .markPro(DEVICE, dto)
        .catch((e: unknown) => e)) as ConflictException;

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'iap_device_limit',
        deviceLimit: IAP_MAX_DEVICES_PER_PURCHASE,
      });
      expect(tx.iapGrant.create).not.toHaveBeenCalled();
      expect(tx.deviceQuota.upsert).not.toHaveBeenCalled();
    });

    it('retries a transaction that lost a serialization race', async () => {
      const { service, prisma, tx } = build(verified(), { holders: 1 });
      const conflict = new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
      prisma.$transaction
        .mockImplementationOnce(() => Promise.reject(conflict))
        .mockImplementationOnce((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));

      await service.markPro(DEVICE, dto);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.deviceQuota.upsert).toHaveBeenCalledTimes(1);
    });

    it('records nothing in client-trust mode, which has no purchase id', async () => {
      const { service, prisma, tx } = build(
        jest.fn().mockResolvedValue({ provider: 'client-trust', environment: 'Unknown' }),
      );
      await service.markPro(DEVICE, dto);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.iapGrant.create).not.toHaveBeenCalled();
      expect(tx.deviceQuota.upsert).toHaveBeenCalledTimes(1);
    });
  });
});
