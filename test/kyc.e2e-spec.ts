import { INestApplication } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import request from 'supertest';
import { KycService } from '../src/kyc/kyc.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';
import { createTestApp } from './helpers/test-app';

const PASSWORD = 'Sup3rSecret!';

function uniqueEmail(prefix = 'kyc'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

async function registerUser(app: INestApplication, prefix = 'kyc'): Promise<Registered> {
  const email = uniqueEmail(prefix);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

/** Register a user, promote to ADMIN in the DB, then log in so the JWT carries role=ADMIN. */
async function makeAdmin(app: INestApplication, prisma: PrismaService): Promise<Registered> {
  const u = await registerUser(app, 'kyc-admin');
  await prisma.user.update({ where: { id: u.userId }, data: { role: 'ADMIN' } });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: u.email, password: PASSWORD })
    .expect(200);
  return { token: res.body.token as string, userId: u.userId, email: u.email };
}

describe('KYC verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let r2Configured: boolean;

  const createdUserIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    r2Configured = app.get(R2Service).isConfigured();
  });

  afterEach(async () => {
    const userIds = [...createdUserIds];
    if (userIds.length) {
      const apps = await prisma.kycApplication.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const appIds = apps.map((a) => a.id);
      if (appIds.length) {
        await prisma.kycDocument.deleteMany({ where: { applicationId: { in: appIds } } });
        await prisma.kycApplication.deleteMany({ where: { id: { in: appIds } } });
      }
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdUserIds.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeUser(): Promise<Registered> {
    const u = await registerUser(app);
    createdUserIds.add(u.userId);
    return u;
  }

  async function makeAdminUser(): Promise<Registered> {
    const u = await makeAdmin(app, prisma);
    createdUserIds.add(u.userId);
    return u;
  }

  /** Create a DRAFT application and upload all required (+optional) docs. */
  async function createWithDocs(
    user: Registered,
    kinds: string[] = ['id_front', 'id_back', 'selfie', 'gewerbeschein'],
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    const appId = created.body.id as string;
    for (const kind of kinds) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/documents`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ kind, contentType: 'image/jpeg' });
      expect([200, 201, 503]).toContain(res.status);
    }
    return appId;
  }

  it('1. POST /applications creates a DRAFT; a second call returns the same application', async () => {
    const user = await makeUser();
    const first = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(first.body.status).toBe('DRAFT');
    expect(Array.isArray(first.body.documents)).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(second.body.id).toBe(first.body.id);

    const count = await prisma.kycApplication.count({ where: { userId: user.userId } });
    expect(count).toBe(1);
  });

  it('2. POST documents for each kind reserves a URL + creates rows; re-upload replaces', async () => {
    const user = await makeUser();
    const created = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    const appId = created.body.id as string;

    const kinds = ['id_front', 'id_back', 'selfie', 'gewerbeschein', 'insurance'];
    const firstKeys: Record<string, string> = {};
    for (const kind of kinds) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/documents`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ kind });
      if (r2Configured) {
        expect(res.status).toBe(201);
        expect(typeof res.body.presignedUploadUrl).toBe('string');
        expect(typeof res.body.expiresAt).toBe('string');
      } else {
        expect(res.status).toBe(503);
      }
      // The row + s3Key is recorded regardless of R2 state.
      const doc = await prisma.kycDocument.findFirst({ where: { applicationId: appId, kind } });
      expect(doc).toBeTruthy();
      expect(doc!.s3Key).toContain(`kyc/${user.userId}/${appId}/${kind}-`);
      firstKeys[kind] = doc!.s3Key;
    }

    const docCount = await prisma.kycDocument.count({ where: { applicationId: appId } });
    expect(docCount).toBe(5);

    // Re-upload id_front → still one row for that kind, new s3Key.
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ kind: 'id_front' });
    const idFrontRows = await prisma.kycDocument.findMany({
      where: { applicationId: appId, kind: 'id_front' },
    });
    expect(idFrontRows.length).toBe(1);
    expect(idFrontRows[0].s3Key).not.toBe(firstKeys['id_front']);
    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(5);
  });

  it('3. submit without all required docs returns 400 incomplete_kyc', async () => {
    const user = await makeUser();
    const appId = await createWithDocs(user, ['id_front', 'selfie']); // missing id_back + gewerbeschein
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(400);
    expect(res.body.error.code).toBe('incomplete_kyc');
  });

  it('4. submit with all required docs transitions to SUBMITTED', async () => {
    const user = await makeUser();
    const appId = await createWithDocs(user);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(res.body.status).toBe('SUBMITTED');
    expect(typeof res.body.submittedAt).toBe('string');

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.SUBMITTED);
    expect(dbApp!.submittedAt).toBeTruthy();
  });

  it('5. GET /applications/me returns status + doc kinds, NOT raw s3Keys', async () => {
    const user = await makeUser();
    const appId = await createWithDocs(user, ['id_front', 'id_back']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/kyc/applications/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.id).toBe(appId);
    expect(res.body.status).toBe('DRAFT');
    const kinds = res.body.documents.map((d: { kind: string }) => d.kind).sort();
    expect(kinds).toEqual(['id_back', 'id_front']);
    for (const d of res.body.documents) {
      expect(typeof d.uploadedAt).toBe('string');
      expect(d.s3Key).toBeUndefined();
    }
    // No s3Key anywhere in the serialized payload.
    expect(JSON.stringify(res.body)).not.toContain('kyc/');
  });

  it('6. admin GET queue lists the submitted application; non-admin gets 403', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const queue = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const item = queue.body.items.find((i: { id: string }) => i.id === appId);
    expect(item).toBeTruthy();
    expect(item.user.email).toBe(user.email);
    expect(item.documentKinds.sort()).toEqual(
      ['gewerbeschein', 'id_back', 'id_front', 'selfie'].sort(),
    );

    // Non-admin is forbidden.
    await request(app.getHttpServer())
      .get('/api/v1/admin/kyc')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
  });

  it('7. admin GET /:id returns signed view URLs (or null if R2 off) and moves SUBMITTED→IN_REVIEW', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/kyc/${appId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(res.body.status).toBe('IN_REVIEW');
    expect(res.body.documents.length).toBe(4);
    for (const d of res.body.documents) {
      if (r2Configured) {
        expect(typeof d.viewUrl).toBe('string');
        expect(typeof d.viewUrlExpiresAt).toBe('string');
        // H1: KYC documents must ALWAYS be served via a short-lived SIGNED URL,
        // never the bare public-URL shortcut. The signed URL carries an AWS
        // SigV4 signature and points at the R2 storage endpoint, not a public
        // CDN/path.
        expect(d.viewUrl).toContain('X-Amz-Signature');
        expect(d.viewUrl).toContain('X-Amz-Expires');
        expect(d.viewUrl).toContain(`kyc/${user.userId}/`);
      } else {
        expect(d.viewUrl).toBeNull();
      }
    }
    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.IN_REVIEW);
  });

  it('8. admin approve transitions to APPROVED and sets user.kycVerified=true', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);
    expect(res.body.status).toBe('APPROVED');
    expect(typeof res.body.reviewedAt).toBe('string');

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.APPROVED);
    expect(dbApp!.reviewedBy).toBe(admin.userId);
    expect(dbApp!.reviewedAt).toBeTruthy();

    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(dbUser!.kycVerified).toBe(true);
  });

  it('9. admin reject sets REJECTED + reason; the user can then create a NEW application', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    const reason = 'ID photo is blurry — please re-upload.';
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason })
      .expect(201);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectReason).toBe(reason);

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.REJECTED);
    expect(dbApp!.rejectReason).toBe(reason);

    // A rejected prior application unblocks creating a fresh one.
    const fresh = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(fresh.body.id).not.toBe(appId);
    expect(fresh.body.status).toBe('DRAFT');
  });

  it('10. illegal transitions return 409 (submit a SUBMITTED, approve an APPROVED)', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    // submit again on a SUBMITTED application → 409
    const reSubmit = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(409);
    expect(reSubmit.body.error.code).toBe('illegal_transition');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);

    // approve again on an APPROVED application → 409
    const reApprove = await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(409);
    expect(reApprove.body.error.code).toBe('illegal_transition');
  });

  it('11. purgeOldDocuments() stamps purgedAt on an old reviewed application\'s docs', async () => {
    const user = await makeUser();
    // Seed an APPROVED application reviewed 100 days ago, with 2 docs.
    const old = await prisma.kycApplication.create({
      data: {
        userId: user.userId,
        status: KycStatus.APPROVED,
        reviewedBy: user.userId,
        reviewedAt: new Date(Date.now() - 100 * 86_400_000),
        submittedAt: new Date(Date.now() - 101 * 86_400_000),
        documents: {
          create: [
            { kind: 'id_front', s3Key: `kyc/${user.userId}/old/id_front-x.bin` },
            { kind: 'selfie', s3Key: `kyc/${user.userId}/old/selfie-x.bin` },
          ],
        },
      },
      include: { documents: true },
    });

    const service = app.get(KycService);
    const purged = await service.purgeOldDocuments();
    expect(purged).toBeGreaterThanOrEqual(2);

    const docs = await prisma.kycDocument.findMany({ where: { applicationId: old.id } });
    expect(docs.length).toBe(2);
    for (const d of docs) {
      expect(d.purgedAt).toBeTruthy();
    }
  });

  it('12. uploading to a non-owned application returns 403; uploading after submit returns 400', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const appId = await createWithDocs(owner, ['id_front']);

    // stranger cannot upload to the owner's application.
    const forbidden = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ kind: 'id_back' })
      .expect(403);
    expect(forbidden.body.error.code).toBe('not_kyc_owner');

    // upload required docs + submit, then a further upload is rejected (not DRAFT).
    for (const kind of ['id_back', 'selfie', 'gewerbeschein']) {
      const r = await request(app.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/documents`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ kind });
      expect([200, 201, 503]).toContain(r.status);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    const afterSubmit = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ kind: 'insurance' })
      .expect(400);
    expect(afterSubmit.body.error.code).toBe('kyc_not_editable');
  });
});
