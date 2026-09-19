import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';

/*
 * DEN-323. The profile answers WHERE the base is, not only whether it exists.
 *
 * `hasLocation: boolean` was all the profile sent, so the website drew its map
 * with an empty marker although the address fields were full - the pin appeared
 * only after the inspector picked the address a second time. A boolean cannot
 * draw a point, and the column is PostGIS, so nothing else in the API could
 * answer the question either.
 *
 * The two cases are asserted together on purpose: a location that is absent
 * must give null and never 0, because 0/0 is a real place in the Gulf of
 * Guinea and a map cannot tell an invented pin from a true one.
 */

const LAT = 52.527523;
const LNG = 13.415322;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Inspector profile base location (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const userIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    const users = [...userIds];
    if (users.length) {
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: users } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    userIds.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(prefix: string): Promise<{ token: string; userId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: 'Sup3rSecret9', gdprConsent: true })
      .expect(201);
    userIds.add(res.body.user.id);
    return { token: res.body.token, userId: res.body.user.id };
  }

  async function createProfile(userId: string): Promise<void> {
    await prisma.inspectorProfile.create({
      data: {
        userId,
        companyName: 'KFZ Test GmbH',
        baseAddress: 'Torstraße 1, 10119 Berlin',
        searchRadiusKm: 300,
        available: true,
      },
    });
  }

  it('sends the coordinates of the base location', async () => {
    const insp = await register('insp');
    await createProfile(insp.userId);
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${LNG}, ${LAT}), 4326)::geography
      WHERE user_id = ${insp.userId}
    `;

    const res = await request(app.getHttpServer())
      .get('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${insp.token}`)
      .expect(200);

    expect(res.body.hasLocation).toBe(true);
    // PostGIS stores a float, so compare to the precision a map needs.
    expect(res.body.lat).toBeCloseTo(LAT, 6);
    expect(res.body.lng).toBeCloseTo(LNG, 6);
  });

  it('sends null for both when no base location is set', async () => {
    const insp = await register('insp');
    await createProfile(insp.userId);

    const res = await request(app.getHttpServer())
      .get('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${insp.token}`)
      .expect(200);

    expect(res.body.hasLocation).toBe(false);
    expect(res.body.lat).toBeNull();
    expect(res.body.lng).toBeNull();
  });
});
