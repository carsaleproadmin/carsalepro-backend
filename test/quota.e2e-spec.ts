import { INestApplication } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';
import { IapValidatorService } from '../src/quota/iap/iap-validator.service';
import { IAP_MAX_DEVICES_PER_PURCHASE } from '../src/quota/iap/iap.types';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Quota (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDb(app);
  });

  it('400 when X-Device-Id missing', async () => {
    await request(app.getHttpServer()).get('/quota').expect(400);
  });

  it('initial quota reports 0/3 as historical counters, unenforced, not pro', async () => {
    // The five legacy fields must stay byte-identical: the shipped Flutter app
    // parses them through a freezed DTO with non-nullable ints. They are now
    // just counters — `freeLimitEnforced: false` is what says the cap is dead.
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .get('/quota')
      .set('x-device-id', did)
      .expect(200);
    expect(res.body).toMatchObject({
      deviceId: did,
      freeReportsUsed: 0,
      freeReportsLimit: 3,
      isPro: false,
      remaining: 3,
      freeLimitEnforced: false,
    });
  });

  it('upgrade marks device PRO in client-trust mode (default in tests)', async () => {
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post('/quota/upgrade')
      .set('x-device-id', did)
      .send({ platform: 'ios', receipt: 'iap-receipt-token-xyz' })
      .expect(200);
    expect(res.body.isPro).toBe(true);
  });

  it('upgrade rejects unknown platform', async () => {
    const did = uniqueDeviceId();
    await request(app.getHttpServer())
      .post('/quota/upgrade')
      .set('x-device-id', did)
      .send({ platform: 'web', receipt: 'x' })
      .expect(400);
  });

  /**
   * Server mode fails CLOSED. None of these cases reaches a store: each is
   * refused before the network, so the suite needs no Apple or Google account.
   */
  describe('server mode', () => {
    const IAP_ENV = [
      'IAP_VALIDATION_MODE',
      'APPLE_ISSUER_ID',
      'APPLE_KEY_ID',
      'APPLE_PRIVATE_KEY',
      'APPLE_SHARED_SECRET',
      'GOOGLE_PLAY_SA_JSON',
    ] as const;
    let saved: Partial<Record<(typeof IAP_ENV)[number], string>>;

    beforeEach(() => {
      saved = Object.fromEntries(IAP_ENV.map((k) => [k, process.env[k]]));
      for (const k of IAP_ENV) delete process.env[k];
      process.env.IAP_VALIDATION_MODE = 'server';
    });

    afterEach(() => {
      for (const k of IAP_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    async function withApp(
      run: (server: ReturnType<INestApplication['getHttpServer']>) => Promise<void>,
    ) {
      const isolated = await createTestApp();
      try {
        await run(isolated.getHttpServer());
      } finally {
        await isolated.close();
      }
    }

    function setAppleServerApiKey(): void {
      const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }) as string;
      process.env.APPLE_ISSUER_ID = '57246542-96fe-1a63-e053-0824d011072a';
      process.env.APPLE_KEY_ID = '2X9R4HXF34';
      // One env line with literal \n, the way Render stores it.
      process.env.APPLE_PRIVATE_KEY = pem.trim().replace(/\n/g, '\\n');
    }

    function signedTransaction(payload: Record<string, unknown>): string {
      const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${part({ alg: 'ES256' })}.${part(payload)}.c2lnbmF0dXJl`;
    }

    it('answers 503 iap_not_configured, and no PRO, when Apple credentials are missing', async () => {
      await withApp(async (server) => {
        const did = uniqueDeviceId();
        const res = await request(server)
          .post('/quota/upgrade')
          .set('x-device-id', did)
          .send({ platform: 'ios', receipt: 'definitely-fake' })
          .expect(503);
        expect(res.body.code).toBe('iap_not_configured');
        expect(res.body.error).toMatchObject({ code: 'iap_not_configured' });
        expect(res.body.message).toMatch(/APPLE_/);

        const quota = await request(server).get('/quota').set('x-device-id', did).expect(200);
        expect(quota.body.isPro).toBe(false);
      });
    });

    it('answers 503 iap_not_configured when GOOGLE_PLAY_SA_JSON is missing', async () => {
      await withApp(async (server) => {
        const res = await request(server)
          .post('/quota/upgrade')
          .set('x-device-id', uniqueDeviceId())
          .send({ platform: 'android', receipt: 'token', productId: 'carsalepro_pro_lifetime' })
          .expect(503);
        expect(res.body.code).toBe('iap_not_configured');
        expect(res.body.message).toMatch(/GOOGLE_PLAY_SA_JSON/);
      });
    });

    it('refuses a StoreKit 1 receipt with 400 iap_receipt_unsupported when no shared secret is set', async () => {
      setAppleServerApiKey();
      await withApp(async (server) => {
        const did = uniqueDeviceId();
        const res = await request(server)
          .post('/quota/upgrade')
          .set('x-device-id', did)
          .send({ platform: 'ios', receipt: 'MIIT8QYJKoZIhvcNAQcCoIIT4jCCE94CAQEx' })
          .expect(400);
        expect(res.body).toMatchObject({
          error: 'IapValidationFailed',
          code: 'iap_receipt_unsupported',
        });

        const quota = await request(server).get('/quota').set('x-device-id', did).expect(200);
        expect(quota.body.isPro).toBe(false);
      });
    });

    it('refuses a StoreKit 2 JWS of another bundle with 400 iap_bundle_mismatch', async () => {
      setAppleServerApiKey();
      await withApp(async (server) => {
        const res = await request(server)
          .post('/quota/upgrade')
          .set('x-device-id', uniqueDeviceId())
          .send({
            platform: 'ios',
            receipt: signedTransaction({
              transactionId: '2000000123456789',
              bundleId: 'com.someoneelse.app',
              productId: 'carsalepro_pro_lifetime',
            }),
            productId: 'carsalepro_pro_lifetime',
          })
          .expect(400);
        expect(res.body.code).toBe('iap_bundle_mismatch');
      });
    });

    it('refuses a JWS that names no transaction with 400 iap_receipt_malformed', async () => {
      setAppleServerApiKey();
      await withApp(async (server) => {
        const res = await request(server)
          .post('/quota/upgrade')
          .set('x-device-id', uniqueDeviceId())
          .send({ platform: 'ios', receipt: signedTransaction({ bundleId: 'net.carsalepro.app' }) })
          .expect(400);
        expect(res.body.code).toBe('iap_receipt_malformed');
      });
    });
  });

  /**
   * The store is replaced by a stub that verifies every receipt as the SAME
   * purchase, so the cap runs against the real database and real transactions.
   */
  describe('device cap per purchase', () => {
    const PURCHASE = 'e2e-original-transaction-1';
    let capped: INestApplication;

    beforeAll(async () => {
      const stub = {
        currentMode: 'server',
        validate: async () => ({
          valid: true,
          platform: 'ios',
          provider: 'apple-storekit2',
          environment: 'Sandbox',
          productId: 'carsalepro_pro_lifetime',
          storeTransactionId: PURCHASE,
        }),
      };
      capped = await createTestApp([{ token: IapValidatorService, useValue: stub }]);
    });

    afterAll(async () => {
      await capped.close();
    });

    const upgrade = (did: string) =>
      request(capped.getHttpServer())
        .post('/quota/upgrade')
        .set('x-device-id', did)
        .send({ platform: 'ios', receipt: 'header.payload.signature' });

    it(`unlocks ${IAP_MAX_DEVICES_PER_PURCHASE} devices, refuses the next with 409, and stays idempotent`, async () => {
      const devices = Array.from({ length: IAP_MAX_DEVICES_PER_PURCHASE }, () => uniqueDeviceId());
      for (const did of devices) {
        expect((await upgrade(did).expect(200)).body.isPro).toBe(true);
      }

      const extra = uniqueDeviceId();
      const refused = await upgrade(extra).expect(409);
      expect(refused.body).toMatchObject({
        code: 'iap_device_limit',
        deviceLimit: IAP_MAX_DEVICES_PER_PURCHASE,
      });
      const quota = await request(capped.getHttpServer())
        .get('/quota')
        .set('x-device-id', extra)
        .expect(200);
      expect(quota.body.isPro).toBe(false);

      // A restore on a device that already holds the purchase passes, even at the cap.
      await upgrade(devices[0]).expect(200);
      const prisma = capped.get(PrismaService);
      expect(await prisma.iapGrant.count({ where: { storeTransactionId: PURCHASE } })).toBe(
        IAP_MAX_DEVICES_PER_PURCHASE,
      );
    });

    it('frees the slot when a device is erased (DELETE /me)', async () => {
      const devices = Array.from({ length: IAP_MAX_DEVICES_PER_PURCHASE }, () => uniqueDeviceId());
      for (const did of devices) await upgrade(did).expect(200);
      await upgrade(uniqueDeviceId()).expect(409);

      await request(capped.getHttpServer())
        .delete('/me')
        .set('x-device-id', devices[0])
        .expect(200);
      const prisma = capped.get(PrismaService);
      expect(await prisma.iapGrant.count({ where: { deviceId: devices[0] } })).toBe(0);

      await upgrade(uniqueDeviceId()).expect(200);
    });
  });
});
