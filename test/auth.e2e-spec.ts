import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';

function uniqueEmail(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Auth + users (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Pull the single-use link out of the notification the server sent. In
   * NODE_ENV=test the dispatch is inline, so the row exists by the time the
   * request resolves. This is the ONLY way to obtain the token now — which is
   * exactly the property SEC-1 is asserting.
   *
   * Note the `email` channel: these types deliberately produce no inapp row,
   * because GET /api/v1/notifications would then hand the live token to anyone
   * holding a session (see SECRET_BEARING_TYPES).
   */
  async function linkFromNotification(
    userId: string,
    type: 'auth.verify_email' | 'auth.password_reset',
    field: 'verifyUrl' | 'resetUrl',
  ): Promise<string> {
    const row = await prisma.notification.findFirst({
      where: { userId, type, channel: 'email' },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new Error(`no ${type} notification for ${userId}`);
    const url = (row.payload as Record<string, unknown>)[field];
    if (typeof url !== 'string') throw new Error(`${type} payload has no ${field}`);
    const token = new URL(url).searchParams.get('token');
    if (!token) throw new Error(`${field} carries no token`);
    return token;
  }

  const password = 'Sup3rSecret!';

  it('1. registers a new user and returns a token', async () => {
    const email = uniqueEmail();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Test User', gdprConsent: true })
      .expect(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe('USER');
  });

  it('2. rejects duplicate email with 409', async () => {
    const email = uniqueEmail();
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('3. rejects registration without GDPR consent', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password, gdprConsent: false })
      .expect(400);
    expect(res.body.error.code).toBe('consent_required');
  });

  it('4. rejects a weak password (< 8 chars)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'short', gdprConsent: true })
      .expect(400);
  });

  it('5. logs in with correct credentials', async () => {
    const email = uniqueEmail();
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('6. rejects a wrong password with 401', async () => {
    const email = uniqueEmail();
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass123' })
      .expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('7. rejects an unknown email with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password })
      .expect(401);
  });

  it('8. returns the profile for a valid bearer token', async () => {
    const email = uniqueEmail();
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    const res = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .expect(200);
    expect(res.body.email).toBe(email);
  });

  it('9. rejects /users/me without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('10. rejects /users/me with a malformed token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(res.body.error.code).toBe('invalid_token');
  });

  it('11. updates the profile', async () => {
    const email = uniqueEmail();
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    const res = await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'Renamed', locale: 'en' })
      .expect(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.locale).toBe('en');
  });

  it('12. leaves legacy mobile routes unguarded (GET /catalog)', async () => {
    await request(app.getHttpServer()).get('/catalog').expect(200);
  });

  it('12b. exposes GET /api/v1/settings/public without a token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings/public')
      .expect(200);
    expect(res.body.payPerViewPriceEur).toBe(14.99);
    expect(res.body.platformFeePercent).toBeUndefined(); // not in public subset
  });

  it('13. erases the account (GDPR) and blocks subsequent login', async () => {
    const email = uniqueEmail();
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, gdprConsent: true })
      .expect(201);
    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(401);

    // H3: the still-valid (30-day) token MUST be rejected at request time now
    // that the account is erased — request-time enforcement, not just at login.
    const reused = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .expect(401);
    expect(reused.body.error.code).toBe('unauthorized');
  });

  // ------------------------------------------------------------------
  // SEC-1 — single-use auth tokens must never travel on the response
  // ------------------------------------------------------------------

  describe('SEC-1: verification and reset tokens', () => {
    it('14. register does not return the email-verification token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password, gdprConsent: true })
        .expect(201);

      expect(res.body.emailVerification).toBeUndefined();
      expect(Object.keys(res.body).sort()).toEqual(['token', 'user']);
      // Belt and braces: no 64-hex token anywhere in the serialized body.
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('15. password-reset answers identically for known and unknown emails', async () => {
      const known = uniqueEmail();
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: known, password, gdprConsent: true })
        .expect(201);

      const hit = await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email: known })
        .expect(200);
      const miss = await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email: uniqueEmail() })
        .expect(200);

      // No account-existence oracle: the bodies must be indistinguishable.
      expect(hit.body).toEqual({ ok: true });
      expect(hit.body).toEqual(miss.body);
      expect(hit.body.reset).toBeUndefined();
    });

    it('16. an unknown email mints no reset token at all', async () => {
      const before = await prisma.verificationToken.count({ where: { purpose: 'password_reset' } });
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email: uniqueEmail() })
        .expect(200);
      const after = await prisma.verificationToken.count({ where: { purpose: 'password_reset' } });
      expect(after).toBe(before);
    });

    it('17. the reset link still works end to end via the notification', async () => {
      const email = uniqueEmail();
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, gdprConsent: true })
        .expect(201);
      const userId = reg.body.user.id as string;

      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email })
        .expect(200);

      const token = await linkFromNotification(userId, 'auth.password_reset', 'resetUrl');
      const newPassword = 'Ev3nMoreSecret!';
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token, password: newPassword })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: newPassword })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(401);
    });

    it('17b. the reset link is not readable through GET /notifications', async () => {
      const email = uniqueEmail();
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, gdprConsent: true })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email })
        .expect(200);

      // A live single-use credential must never be reachable from a session:
      // otherwise a borrowed session becomes a permanent account takeover.
      const list = await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${reg.body.token}`)
        .expect(200);

      const serialized = JSON.stringify(list.body);
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
      expect(serialized).not.toContain('resetUrl');
      expect(serialized).not.toContain('verifyUrl');
      expect(
        (list.body.items as Array<{ type: string }>).some((i) => i.type.startsWith('auth.')),
      ).toBe(false);
    });

    it('18. the verification link still works end to end via the notification', async () => {
      const email = uniqueEmail();
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, gdprConsent: true })
        .expect(201);
      const userId = reg.body.user.id as string;

      const token = await linkFromNotification(userId, 'auth.verify_email', 'verifyUrl');
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token })
        .expect(200);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.emailVerified).toBeInstanceOf(Date);

      // Single use: replaying the same token is refused.
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token })
        .expect(400);
    });
  });
});
