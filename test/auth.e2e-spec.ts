import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

function uniqueEmail(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Auth + users (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

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
  });
});
