import { INestApplication } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { KycService } from '../src/kyc/kyc.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';
import { createTestApp } from './helpers/test-app';

const PASSWORD = 'Sup3rSecret9';

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

/** A real PNG the backend's sharp pipeline can actually decode. */
const PNG = readFileSync(join(__dirname, 'fixtures', 'small-800x600.png'));

/**
 * A minimal but genuinely parseable PDF. KYC PDFs are stored VERBATIM, so the
 * bytes that come back out must be byte-identical to these.
 */
const PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
  'latin1',
);

/**
 * A URL that must never appear in a KYC view URL. `createPresignedDownloadUrl`
 * short-circuits to R2_PUBLIC_URL when it is set, which is right for public
 * report PDFs and would disclose every identity document if the KYC path ever
 * shared that code.
 */
const PUBLIC_URL_SENTINEL = 'https://kyc-public-leak-sentinel.example.com';

describe('KYC verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let r2: R2Service;
  let r2Configured: boolean;
  /** The bucket a NEW KycDocument row should record: the dedicated one, or NULL. */
  let expectedBucket: string | null;

  const createdUserIds = new Set<string>();
  /** Objects this suite really wrote to R2, so the bucket is left as it was found. */
  const uploadedKeys: Array<{ key: string; bucket: string | null }> = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    r2 = app.get(R2Service);
    r2Configured = r2.isConfigured();
    expectedBucket = r2.isKycDedicated() ? r2.kycBucketName : null;
  });

  afterEach(async () => {
    // Uploads are REAL now (the endpoint stores the bytes before it writes the
    // row), so the objects have to be swept as well as the rows.
    while (uploadedKeys.length) {
      const object = uploadedKeys.pop()!;
      await r2.kycDeleteObject(object.key, object.bucket).catch(() => undefined);
    }

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

  /** POST a real multipart document and remember the object for cleanup. */
  async function uploadDoc(
    user: Registered,
    appId: string,
    kind: string,
    body: Buffer = PNG,
    options: { filename?: string; contentType?: string } = {},
  ): Promise<request.Response> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents/upload`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('kind', kind)
      .attach('file', body, {
        filename: options.filename ?? 'document.png',
        contentType: options.contentType ?? 'image/png',
      });
    if (res.status === 201) {
      const doc = await prisma.kycDocument.findFirst({ where: { applicationId: appId, kind } });
      if (doc) uploadedKeys.push({ key: doc.s3Key, bucket: doc.bucket });
    }
    return res;
  }

  /**
   * Seed KycDocument rows straight through Prisma.
   *
   * ⚠ THIS USED TO BE AN API CALL, AND THE FACT THAT IT COULD BE WAS A BUG.
   * `presignDocument` wrote the row BEFORE it touched R2, so a suite (and the
   * website's Playwright harness) could bring an application to "has all four
   * documents" without a single byte ever being stored — and then submit and
   * approve it. The upload endpoint that replaced it writes the row only after
   * the object exists, which is correct and which means seeding is now a
   * database operation.
   *
   * Tests ABOUT the upload path use `uploadDoc` and store real objects. Tests
   * about the state machine, the review queue and the decisions use this: they
   * are not about storage, and making twenty R2 round-trips to assert a status
   * transition buys nothing.
   */
  async function seedDocuments(
    user: Registered,
    appId: string,
    kinds: string[] = ['id_front', 'id_back', 'selfie', 'gewerbeschein'],
    fingerprint?: (kind: string) => string,
  ): Promise<void> {
    for (const kind of kinds) {
      const sha256 = fingerprint ? fingerprint(kind) : null;
      await prisma.kycDocument.upsert({
        where: { applicationId_kind: { applicationId: appId, kind } },
        create: {
          applicationId: appId,
          kind,
          s3Key: `kyc/${user.userId}/${appId}/${kind}-seeded.jpg`,
          bucket: expectedBucket,
          sha256,
        },
        update: { s3Key: `kyc/${user.userId}/${appId}/${kind}-seeded.jpg`, sha256 },
      });
    }
  }

  /** Create a DRAFT application, seeded with the given document kinds. */
  async function createWithDocs(
    user: Registered,
    kinds: string[] = ['id_front', 'id_back', 'selfie', 'gewerbeschein'],
    fingerprint?: (kind: string) => string,
  ): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    const appId = created.body.id as string;
    await seedDocuments(user, appId, kinds, fingerprint);
    return appId;
  }

  /**
   * Put an application into SUBMITTED **directly in the database**.
   *
   * Since 2026-09-03 (DEN-236) `POST /submit` approves immediately, so no route
   * produces a SUBMITTED row any more. The admin review machinery — the queue,
   * the signed document URLs, the manual approve and reject — is deliberately
   * kept, and the only way to exercise it is to seed the state it reads.
   *
   * If a future change removes SUBMITTED entirely, these seeds are the list of
   * what has to go with it.
   */
  async function forceSubmitted(appId: string): Promise<void> {
    await prisma.kycApplication.update({
      where: { id: appId },
      data: { status: KycStatus.SUBMITTED, submittedAt: new Date(), reviewedBy: null, reviewedAt: null },
    });
  }

  /** Create a bare DRAFT application and return its id. */
  async function createApplication(user: Registered): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/v1/kyc/applications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    return created.body.id as string;
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

  it('2. multipart upload stores each kind and a re-upload REPLACES (one row, new key)', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    const kinds = ['id_front', 'id_back', 'selfie', 'gewerbeschein', 'insurance'];
    const firstKeys: Record<string, string> = {};
    for (const kind of kinds) {
      const res = await uploadDoc(user, appId, kind);
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe(kind);
      expect(res.body.contentType).toBe('image/jpeg');
      expect(res.body.replaced).toBe(false);
      expect(typeof res.body.uploadedAt).toBe('string');
      // The response must not leak where the object went.
      expect(JSON.stringify(res.body)).not.toContain('kyc/');

      const doc = await prisma.kycDocument.findFirst({ where: { applicationId: appId, kind } });
      expect(doc).toBeTruthy();
      expect(doc!.s3Key).toContain(`kyc/${user.userId}/${appId}/${kind}-`);
      // A real extension, never `.bin` — the presign path stored everything as
      // `.bin`, so a reviewer's download arrived as an unopenable blob.
      expect(doc!.s3Key.endsWith('.jpg')).toBe(true);
      expect(doc!.bucket).toBe(expectedBucket);
      firstKeys[kind] = doc!.s3Key;
    }
    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(5);

    const again = await uploadDoc(user, appId, 'id_front');
    expect(again.status).toBe(201);
    expect(again.body.replaced).toBe(true);

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

  /**
   * DEN-236. Submitting a complete application approves it on the spot, with no
   * admin involved — and the user flag that gates dispatch moves with it.
   *
   * The two assertions are one requirement: an APPROVED application whose owner
   * is not `kycVerified` grants nothing, and a `kycVerified` user with no
   * approved application has standing nobody can trace. They are written in one
   * transaction so they cannot disagree.
   */
  it('4. submit with all required docs AUTO-APPROVES and verifies the user', async () => {
    const user = await makeUser();
    const appId = await createWithDocs(user);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect(res.body.status).toBe('APPROVED');
    expect(typeof res.body.submittedAt).toBe('string');

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.APPROVED);
    expect(dbApp!.submittedAt).toBeTruthy();
    // Both stamped, and by the platform rather than by a person. `reviewedBy`
    // is the only record of WHO decided; a null here would make an automatic
    // grant indistinguishable from an unreviewed one.
    expect(dbApp!.reviewedAt).toBeTruthy();
    expect(dbApp!.reviewedBy).toBe('auto');

    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(dbUser!.kycVerified).toBe(true);
  });

  /**
   * The incomplete case is the ONLY thing still standing between an upload and
   * a verified inspector, so it is asserted from the user's side too: a refused
   * submit must not verify anybody.
   */
  it('4b. an incomplete submit verifies nobody', async () => {
    const user = await makeUser();
    const appId = await createWithDocs(user, ['id_front', 'selfie']);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(400);

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.DRAFT);
    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(dbUser!.kycVerified).toBe(false);
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
    await forceSubmitted(appId);

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
    await forceSubmitted(appId);

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
        // H2: signed against whichever bucket the row records. R2 presigns in
        // virtual-host style, so the bucket is the leading host label.
        expect(d.viewUrl).toContain(`//${r2.kycBucketName}.`);
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
    await forceSubmitted(appId);

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
    await forceSubmitted(appId);

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

  /**
   * DEN-236. The queue must show APPROVED applications, or the revocation path
   * exists in the API and nowhere a person can reach it.
   *
   * This is asserted through the auto-approval route rather than a seeded row,
   * because the pairing is the requirement: what `POST /submit` produces has to
   * be what `GET /admin/kyc` lists. Seeding the status would pass even if the
   * two disagreed about which state an approved applicant lands in.
   */
  it('6b. the default queue lists AUTO-APPROVED applications and says who decided', async () => {
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
    expect(item.status).toBe('APPROVED');
    // The distinction an admin acts on: nobody read these documents.
    expect(item.reviewedBy).toBe('auto');
    expect(typeof item.reviewedAt).toBe('string');
  });

  /**
   * The queue was unbounded, which was safe while it held only applications
   * awaiting review. It now holds every approved inspector, so an unbounded read
   * grows with the platform for ever.
   */
  it('6c. the queue is bounded and the bound is a request parameter', async () => {
    const admin = await makeAdminUser();
    for (let i = 0; i < 3; i += 1) {
      const user = await makeUser();
      const appId = await createWithDocs(user);
      await request(app.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/submit`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);
    }

    const limited = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc?limit=2')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(limited.body.items.length).toBe(2);

    // Out of range is refused rather than silently clamped: a caller asking for
    // 10 000 rows has misunderstood something, and answering 500 of them hides it.
    await request(app.getHttpServer())
      .get('/api/v1/admin/kyc?limit=10000')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);
  });

  /**
   * DEN-236, the other half of automatic approval: it must be revocable.
   *
   * Approval is now granted on the strength of four files existing, so the
   * platform will sometimes have verified somebody it should not have. Before
   * this change `APPROVED` was terminal and `reject` never touched the user
   * flag — an unwanted inspector could not be switched off through the API at
   * all. The assertion that matters is the LAST one: the flag, not the
   * application's label, is what `eligibleForOffers` and the dispatch filter
   * read.
   */
  /**
   * DEN-239 / review item K-3. The queue holds every approved inspector now, so
   * the row an admin needs is often not on the first page. Without a total and
   * a way to search, a truncated answer is indistinguishable from a complete
   * one, and an inspector who is not recent cannot be reached at all.
   */
  it('6d. the queue says how many rows match, pages, and finds an applicant', async () => {
    const admin = await makeAdminUser();
    const users = [];
    for (let i = 0; i < 3; i += 1) {
      const user = await makeUser();
      const appId = await createWithDocs(user);
      await request(app.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/submit`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);
      users.push(user);
    }

    const all = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc?status=APPROVED')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(3);

    // A page is smaller than the set, and the total keeps describing the set.
    const page = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc?status=APPROVED&limit=2')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(all.body.total);

    const second = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc?status=APPROVED&limit=2&offset=2')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const firstIds = page.body.items.map((i: { id: string }) => i.id);
    for (const item of second.body.items as { id: string }[]) {
      expect(firstIds).not.toContain(item.id);
    }

    // The applicant is reachable by who they are, in any case.
    const target = users[0];
    const found = await request(app.getHttpServer())
      .get(`/api/v1/admin/kyc?q=${encodeURIComponent(target.email.toUpperCase())}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(found.body.total).toBe(1);
    expect(found.body.items[0].user.email).toBe(target.email);
  });

  it('9b. an auto-approved inspector can be revoked, and the flag really clears', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);

    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    expect((await prisma.user.findUnique({ where: { id: user.userId } }))!.kycVerified).toBe(true);

    const reason = 'Documents do not show the applicant.';
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason })
      .expect(201);
    expect(res.body.status).toBe('REJECTED');

    const dbApp = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(dbApp!.status).toBe(KycStatus.REJECTED);
    expect(dbApp!.rejectReason).toBe(reason);
    // `reviewedBy` moves from 'auto' to the admin who intervened, which is the
    // whole point of keeping the two distinguishable.
    expect(dbApp!.reviewedBy).toBe(admin.userId);

    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(dbUser!.kycVerified).toBe(false);
  });

  /**
   * DEN-239. This is the test that the revocation work depends on.
   *
   * Without it the whole APPROVED→REJECTED path is decorative: the applicant
   * simply applies again and the platform approves them again, so the admin's
   * decision holds only until the person it was used against notices.
   */
  it('9c. a revoked inspector who re-applies is HELD for a person, not auto-approved', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const firstId = await createWithDocs(user);

    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${firstId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${firstId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Documents do not show the applicant.' })
      .expect(201);
    expect((await prisma.user.findUnique({ where: { id: user.userId } }))!.kycVerified).toBe(false);

    // The same four files again, exactly as the applicant would send them.
    const secondId = await createWithDocs(user);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${secondId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);

    expect(res.body.status).toBe('SUBMITTED');
    const second = await prisma.kycApplication.findUnique({ where: { id: secondId } });
    expect(second!.status).toBe(KycStatus.SUBMITTED);
    expect(second!.reviewedBy).toBeNull();
    expect(second!.submittedAt).not.toBeNull();
    // The access stays off until an admin says otherwise.
    expect((await prisma.user.findUnique({ where: { id: user.userId } }))!.kycVerified).toBe(false);

    // And the held application is where an admin will find it.
    const queue = await request(app.getHttpServer())
      .get('/api/v1/admin/kyc')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toContain(secondId);

    // An admin can still let them back in, and that grant is a person's.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${secondId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);
    const decided = await prisma.kycApplication.findUnique({ where: { id: secondId } });
    expect(decided!.reviewedBy).toBe(admin.userId);
    expect((await prisma.user.findUnique({ where: { id: user.userId } }))!.kycVerified).toBe(true);
  });

  /**
   * DEN-249. The check above is keyed by `user_id`. This is the same person
   * with a second account, which is what makes the per-user check insufficient
   * on its own: to THAT count a new registration is a first-time applicant.
   */
  it('9e. the same documents on a NEW account are held too, and the old account is not needed', async () => {
    const revoked = await makeUser();
    const admin = await makeAdminUser();
    const files = (kind: string) => `de1249${kind.padEnd(20, '0')}`.padEnd(64, 'f');

    const firstId = await createWithDocs(revoked, undefined, files);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${firstId}/submit`)
      .set('Authorization', `Bearer ${revoked.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${firstId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Access revoked.' })
      .expect(201);

    // A different account. It has no history of its own at all.
    const freshAccount = await makeUser();
    const secondId = await createWithDocs(freshAccount, undefined, files);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${secondId}/submit`)
      .set('Authorization', `Bearer ${freshAccount.token}`)
      .expect(201);

    expect(res.body.status).toBe('SUBMITTED');
    const second = await prisma.kycApplication.findUnique({ where: { id: secondId } });
    expect(second!.status).toBe(KycStatus.SUBMITTED);
    expect(second!.reviewedBy).toBeNull();
    expect(
      (await prisma.user.findUnique({ where: { id: freshAccount.userId } }))!.kycVerified,
    ).toBe(false);

    // The audit row says WHICH check held it: the account is clean, the files
    // are not.
    const audit = await prisma.adminAuditLog.findFirst({
      where: { entity: 'kyc', entityId: secondId, action: 'kyc.held_for_review' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const held = audit!.after as { priorRejections: number; reusedDocuments: number };
    expect(held.priorRejections).toBe(0);
    expect(held.reusedDocuments).toBeGreaterThan(0);

    // And an admin can still let them in — a hold is not a ban.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${secondId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);
    expect(
      (await prisma.user.findUnique({ where: { id: freshAccount.userId } }))!.kycVerified,
    ).toBe(true);
  });

  it('9f. different documents on a new account are auto-approved, and old rows without a hash match nobody', async () => {
    const rejected = await makeUser();
    const admin = await makeAdminUser();

    // Documents recorded before DEN-249 have no fingerprint at all.
    const legacyId = await createWithDocs(rejected);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${legacyId}/submit`)
      .set('Authorization', `Bearer ${rejected.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${legacyId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Access revoked.' })
      .expect(201);

    // An unrelated applicant with their own papers. A NULL hash on the
    // rejected rows must not read as "matches everything".
    const stranger = await makeUser();
    const ownId = await createWithDocs(
      stranger,
      undefined,
      (kind) => `de1249own${kind.padEnd(17, '0')}`.padEnd(64, 'a'),
    );
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${ownId}/submit`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(201);

    expect(res.body.status).toBe('APPROVED');
    expect((await prisma.user.findUnique({ where: { id: stranger.userId } }))!.kycVerified).toBe(
      true,
    );
  });

  /**
   * K-6. `reviewedBy` holds the LAST decision, thus a revocation erases the
   * machine approval that came before it. The audit trail is append-only and
   * is the only place both survive.
   */
  it('9d. every KYC decision leaves an audit row, the automatic one included', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);

    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/kyc/${appId}/reject`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Documents do not show the applicant.' })
      .expect(201);

    const rows = await prisma.adminAuditLog.findMany({
      where: { entity: 'kyc', entityId: appId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['kyc.auto_approve', 'kyc.reject']);
    // The machine approval is still readable after the revocation overwrote
    // `reviewedBy` - that is the whole point of the row.
    expect(rows[0].adminId).toBe('auto');
    expect(rows[1].adminId).toBe(admin.userId);
    expect((rows[1].after as { previousStatus?: string }).previousStatus).toBe('APPROVED');
    const current = await prisma.kycApplication.findUnique({ where: { id: appId } });
    expect(current!.reviewedBy).toBe(admin.userId);
  });

  it('10. illegal transitions return 409 (submit a SUBMITTED, approve an APPROVED)', async () => {
    const user = await makeUser();
    const admin = await makeAdminUser();
    const appId = await createWithDocs(user);
    await forceSubmitted(appId);

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
    if (!r2Configured) return;
    const owner = await makeUser();
    const stranger = await makeUser();
    const appId = await createApplication(owner);
    expect((await uploadDoc(owner, appId, 'id_front')).status).toBe(201);

    // A stranger cannot upload to the owner's application — and, because
    // ownership is checked FIRST, nothing is stored and no row appears.
    const forbidden = await uploadDoc(stranger, appId, 'id_back');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('not_kyc_owner');
    expect(
      await prisma.kycDocument.count({ where: { applicationId: appId, kind: 'id_back' } }),
    ).toBe(0);

    await seedDocuments(owner, appId, ['id_back', 'selfie', 'gewerbeschein']);
    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/submit`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    const afterSubmit = await uploadDoc(owner, appId, 'insurance');
    expect(afterSubmit.status).toBe(400);
    expect(afterSubmit.body.error.code).toBe('kyc_not_editable');
    expect(
      await prisma.kycDocument.count({ where: { applicationId: appId, kind: 'insurance' } }),
    ).toBe(0);
  });

  it('13. H2: the stored object lands in the KYC bucket and is readable only via a signed URL', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    const res = await uploadDoc(user, appId, 'id_front');
    expect(res.status).toBe(201);

    const doc = await prisma.kycDocument.findFirst({ where: { applicationId: appId } });
    expect(doc!.bucket).toBe(expectedBucket);
    // The KYC bucket IS the main bucket when the dedicated credentials are
    // absent, so dev/CI keep working on the fallback.
    if (!r2.isKycDedicated()) expect(r2.kycBucketName).toBe(r2.bucketName);

    // The bytes are really there: fetch them back through a signed URL. This is
    // the assertion the presign suite could not make, because nothing was ever
    // uploaded — the row was written before R2 was touched at all.
    const signed = await r2.kycSignedDownloadUrl(doc!.s3Key, doc!.bucket);
    expect(signed.url).toContain('X-Amz-Signature');
    expect(signed.url).toContain(`//${r2.kycBucketName}.`);

    const fetched = await fetch(signed.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // Server-side compression ran: JPEG magic bytes, not the PNG that was sent.
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(res.body.sourceBytes).toBe(PNG.length);
    expect(res.body.sizeBytes).toBe(bytes.length);

    // The same object without a signature is not public.
    const unsigned = signed.url.split('?')[0];
    const anonymous = await fetch(unsigned);
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it('14. H2 REGRESSION: a KYC view URL is signed and never uses R2_PUBLIC_URL', async () => {
    if (!r2Configured) return;

    const previous = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = PUBLIC_URL_SENTINEL;
    let leaky: INestApplication | undefined;
    try {
      leaky = await createTestApp();
      const leakyR2 = leaky.get(R2Service);

      // The hazard is GONE, not merely routed around: `R2_PUBLIC_URL` no longer
      // short-circuits anything. This used to assert the opposite — that the
      // report path DID resolve to the sentinel — as the setup for proving KYC
      // ignored it. Defending one caller against a global switch was always the
      // weaker guarantee; the switch is deleted, so even a report PDF is signed
      // with the variable set. In production a non-empty value now refuses the
      // boot outright.
      const reportUrl = await leakyR2.createPresignedDownloadUrl('free/dev/report.pdf');
      expect(reportUrl.url).not.toContain(PUBLIC_URL_SENTINEL);
      expect(reportUrl.url).toContain('X-Amz-Signature');

      // The KYC accessor must ignore it — for a dedicated-bucket row AND for a
      // legacy row whose bucket column is still NULL.
      for (const bucket of [null, leakyR2.kycBucketName]) {
        const signed = await leakyR2.kycSignedDownloadUrl('kyc/u/app/id_front-x.bin', bucket);
        expect(signed.url).toContain('X-Amz-Signature');
        expect(signed.url).toContain('X-Amz-Expires');
        expect(signed.url).not.toContain(PUBLIC_URL_SENTINEL);
        expect(signed.url).not.toContain('kyc-public-leak-sentinel');
      }

      // End to end through the admin review endpoint.
      const user = await registerUser(leaky, 'kyc-leak');
      createdUserIds.add(user.userId);
      const admin = await makeAdmin(leaky, leaky.get(PrismaService));
      createdUserIds.add(admin.userId);

      const application = await request(leaky.getHttpServer())
        .post('/api/v1/kyc/applications')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);
      const appId = application.body.id as string;
      // Seeded, not uploaded: this test is about how a document is SERVED, and
      // the sentinel it guards against lives in the download path.
      await seedDocuments(user, appId);
      await request(leaky.getHttpServer())
        .post(`/api/v1/kyc/applications/${appId}/submit`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(201);

      const detail = await request(leaky.getHttpServer())
        .get(`/api/v1/admin/kyc/${appId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      expect(detail.body.documents.length).toBe(4);
      for (const d of detail.body.documents) {
        expect(d.viewUrl).toContain('X-Amz-Signature');
        expect(d.viewUrl).not.toContain(PUBLIC_URL_SENTINEL);
      }
      expect(JSON.stringify(detail.body)).not.toContain('kyc-public-leak-sentinel');
    } finally {
      await leaky?.close();
      if (previous === undefined) delete process.env.R2_PUBLIC_URL;
      else process.env.R2_PUBLIC_URL = previous;
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
   * Wave 5: the upload goes through the API. The presigned-PUT path it
   * replaces could never work in production — the private KYC bucket has no
   * CORS rules, so the browser refused the PUT before a byte left it and no
   * inspector could be verified.
   * ══════════════════════════════════════════════════════════════════════ */

  it('15. the presigned-upload route is GONE (and must not come back)', async () => {
    const user = await makeUser();
    const appId = await createApplication(user);

    // The exact call the old wizard made. 404 = the route no longer exists.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ kind: 'id_front', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('presignedUploadUrl');

    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('16. the content type is read from the multipart PART, and omitting it is a refusal', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    /*
     * THE BYPASS THIS PINS. The presign endpoint took the content type from an
     * OPTIONAL body field and checked it with `if (contentType && ...)`, so a
     * client skipped validation by omitting it. A part with no Content-Type
     * header reaches multer as `application/octet-stream`; it must be refused,
     * not stored.
     */
    const res = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents/upload`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('kind', 'id_front')
      .attach('file', PNG, { filename: 'id.png', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_content_type');
    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('17. bytes are checked against the declared type; a mismatch stores nothing', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    // An HTML page wearing image/png.
    const html = await uploadDoc(
      user,
      appId,
      'id_front',
      Buffer.from('<!doctype html><html><body>not a document</body></html>'),
      { filename: 'id.png', contentType: 'image/png' },
    );
    expect(html.status).toBe(400);
    expect(html.body.error.code).toBe('unsupported_content_type');

    // An SVG — an `image/*` type, and a script container the reviewer would
    // open from a signed URL.
    const svg = await uploadDoc(
      user,
      appId,
      'id_front',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      { filename: 'id.svg', contentType: 'image/svg+xml' },
    );
    expect(svg.status).toBe(400);

    // A real PDF declared as an image.
    const mislabelled = await uploadDoc(user, appId, 'id_front', PDF, {
      filename: 'id.jpg',
      contentType: 'image/jpeg',
    });
    expect(mislabelled.status).toBe(400);
    expect(mislabelled.body.error.code).toBe('content_type_mismatch');

    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('18. a PDF is stored VERBATIM, as application/pdf, under a .pdf key', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    const res = await uploadDoc(user, appId, 'gewerbeschein', PDF, {
      filename: 'gewerbeschein.pdf',
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(201);
    expect(res.body.contentType).toBe('application/pdf');
    expect(res.body.sizeBytes).toBe(PDF.length);
    expect(res.body.sourceBytes).toBe(PDF.length);

    const doc = await prisma.kycDocument.findFirst({ where: { applicationId: appId } });
    expect(doc!.s3Key.endsWith('.pdf')).toBe(true);

    // Rasterising a Gewerbeschein would make its small print unreadable, so the
    // bytes must come back exactly as they went in.
    const signed = await r2.kycSignedDownloadUrl(doc!.s3Key, doc!.bucket);
    const fetched = await fetch(signed.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await fetched.arrayBuffer()).equals(PDF)).toBe(true);
  }, 30_000);

  it('19. replacing a document deletes the object it displaced', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    expect((await uploadDoc(user, appId, 'id_front')).status).toBe(201);
    const first = await prisma.kycDocument.findFirstOrThrow({
      where: { applicationId: appId, kind: 'id_front' },
    });
    const firstUrl = await r2.kycSignedDownloadUrl(first.s3Key, first.bucket);
    expect((await fetch(firstUrl.url)).status).toBe(200);

    expect((await uploadDoc(user, appId, 'id_front')).status).toBe(201);
    const second = await prisma.kycDocument.findFirstOrThrow({
      where: { applicationId: appId, kind: 'id_front' },
    });
    expect(second.s3Key).not.toBe(first.s3Key);

    // A superseded identity document must not linger in the bucket. The signed
    // URL is still valid — the object behind it is gone.
    const stale = await fetch(firstUrl.url);
    expect(stale.status).toBe(404);

    // The replacement is readable.
    const secondUrl = await r2.kycSignedDownloadUrl(second.s3Key, second.bucket);
    expect((await fetch(secondUrl.url)).status).toBe(200);
  }, 30_000);

  it('20. the upload endpoint requires a bearer token, a `kind` and a file', async () => {
    if (!r2Configured) return;
    const user = await makeUser();
    const appId = await createApplication(user);

    await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents/upload`)
      .field('kind', 'id_front')
      .attach('file', PNG, { filename: 'id.png', contentType: 'image/png' })
      .expect(401);

    // No `kind` part → the DTO refuses it (ValidationPipe, before any storage).
    const noKind = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents/upload`)
      .set('Authorization', `Bearer ${user.token}`)
      .attach('file', PNG, { filename: 'id.png', contentType: 'image/png' });
    expect(noKind.status).toBe(400);

    // No file part at all.
    const noFile = await request(app.getHttpServer())
      .post(`/api/v1/kyc/applications/${appId}/documents/upload`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('kind', 'id_front');
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe('file_required');

    expect(await prisma.kycDocument.count({ where: { applicationId: appId } })).toBe(0);
  });
});
