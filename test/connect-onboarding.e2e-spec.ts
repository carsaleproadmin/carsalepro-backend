import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeStripeService } from './helpers/fake-stripe';
import { createTestApp } from './helpers/test-app';

/**
 * Stripe Connect onboarding — WHO may register, and where.
 *
 * `createConnectedAccount` sent `country: 'DE'` and `business_type:
 * 'individual'` as literals until 2026-08-19. The effect was not a missing
 * feature but a closed door: a company anywhere, and any inspector outside
 * Germany, could not be paid out at all — and nothing said so. Express
 * onboarding does not offer the company form to an account that already
 * declares itself a natural person, so the applicant could not even describe
 * their own business.
 *
 * Everything here runs with Stripe **reporting itself as configured**
 * ({@link FakeStripeService}), because the whole Connect path lives behind
 * `if (this.stripe.configured)` and `NODE_ENV=test` forces the real service into
 * mock mode. The fake records the two account properties this platform chooses,
 * so a test can assert "onboarded in Poland as a company" rather than assert
 * that a call was made.
 *
 * The rule with teeth is the COUNTRY LOCK: Stripe fixes an account's country at
 * creation and has no API to change it. A second request naming another country
 * is therefore refused (409) rather than honoured or ignored — ignoring it is the
 * failure that stays invisible for weeks, until the documents an inspector
 * submitted turn out to belong to a country their account is not in.
 */
