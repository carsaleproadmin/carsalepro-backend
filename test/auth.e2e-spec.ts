import { INestApplication } from '@nestjs/common';
import { KYC_RETENTION_DAYS } from '../src/kyc/kyc.constants';
import request from 'supertest';
// The same hasher the service uses, so the seeded legacy account is one a real
// sign-in can verify.
import { hash } from '@node-rs/argon2';
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

  /*
   * Letters and digits only, since DEN-187. It held an exclamation mark, which
   * the registration rule now refuses - so the whole suite failed at the first
   * `register`. That is the rule biting, not a broken test.
   */
  const password = 'Sup3rSecret9';

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

  /*
   * DEN-187. The field rules, over the wire.
   *
   * `src/auth/auth-validation.spec.ts` proves the decorator stack; this proves
   * the PIPE is wired to it and that the codes reach a client - which is what
   * the website maps into 35 languages, and the only thing a mobile client has
   * to work with.
   */
  describe('DEN-187: the field rules', () => {
    const ok = () => ({
      email: uniqueEmail(),
      password: 'Sup3rSecret9',
      name: 'Anna Maria',
      gdprConsent: true,
    });

    it.each([
      ['a digit in the name', { name: 'Anna2' }, 'name_invalid'],
      ['punctuation in the name', { name: 'Dr. Anna' }, 'name_invalid'],
      ['a name over 100 characters', { name: 'a'.repeat(101) }, 'name_too_long'],
      ['an address with no at sign', { email: 'anna.example.com' }, 'email_invalid'],
      ['an address with no domain dot', { email: 'anna@example' }, 'email_invalid'],
      ['a password under eight', { password: 'abc1234' }, 'password_too_short'],
      ['a symbol in the password', { password: 'hunter2!' }, 'password_charset'],
    ])('refuses %s with a code the client can translate', async (_why, bad, code) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ ...ok(), ...bad })
        .expect(400);
      expect(res.body.message).toContain(code);
    });

    it.each([
      ['two words', 'Anna Maria'],
      ['a hyphen', 'Anne-Marie'],
      ['an apostrophe', "O'Brien"],
      ['Cyrillic', 'Анна Волошко'],
      ['Chinese', '李雷'],
    ])('accepts %s as a name', async (_why, name) => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ ...ok(), name })
        .expect(201);
    });

    /*
     * The one that protects existing customers. Their stored password may hold
     * a symbol or be shorter than today's floor; refusing it at sign-in would
     * lock them out of their own account with a message about character sets,
     * and no edit to the form could help.
     */
    it('lets an account whose password breaks the new rules still sign in', async () => {
      const email = uniqueEmail();
      const legacy = 'old!pw';
      await prisma.user.create({
        data: {
          email,
          passwordHash: await hash(legacy),
          gdprConsentAt: new Date(),
        },
      });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: legacy })
        .expect(200);
    });

    it('still checks the shape of the address at sign-in', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'anna.example.com', password: 'whatever' })
        .expect(400);
      expect(res.body.message).toContain('email_invalid');
    });
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

  it('12c. settings/public carries a cents price catalog that agrees with the EUR keys', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings/public')
      .expect(200);

    const { prices } = res.body;
    expect(prices.currency).toBe('EUR');
    // One source of truth: the cents block must be the EUR keys, converted.
    expect(prices.payPerViewCents).toBe(Math.round(res.body.payPerViewPriceEur * 100));
    expect(prices.goldPackageCents).toBe(Math.round(res.body.goldPackagePriceEur * 100));
    expect(prices.orderBaseFeeCents).toBe(Math.round(res.body.orderBaseFeeEur * 100));
    expect(prices.orderRatePerKmCents).toBe(Math.round(res.body.orderRatePerKmEur * 100));
    expect(prices.orderRatePerMinuteCents).toBe(
      Math.round(res.body.orderRatePerMinuteEur * 100),
    );
    expect(prices.orderMinimumFareCents).toBe(Math.round(res.body.orderMinimumFareEur * 100));

    // Operator levers stay private — publishing them would let a caller time a
    // booking around the peak window.
    expect(res.body.orderSurgeMultiplier).toBeUndefined();
    expect(res.body.orderPeakMultiplier).toBeUndefined();
    expect(res.body.orderPeakStartHour).toBeUndefined();
  });

  /*
   * The number the website prints to an applicant beside an upload control, and
   * the number the nightly purge enforces, must be ONE number. The website held
   * its own literal until 2026-09-05 and nothing compared the two.
   */
  it('12c-bis. settings/public publishes the KYC retention period', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings/public')
      .expect(200);

    expect(res.body.kycRetentionDays).toBe(KYC_RETENTION_DAYS);
    expect(typeof res.body.kycRetentionDays).toBe('number');
    expect(res.body.kycRetentionDays).toBeGreaterThan(0);
  });

  it('12d. exposes listing package prices without a token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/listings/packages')
      .expect(200);

    const settings = await request(app.getHttpServer()).get('/api/v1/settings/public');
    const gold = res.body.items.find((i: { package: string }) => i.package === 'gold');
    const standard = res.body.items.find((i: { package: string }) => i.package === 'standard');

    expect(gold.amountCents).toBe(settings.body.prices.goldPackageCents);
    expect(gold.currency).toBe('EUR');
    expect(standard.amountCents).toBe(settings.body.prices.standardListingCents);
    expect(standard.durationDays).toBe(settings.body.listingDurationDays);
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
      const newPassword = 'Ev3nMoreSecret9';
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

    /*
     * DEN-200. Asking for the letter again.
     *
     * The route is unauthenticated, because the reader who needs it is usually
     * the one who cannot get in - so every test here is really about the same
     * property: it answers the same thing to everyone, and only ever sends to
     * an address that is already registered and still unconfirmed.
     */
    it('19. a re-send delivers a SECOND working link, and the first still works', async () => {
      const email = uniqueEmail();
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, gdprConsent: true })
        .expect(201);
      const userId = reg.body.user.id as string;
      const first = await linkFromNotification(userId, 'auth.verify_email', 'verifyUrl');

      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email })
        .expect(200)
        .expect({ ok: true });

      const second = await linkFromNotification(userId, 'auth.verify_email', 'verifyUrl');
      expect(second).not.toBe(first);

      /*
       * The first link is deliberately NOT revoked. The commonest sequence
       * there is: click "send it again", then find the original letter and
       * open THAT one. Revoking on re-send breaks exactly that reader.
       */
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token: first })
        .expect(200);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.emailVerified).toBeInstanceOf(Date);
    });

    it('20. a re-send says the same thing about an unknown address as a known one', async () => {
      // Otherwise this endpoint is an account-existence oracle, and it needs no
      // credentials to ask.
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email: uniqueEmail() })
        .expect(200)
        .expect({ ok: true });
    });

    it('21. a re-send to a confirmed address sends nothing', async () => {
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

      const before = await prisma.notification.count({
        where: { userId, type: 'auth.verify_email' },
      });
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email/resend')
        .send({ email })
        .expect(200)
        .expect({ ok: true });

      // Same answer as every other case, and no second letter behind it.
      const after = await prisma.notification.count({
        where: { userId, type: 'auth.verify_email' },
      });
      expect(after).toBe(before);
    });

    it('22. the confirmation letter is in English whatever the account locale says', async () => {
      /*
       * The client's instruction (DEN-200), pinned end to end rather than at
       * the template: the locale is chosen by AuthService, and a caller that
       * stopped passing it would silently fall back to German.
       */
      const email = uniqueEmail();
      const reg = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, gdprConsent: true, locale: 'ru' })
        .expect(201);

      const row = await prisma.notification.findFirst({
        where: { userId: reg.body.user.id, type: 'auth.verify_email', channel: 'email' },
        orderBy: { createdAt: 'desc' },
      });
      const payload = row?.payload as Record<string, unknown>;
      expect(payload._title).toBe('Confirm your email address');
    });
  });
});
