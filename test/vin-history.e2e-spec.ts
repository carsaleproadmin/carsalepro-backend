import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { StripeEvent } from '../src/payments/stripe.service';
import { SettingsService } from '../src/settings/settings.service';
import {
  VIN_HISTORY_PROVIDER,
  VinHistoryProvider,
} from '../src/vin-history/vin-history.provider';

/**
 * BE-S3 — paid VIN history.
 *
 * Stripe is forced into mock mode by NODE_ENV=test, so an unlock settles
 * in-process; the webhook path is exercised by handing a synthetic event
 * straight to PaymentsService, which is the same entry point the signed
 * webhook controller uses after verification.
 */

/** Valid ISO 3779 VINs (no I/O/Q), unique per run so the cache starts cold. */
function uniqueVin(seed = ''): string {
  const alphabet = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${seed}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IOQ]/g, 'X');
  const body = (rand + alphabet).slice(0, 14);
  return `WAU${body}`.slice(0, 17).padEnd(17, '0');
}

function uniqueEmail(): string {
  return `vinhist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function registerUser(
  app: INestApplication,
): Promise<{ token: string; userId: string; email: string }> {
  const email = uniqueEmail();
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

describe('VIN history — paid provenance (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let provider: VinHistoryProvider;
  const vinsUsed: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    provider = app.get<VinHistoryProvider>(VIN_HISTORY_PROVIDER);
  });

  afterAll(async () => {
    await prisma.vinHistoryPurchase.deleteMany({ where: { vin: { in: vinsUsed } } });
    await prisma.vinHistoryReport.deleteMany({ where: { vin: { in: vinsUsed } } });
    await prisma.refund.deleteMany({ where: { payment: { userId: { in: userIds } } } });
    await prisma.payment.deleteMany({ where: { userId: { in: userIds }, purpose: 'vin_history' } });
    await app.close();
  });

  function track(vin: string): string {
    vinsUsed.push(vin);
    return vin;
  }

  async function newUser() {
    const user = await registerUser(app);
    userIds.push(user.userId);
    return user;
  }

  // ============================================================
  // Free preview
  // ============================================================

  it('1. preview is public, returns counts and booleans, and flags the mock as synthetic', async () => {
    const vin = track(uniqueVin('a'));
    const res = await request(app.getHttpServer())
      .get(`/api/v1/vin-history/${vin}/preview`)
      .expect(200);

    expect(res.body.vin).toBe(vin);
    expect(res.body.provider).toBe('mock');
    // Never pass generated data off as real.
    expect(res.body.synthetic).toBe(true);
    expect(typeof res.body.summary.recordCount).toBe('number');
    expect(typeof res.body.summary.ownersCount).toBe('number');
    expect(typeof res.body.summary.countriesCount).toBe('number');
    expect(typeof res.body.summary.hasAccidentRecords).toBe('boolean');
    expect(typeof res.body.summary.hasOdometerRollback).toBe('boolean');
    expect(typeof res.body.summary.hasStolenRecord).toBe('boolean');
    expect(res.body.priceCents).toBeGreaterThan(0);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.purchasable).toBe(true);
  });

  it('2. preview leaks no dates, plates or descriptions — asserted on the serialized body', async () => {
    const vin = track(uniqueVin('b'));
    const res = await request(app.getHttpServer())
      .get(`/api/v1/vin-history/${vin}/preview`)
      .expect(200);

    const serialized = JSON.stringify(res.body);
    // A single ISO date anywhere in the free preview gives away the paid answer
    // ("accident on 2019-04-12") — scan the whole body, not named fields.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toMatch(/plate/i);
    expect(serialized).not.toMatch(/description/i);
    expect(serialized).not.toMatch(/countriesSeen/);
    // Every value under summary must be a number or a boolean.
    for (const value of Object.values(res.body.summary as Record<string, unknown>)) {
      expect(['number', 'boolean']).toContain(value === null ? 'number' : typeof value);
    }
  });

  it('3. the mock provider is deterministic — the same VIN yields the same history twice', async () => {
    const vin = track(uniqueVin('c'));
    const first = await provider.fetch(vin);
    const second = await provider.fetch(vin);
    expect(second).toEqual(first);

    // And two preview calls agree with each other and with the payload.
    const p1 = await request(app.getHttpServer()).get(`/api/v1/vin-history/${vin}/preview`).expect(200);
    const p2 = await request(app.getHttpServer()).get(`/api/v1/vin-history/${vin}/preview`).expect(200);
    expect(p2.body).toEqual(p1.body);
    expect(p1.body.summary.ownersCount).toBe(first.summary.ownersCount);
  });

  it('4. a malformed VIN is a 400 and never reaches the provider', async () => {
    await request(app.getHttpServer()).get('/api/v1/vin-history/NOTAVIN/preview').expect(400);
    // I, O and Q are excluded by ISO 3779.
    await request(app.getHttpServer())
      .get('/api/v1/vin-history/WAUZZZ8K9IA00Q01/preview')
      .expect(400);
  });

  // ============================================================
  // Unlock
  // ============================================================

  it('5. unlock requires authentication', async () => {
    const vin = track(uniqueVin('d'));
    await request(app.getHttpServer()).post(`/api/v1/vin-history/${vin}/unlock`).expect(401);
  });

  it('6. unlock settles in mock mode, charges the catalogue price and produces a ready purchase', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('e'));
    const expectedCents = await app.get(SettingsService).getCents('vinHistoryPriceEur');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    expect(res.body.status).toBe('ready');
    expect(res.body.mock).toBe(true);
    expect(res.body.amountCents).toBe(expectedCents);

    const purchase = await prisma.vinHistoryPurchase.findUniqueOrThrow({
      where: { userId_vin: { userId: user.userId, vin } },
    });
    expect(purchase.status).toBe('ready');
    expect(purchase.reportId).toBeTruthy();
    expect(purchase.provider).toBe('mock');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: purchase.paymentId! } });
    expect(payment.purpose).toBe('vin_history');
    expect(payment.status).toBe('succeeded');
    expect(payment.amountCents).toBe(expectedCents);
  });

  it('7. unlocking the same VIN twice is idempotent — one purchase, one charge', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('f'));

    const first = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    expect(second.body.alreadyOwned).toBe(true);
    expect(second.body.purchaseId).toBe(first.body.purchaseId);

    const purchases = await prisma.vinHistoryPurchase.findMany({
      where: { userId: user.userId, vin },
    });
    expect(purchases).toHaveLength(1);

    const payments = await prisma.payment.findMany({
      where: { userId: user.userId, purpose: 'vin_history' },
    });
    expect(payments).toHaveLength(1);
  });

  it('8. two users unlocking one VIN share ONE cached provider report', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const vin = track(uniqueVin('g'));

    await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(201);

    const reports = await prisma.vinHistoryReport.findMany({ where: { vin } });
    expect(reports).toHaveLength(1);

    const purchases = await prisma.vinHistoryPurchase.findMany({ where: { vin } });
    expect(purchases).toHaveLength(2);
    // Both paid; the provider was queried once.
    expect(new Set(purchases.map((p) => p.reportId))).toEqual(new Set([reports[0].id]));
    expect(purchases.every((p) => p.status === 'ready')).toBe(true);
  });

  // ============================================================
  // Buyer's archive
  // ============================================================

  it('9. the buyer can list and open their VIN checks, and gets the full payload', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('h'));
    const unlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/me/vin-checks')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    const item = list.body.items.find((i: { vin: string }) => i.vin === vin);
    expect(item).toBeTruthy();
    expect(item.status).toBe('ready');
    expect(item.synthetic).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${unlock.body.purchaseId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(detail.body.payload.schemaVersion).toBe(1);
    expect(detail.body.payload.vin).toBe(vin);
    expect(detail.body.payload.provider).toBe('mock');
    expect(Array.isArray(detail.body.payload.owners)).toBe(true);
    expect(Array.isArray(detail.body.payload.mileageRecords)).toBe(true);
    expect(detail.body.payload.theft).toBeDefined();
  });

  it("10. another user's purchase is a 404, NOT a 403 — a 403 would confirm the id exists", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const vin = track(uniqueVin('i'));

    const unlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${unlock.body.purchaseId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    expect(res.body.error.code).toBe('not_found');

    // The same 404 for an id that never existed — indistinguishable answers.
    const missing = await request(app.getHttpServer())
      .get('/api/v1/me/vin-checks/does-not-exist')
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('11. download hands back a PRIVATE signed URL (never a public bucket URL)', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('j'));
    const unlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    // The buyer's own snapshot key, not the shared report's — the shared archive
    // is legacy and new report rows no longer carry one.
    const purchase = await prisma.vinHistoryPurchase.findUniqueOrThrow({
      where: { id: unlock.body.purchaseId as string },
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${unlock.body.purchaseId}/download`)
      .set('Authorization', `Bearer ${user.token}`);

    if (purchase.s3Key) {
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('X-Amz-Signature');
      expect(res.body.contentType).toBe('application/json');
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } else {
      // R2 unconfigured in this environment — no archive was written.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('download_unavailable');
    }
  });

  // ============================================================
  // Webhook + failure handling
  // ============================================================

  it('12. a replayed vin_history webhook settles once and creates nothing twice', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('k'));

    // Build the pending state the real Checkout flow would leave behind.
    const amountCents = await app.get(SettingsService).getCents('vinHistoryPriceEur');
    const payment = await prisma.payment.create({
      data: { purpose: 'vin_history', userId: user.userId, amountCents, status: 'pending' },
    });
    const purchase = await prisma.vinHistoryPurchase.create({
      data: {
        userId: user.userId,
        vin,
        status: 'pending',
        provider: 'mock',
        paymentId: payment.id,
      },
    });

    const payments = app.get(PaymentsService);
    const event = {
      id: `evt_vinhist_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_vinhist',
          metadata: {
            purpose: 'vin_history',
            paymentId: payment.id,
            purchaseId: purchase.id,
            userId: user.userId,
            vin,
          },
        },
      },
    } as unknown as StripeEvent;

    await payments.handleWebhook(event);
    await payments.handleWebhook(event); // exact replay

    const after = await prisma.vinHistoryPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(after.status).toBe('ready');
    expect(after.reportId).toBeTruthy();

    expect(await prisma.vinHistoryPurchase.count({ where: { userId: user.userId, vin } })).toBe(1);
    expect(await prisma.vinHistoryReport.count({ where: { vin } })).toBe(1);
    expect(
      await prisma.payment.count({ where: { userId: user.userId, purpose: 'vin_history' } }),
    ).toBe(1);
    expect(await prisma.stripeWebhookEvent.count({ where: { id: event.id } })).toBe(1);

    await prisma.stripeWebhookEvent.deleteMany({ where: { id: event.id } });
  });

  it('13. a provider failure after payment refunds automatically and records a Refund row', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('l'));

    const boom = jest
      .spyOn(provider, 'fetch')
      .mockRejectedValue(new Error('provider timeout after 30s'));
    try {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(502);
      expect(res.body.error.code).toBe('provider_failed');
      expect(res.body.error.refunded).toBe(true);
    } finally {
      boom.mockRestore();
    }

    const purchase = await prisma.vinHistoryPurchase.findUniqueOrThrow({
      where: { userId_vin: { userId: user.userId, vin } },
    });
    // Money is back, so the purchase is 'refunded' rather than left 'failed'.
    expect(purchase.status).toBe('refunded');
    expect(purchase.failureReason).toContain('provider timeout');
    expect(purchase.reportId).toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: purchase.paymentId! } });
    expect(payment.status).toBe('refunded');

    const refund = await prisma.refund.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(refund.amountCents).toBe(payment.amountCents);
    expect(refund.reason).toBe('vin_history_provider_failed');
    // A non-order refund: the ledger row points at the payment instead.
    expect(refund.orderId).toBeNull();

    // Nothing was cached — a failed lookup must not poison the cache.
    expect(await prisma.vinHistoryReport.count({ where: { vin } })).toBe(0);
  });

  it('14. a failed purchase can be retried and then succeeds', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('m'));

    const boom = jest.spyOn(provider, 'fetch').mockRejectedValue(new Error('provider 503'));
    try {
      await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(502);
    } finally {
      boom.mockRestore();
    }

    const retry = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(retry.body.status).toBe('ready');

    // Still exactly one purchase row — the unique (userId, vin) guarantee holds
    // across the retry.
    expect(await prisma.vinHistoryPurchase.count({ where: { userId: user.userId, vin } })).toBe(1);
  });

  it('15. once cached, the preview counts agree with the paid payload — and stay date-free', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('n'));
    const unlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${unlock.body.purchaseId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const preview = await request(app.getHttpServer())
      .get(`/api/v1/vin-history/${vin}/preview`)
      .expect(200);

    expect(preview.body.summary.damageRecordCount).toBe(detail.body.payload.damageRecords.length);
    expect(preview.body.summary.ownersCount).toBe(detail.body.payload.owners.length);
    expect(preview.body.summary.recallCount).toBe(detail.body.payload.recalls.length);
    // Serving the preview FROM the cached paid payload must not start leaking
    // the dates that payload is full of.
    expect(JSON.stringify(preview.body)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('16. the admin finance summary carries a vin_history bucket', async () => {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    expect(admin).toBeTruthy();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: admin!.email, password: 'admin12345' });

    if (login.status !== 201 && login.status !== 200) {
      // The seeded admin password is environment-specific; assert the shape
      // through the service instead of skipping the coverage entirely.
      const { AdminFinanceService } = await import('../src/admin/admin-finance.service');
      const summary = await app.get(AdminFinanceService).summary();
      expect(summary.byPurpose.vin_history).toBeDefined();
      return;
    }

    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/finance/summary')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(res.body.byPurpose.vin_history).toBeDefined();
    expect(typeof res.body.byPurpose.vin_history.cents).toBe('number');
  });

  // ============================================================
  // F3-3 — the paid artefact is immutable, and nothing is sold empty
  // ============================================================

  it('17. a refreshed cache does NOT alter an earlier buyer’s report', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const vin = track(uniqueVin('o'));

    const aliceUnlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(201);

    const before = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${aliceUnlock.body.purchaseId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const aliceOwnersBefore = before.body.payload.owners.length;

    // Expire the shared cache, then make the provider answer differently — the
    // mock is a pure function of the VIN, so a changed answer has to be forced.
    await prisma.vinHistoryReport.updateMany({
      where: { vin },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const original = await provider.fetch(vin);
    const mutated = {
      ...original,
      owners: [...original.owners, ...original.owners],
      summary: { ...original.summary, recordCount: original.summary.recordCount + 7 },
    };
    const changed = jest.spyOn(provider, 'fetch').mockResolvedValue(mutated);
    try {
      await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(201);
    } finally {
      changed.mockRestore();
    }

    // The shared cache did move on — that is by design.
    const report = await prisma.vinHistoryReport.findFirstOrThrow({ where: { vin } });
    expect(report.recordCount).toBe(original.summary.recordCount + 7);

    // Alice's report did not.
    const after = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${aliceUnlock.body.purchaseId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(after.body.payload.owners.length).toBe(aliceOwnersBefore);
    expect(after.body.payload).toEqual(before.body.payload);

    // Two buyers, two distinct artefacts — neither key can collide with the other.
    const [aliceRow, bobRow] = await Promise.all([
      prisma.vinHistoryPurchase.findUniqueOrThrow({
        where: { userId_vin: { userId: alice.userId, vin } },
      }),
      prisma.vinHistoryPurchase.findUniqueOrThrow({
        where: { userId_vin: { userId: bob.userId, vin } },
      }),
    ]);
    expect(aliceRow.payload).not.toBeNull();
    if (aliceRow.s3Key || bobRow.s3Key) {
      expect(aliceRow.s3Key).not.toBe(bobRow.s3Key);
      expect(aliceRow.s3Key).toContain(aliceRow.id);
      expect(bobRow.s3Key).toContain(bobRow.id);
    }
  });

  it('18. a purchase fulfilled before snapshots existed still reads and downloads', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('p'));
    const unlock = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    const purchaseId = unlock.body.purchaseId as string;

    // Reproduce a pre-migration row: no snapshot, only the shared report, whose
    // archive lives under the old un-versioned key.
    const legacyKey = `vin-history/mock/${vin}.json`;
    await prisma.vinHistoryPurchase.update({
      where: { id: purchaseId },
      data: { payload: Prisma.DbNull, s3Key: null },
    });
    await prisma.vinHistoryReport.updateMany({
      where: { vin },
      data: { rawS3Key: legacyKey },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${purchaseId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(detail.body.payload).toBeTruthy();
    expect(detail.body.payload.vin).toBe(vin);

    const list = await request(app.getHttpServer())
      .get('/api/v1/me/vin-checks')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(list.body.items.find((i: { id: string }) => i.id === purchaseId).synthetic).toBe(true);

    const download = await request(app.getHttpServer())
      .get(`/api/v1/me/vin-checks/${purchaseId}/download`)
      .set('Authorization', `Bearer ${user.token}`);
    // 200 through the legacy key when R2 is configured; a clean 404 when it is
    // not. What must never happen is the fallback being skipped.
    expect([200, 404]).toContain(download.status);
    if (download.status === 200) expect(download.body.url).toContain('X-Amz-Signature');
  });

  it('19. an empty provider response is refunded, not sold', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('q'));

    const original = await provider.fetch(vin);
    const empty = {
      ...original,
      owners: [],
      mileageRecords: [],
      damageRecords: [],
      registrations: [],
      inspections: [],
      recalls: [],
      summary: { ...original.summary, recordCount: 0, ownersCount: 0 },
    };

    const nothing = jest.spyOn(provider, 'fetch').mockResolvedValue(empty);
    try {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(502);
      expect(res.body.error.code).toBe('provider_failed');
      expect(res.body.error.refunded).toBe(true);
    } finally {
      nothing.mockRestore();
    }

    const purchase = await prisma.vinHistoryPurchase.findUniqueOrThrow({
      where: { userId_vin: { userId: user.userId, vin } },
    });
    expect(purchase.status).toBe('refunded');
    expect(purchase.failureReason).toContain('no usable history');
    expect(purchase.payload).toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: purchase.paymentId! } });
    expect(payment.status).toBe('refunded');
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);

    // An empty answer must not be cached: a VIN that gains a record tomorrow
    // would otherwise stay unsellable for the rest of the cache window.
    expect(await prisma.vinHistoryReport.count({ where: { vin } })).toBe(0);
  });

  it('20. a VIN that gains records after an empty answer sells on the next attempt', async () => {
    const user = await newUser();
    const vin = track(uniqueVin('r'));

    const original = await provider.fetch(vin);
    const empty = {
      ...original,
      owners: [],
      summary: { ...original.summary, recordCount: 0 },
    };

    const nothing = jest.spyOn(provider, 'fetch').mockResolvedValue(empty);
    try {
      await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(502);
    } finally {
      nothing.mockRestore();
    }

    const retry = await request(app.getHttpServer())
      .post(`/api/v1/vin-history/${vin}/unlock`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(retry.body.status).toBe('ready');

    const purchase = await prisma.vinHistoryPurchase.findUniqueOrThrow({
      where: { userId_vin: { userId: user.userId, vin } },
    });
    expect(purchase.payload).not.toBeNull();
    expect(await prisma.vinHistoryPurchase.count({ where: { userId: user.userId, vin } })).toBe(1);
  });
});
