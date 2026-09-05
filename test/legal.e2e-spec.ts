import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('Legal (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /legal returns a JSON index of privacy + terms URLs in 3 languages', async () => {
    const res = await request(app.getHttpServer()).get('/legal').expect(200);
    expect(res.body.privacy).toBeDefined();
    expect(res.body.terms).toBeDefined();
    for (const lang of ['de', 'en', 'ru']) {
      expect(res.body.privacy[lang]).toContain(`lang=${lang}`);
      expect(res.body.terms[lang]).toContain(`lang=${lang}`);
    }
    expect(res.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('GET /legal/privacy?lang=en returns HTML stating permanent photo retention', async () => {
    const res = await request(app.getHttpServer()).get('/legal/privacy?lang=en').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/<!DOCTYPE html>/i);
    expect(res.text.toLowerCase()).toContain('privacy policy');
    expect(res.text.toLowerCase()).toMatch(/permanent|forever/);
    expect(res.text).toContain('X-Device-Id');
  });

  it('GET /legal/privacy?lang=de returns German HTML', async () => {
    const res = await request(app.getHttpServer()).get('/legal/privacy?lang=de').expect(200);
    expect(res.text).toContain('Datenschutz');
    expect(res.text).toMatch(/dauerhaft|für immer/);
  });

  it('GET /legal/privacy?lang=ru returns Russian HTML', async () => {
    const res = await request(app.getHttpServer()).get('/legal/privacy?lang=ru').expect(200);
    expect(res.text).toMatch(/Политика конфиденциальности/);
  });

  it('GET /legal/terms?lang=en returns Terms HTML', async () => {
    const res = await request(app.getHttpServer()).get('/legal/terms?lang=en').expect(200);
    expect(res.text.toLowerCase()).toContain('terms of use');
  });

  /*
   * ENGLISH, and not German, since 2026-08-19.
   *
   * `resolveLang` fell back to `'de'` while the mobile app sent a raw language
   * code, so a Greek phone asking `?lang=el` matched nothing and read the
   * privacy policy in German. Thirty-one of the thirty-five locales did. The
   * fallback of a document nobody can read must at least be the language most
   * readers have some of, and that is not the language of one market.
   *
   * This assertion kept the old expectation and therefore failed against the
   * correct behaviour. It asserts the ENGLISH title and, explicitly, that the
   * German one is absent - a document that somehow served both would satisfy a
   * one-sided check.
   */
  it('falls back to English when lang is unknown', async () => {
    const res = await request(app.getHttpServer()).get('/legal/privacy?lang=zz').expect(200);
    expect(res.text.toLowerCase()).toContain('privacy policy');
    expect(res.text).not.toContain('Datenschutz');
  });

  it('honours Accept-Language when no query param is given', async () => {
    const res = await request(app.getHttpServer())
      .get('/legal/privacy')
      .set('Accept-Language', 'en-US,en;q=0.9')
      .expect(200);
    expect(res.text.toLowerCase()).toContain('privacy policy');
  });
});