describe('Stripe Connect onboarding: any country, any business type (e2e, Stripe configured)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stripe = new FakeStripeService();

  const createdUserIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp([{ token: StripeService, useValue: stripe }]);
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdUserIds.clear();
    // Accounts, queued failures AND the call log: a case below asserts that
    // exactly one account was created, which a leaked counter would break.
    stripe.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerInspector(): Promise<{ token: string; userId: string }> {
    const email = `connect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
      .expect(201);
    const userId = res.body.user.id as string;
    createdUserIds.add(userId);
    return { token: res.body.token as string, userId };
  }

  function onboard(token: string, body?: Record<string, unknown>) {
    const req = request(app.getHttpServer())
      .post('/api/v1/inspector/stripe-onboarding')
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? req.send() : req.send(body);
  }

  /** The account the service just created for this inspector, as Stripe sees it. */
  async function accountOf(userId: string) {
    const profile = await prisma.inspectorProfile.findUnique({ where: { userId } });
    expect(profile?.stripeAccountId).toBeTruthy();
    const account = stripe.accountSnapshot(profile!.stripeAccountId!);
    expect(account).toBeTruthy();
    return { profile: profile!, account: account! };
  }

  // ============================================================
  // 1. A company outside Germany — the case that was impossible
  // ============================================================
  it('1. onboards a Polish company: the account carries PL + company, and so does the profile', async () => {
    const u = await registerInspector();

    const res = await onboard(u.token, { country: 'PL', businessType: 'company' }).expect(200);

    expect(res.body.country).toBe('PL');
    expect(res.body.businessType).toBe('company');
    expect(typeof res.body.accountLinkUrl).toBe('string');

    const { profile, account } = await accountOf(u.userId);
    expect(account.country).toBe('PL');
    expect(account.business_type).toBe('company');
    // Stored in the same statement as the account id: a country recorded next to
    // a different account is worse than none, because the lock trusts it.
    expect(profile.stripeCountry).toBe('PL');
    expect(profile.stripeBusinessType).toBe('company');
  });

  // ============================================================
  // 2. A lower-case code is a code
  // ============================================================
  it('2. accepts a lower-case country and sends it upper case (Stripe rejects lower case)', async () => {
    const u = await registerInspector();

    const res = await onboard(u.token, { country: 'ee' }).expect(200);

    expect(res.body.country).toBe('EE');
    expect((await accountOf(u.userId)).account.country).toBe('EE');
  });

  // ============================================================
  // 3. Saying nothing must keep working — and must not guess
  // ============================================================
  it('3. an empty body lands in the platform country with NO business_type, so Express asks', async () => {
    const u = await registerInspector();

    const res = await onboard(u.token).expect(200);

    expect(res.body.country).toBe('DE');
    expect(res.body.businessType).toBeNull();
    const { account, profile } = await accountOf(u.userId);
    expect(account.country).toBe('DE');
    // Absent, not 'individual'. A guess produces an onboarding form the
    // applicant cannot complete truthfully.
    expect(account.business_type).toBeNull();
    expect(profile.stripeBusinessType).toBeNull();
  });

  // ============================================================
  // 4. All four Stripe business types
  // ============================================================
  it.each(['individual', 'company', 'non_profit', 'government_entity'])(
    '4. onboards a %s',
    async (businessType) => {
      const u = await registerInspector();

      const res = await onboard(u.token, { businessType }).expect(200);

      expect(res.body.businessType).toBe(businessType);
      expect((await accountOf(u.userId)).account.business_type).toBe(businessType);
    },
  );

  // ============================================================
  // 5. The country lock
  // ============================================================
  it('5. refuses a second country with 409 connect_country_locked, naming the stored one', async () => {
    const u = await registerInspector();
    await onboard(u.token, { country: 'AT' }).expect(200);
    const before = await accountOf(u.userId);

    const res = await onboard(u.token, { country: 'FR' }).expect(409);

    expect(res.body.error.code).toBe('connect_country_locked');
    expect(res.body.error.storedCountry).toBe('AT');
    expect(res.body.error.requestedCountry).toBe('FR');
    // Nothing moved: same account, same country, and no second account created.
    const after = await accountOf(u.userId);
    expect(after.profile.stripeAccountId).toBe(before.profile.stripeAccountId);
    expect(after.account.country).toBe('AT');
    expect(stripe.countCalls('createConnectedAccount')).toBe(1);
  });

  it('5b. resuming with the same country is fine and reuses the account', async () => {
    const u = await registerInspector();
    await onboard(u.token, { country: 'AT' }).expect(200);
    const first = await accountOf(u.userId);

    await onboard(u.token, { country: 'at' }).expect(200);

    expect((await accountOf(u.userId)).profile.stripeAccountId).toBe(first.profile.stripeAccountId);
  });

  // ============================================================
  // 6. Changing the legal form before verification
  // ============================================================
  it('6. a later business type reaches Stripe and is stored', async () => {
    const u = await registerInspector();
    await onboard(u.token, { country: 'DE', businessType: 'individual' }).expect(200);

    const res = await onboard(u.token, { businessType: 'company' }).expect(200);

    expect(res.body.businessType).toBe('company');
    const { account, profile } = await accountOf(u.userId);
    expect(account.business_type).toBe('company');
    expect(profile.stripeBusinessType).toBe('company');
  });

  /*
   * Stripe refuses the change once the declaration has been verified. That must
   * not abort onboarding: the account exists and the link the inspector asked for
   * is still the right answer. And our column must keep describing the account as
   * it actually is — a profile claiming a legal form the account does not carry is
   * a disagreement nobody notices until a payout is held.
   */
  it('6b. a refused business-type change does not break onboarding and does not get stored', async () => {
    const u = await registerInspector();
    await onboard(u.token, { country: 'DE', businessType: 'individual' }).expect(200);
    stripe.failNext('updateConnectedAccountBusinessType', {
      type: 'StripeInvalidRequestError',
      code: 'account_invalid',
      message: 'business_type cannot be changed after verification',
      statusCode: 400,
    });

    const res = await onboard(u.token, { businessType: 'company' }).expect(200);

    expect(typeof res.body.accountLinkUrl).toBe('string');
    const { account, profile } = await accountOf(u.userId);
    expect(account.business_type).toBe('individual');
    expect(profile.stripeBusinessType).toBe('individual');
  });

  // ============================================================
  // 7. Shapes the API refuses before Stripe is touched
  // ============================================================
  it.each([
    ['DEU', 'a three-letter country'],
    ['D', 'a one-letter country'],
  ])('7. refuses %s (%s) with 400 and never calls Stripe', async (country) => {
    const u = await registerInspector();

    await onboard(u.token, { country }).expect(400);

    expect(stripe.countCalls('createConnectedAccount')).toBe(0);
  });

  it('7b. refuses a business type Stripe does not have', async () => {
    const u = await registerInspector();

    await onboard(u.token, { businessType: 'freelancer' }).expect(400);
  });

  // ============================================================
  // 8. Stripe refusing the country is the inspector's to act on
  // ============================================================
  it('8. maps a country rejection onto connect_country_unsupported, naming the country', async () => {
    const u = await registerInspector();
    stripe.failNext('createConnectedAccount', {
      type: 'StripeInvalidRequestError',
      code: 'parameter_invalid_string_empty',
      message: 'Invalid country: this platform is not able to create accounts in KE',
      statusCode: 400,
    });

    const res = await onboard(u.token, { country: 'KE' }).expect(400);

    expect(res.body.error.code).toBe('connect_country_unsupported');
    expect(res.body.error.country).toBe('KE');
    expect(res.body.error.message).toContain('KE');
    // No account, so a retry with another country is still open to them.
    const profile = await prisma.inspectorProfile.findUnique({ where: { userId: u.userId } });
    expect(profile?.stripeAccountId).toBeNull();
    expect(profile?.stripeCountry).toBeNull();
  });

  // ============================================================
  // 9. The self-heal must not relocate anyone
  // ============================================================
  it('9. recreating a deleted account keeps its country and legal form', async () => {
    const u = await registerInspector();
    await onboard(u.token, { country: 'ES', businessType: 'company' }).expect(200);
    const first = await accountOf(u.userId);
    // "Deleted in the dashboard, or the key was swapped between live and test."
    stripe.deleteAccount(first.profile.stripeAccountId!);

    const res = await onboard(u.token).expect(200);

    expect(res.body.country).toBe('ES');
    const { account, profile } = await accountOf(u.userId);
    expect(profile.stripeAccountId).not.toBe(first.profile.stripeAccountId);
    expect(account.country).toBe('ES');
    expect(account.business_type).toBe('company');
    expect(profile.stripeCountry).toBe('ES');
  });

  // ============================================================
  // 10. What the UI reads back
  // ============================================================
  it('10. onboarding-status reports the country and legal form of the account', async () => {
    const u = await registerInspector();

    const before = await request(app.getHttpServer())
      .get('/api/v1/inspector/onboarding-status')
      .set('Authorization', `Bearer ${u.token}`)
      .expect(200);
    expect(before.body.stripeCountry).toBeNull();
    expect(before.body.stripeBusinessType).toBeNull();

    await onboard(u.token, { country: 'IT', businessType: 'non_profit' }).expect(200);

    const after = await request(app.getHttpServer())
      .get('/api/v1/inspector/onboarding-status')
      .set('Authorization', `Bearer ${u.token}`)
      .expect(200);
    expect(after.body.hasAccount).toBe(true);
    expect(after.body.stripeCountry).toBe('IT');
    expect(after.body.stripeBusinessType).toBe('non_profit');
  });
});
