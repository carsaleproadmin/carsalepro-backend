import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

const fixture = (name: string): Buffer => readFileSync(join(__dirname, 'fixtures', name));

describe('Report photos — server-side compression (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let r2: R2Service;
  const cleanupKeys: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    r2 = app.get(R2Service);
  });

  afterAll(async () => {
    if (r2Configured) {
      for (const key of cleanupKeys) {
        await r2.deleteObject(key).catch(() => undefined);
      }
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanDb(app);
  });

  async function seedReport(did: string) {
    return prisma.report.create({
      data: { deviceId: did, code: 'CSP-1', s3Key: `free/${did}/x.pdf`, tier: 'free' },
    });
  }

  const upload = (did: string, reportId: string, file: Buffer, fields: Record<string, string>) => {
    let req = request(app.getHttpServer())
      .post(`/reports/${reportId}/photos/upload`)
      .set('x-device-id', did);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', file, 'photo.jpg');
  };

  it('compresses an 8 MB camera JPEG, stores it in R2 and mirrors the manifest', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const report = await seedReport(did);
    const original = fixture('photo-4000x3000.jpg');

    const res = await upload(did, report.id, original, { kind: 'exterior-front' }).expect(201);
    cleanupKeys.push(res.body.r2Key);

    expect(res.body.kind).toBe('exterior-front');
    expect(res.body.position).toBe(0);
    expect(Math.max(res.body.width, res.body.height)).toBeLessThanOrEqual(1920);
    expect(res.body.sizeBytes).toBeLessThan(original.length);
    expect(res.body.sizeBytes).toBeLessThan(1024 * 1024);
    expect(res.body.replaced).toBe(false);
    expect(res.body.r2Key).toBe(
      `report-photos/${did}/${report.id}/${res.body.r2Key.split('/').pop()}`,
    );
    expect(await r2.objectExists(res.body.r2Key)).toBe(true);

    const row = await prisma.reportPhoto.findUnique({ where: { id: res.body.photoId } });
    expect(row).toBeTruthy();
    expect(row?.sourceBytes).toBe(original.length);

    const reportRow = await prisma.report.findUnique({ where: { id: report.id } });
    expect(reportRow?.photosManifest).toEqual([
      { s3Key: res.body.r2Key, kind: 'exterior-front' },
    ]);
  }, 60_000);

  it('re-uploading the same slot replaces the photo; identical bytes short-circuit', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const report = await seedReport(did);
    const a = fixture('small-800x600.png');
    const b = fixture('photo-exif-rotated.jpg');

    const first = await upload(did, report.id, a, { kind: 'odometer' }).expect(201);
    cleanupKeys.push(first.body.r2Key);

    // Same bytes again → no-op, same key, not marked replaced.
    const again = await upload(did, report.id, a, { kind: 'odometer' }).expect(201);
    expect(again.body.photoId).toBe(first.body.photoId);
    expect(again.body.r2Key).toBe(first.body.r2Key);
    expect(again.body.replaced).toBe(false);

    // Different bytes in the same slot → replaced, new key, still exactly 1 row.
    const replaced = await upload(did, report.id, b, { kind: 'odometer' }).expect(201);
    cleanupKeys.push(replaced.body.r2Key);
    expect(replaced.body.photoId).toBe(first.body.photoId);
    expect(replaced.body.replaced).toBe(true);
    expect(replaced.body.r2Key).not.toBe(first.body.r2Key);

    const rows = await prisma.reportPhoto.findMany({ where: { reportId: report.id } });
    expect(rows).toHaveLength(1);
    expect(await r2.objectExists(replaced.body.r2Key)).toBe(true);
    expect(await r2.objectExists(first.body.r2Key)).toBe(false); // superseded object dropped
  }, 90_000);

  it('rejects wrong owner (403), garbage bytes (400), oversize (413) and bad hash (400)', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const otherDid = uniqueDeviceId('other');
    const report = await seedReport(did);
    const png = fixture('small-800x600.png');

    await upload(otherDid, report.id, png, { kind: 'vin' }).expect(403);
    await upload(did, report.id, fixture('not-an-image.bin'), { kind: 'vin' }).expect(400);
    await upload(did, report.id, Buffer.alloc(16 * 1024 * 1024), { kind: 'vin' }).expect(413);
    await upload(did, report.id, png, { kind: 'vin', hash: 'a'.repeat(64) }).expect(400);
    await upload(did, report.id, png, { kind: 'NOT VALID!' }).expect(400);
  }, 60_000);

  it('lists photos in kind/position order and deletes them (row + R2 + manifest)', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const report = await seedReport(did);
    const png = fixture('small-800x600.png');

    const p1 = await upload(did, report.id, png, { kind: 'wheel-fl' }).expect(201);
    const p2 = await upload(did, report.id, png, { kind: 'interior', position: '1' }).expect(201);
    cleanupKeys.push(p1.body.r2Key, p2.body.r2Key);

    const list = await request(app.getHttpServer())
      .get(`/reports/${report.id}/photos`)
      .set('x-device-id', did)
      .expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((i: { kind: string }) => i.kind)).toEqual([
      'interior',
      'wheel-fl',
    ]);
    expect(list.body.items[0].url).toBeTruthy();

    await request(app.getHttpServer())
      .delete(`/reports/${report.id}/photos/${p1.body.photoId}`)
      .set('x-device-id', did)
      .expect(200);

    expect(await prisma.reportPhoto.count({ where: { reportId: report.id } })).toBe(1);
    expect(await r2.objectExists(p1.body.r2Key)).toBe(false);
    const reportRow = await prisma.report.findUnique({ where: { id: report.id } });
    expect(reportRow?.photosManifest).toEqual([{ s3Key: p2.body.r2Key, kind: 'interior' }]);

    // Deleting a photo of a foreign report → 404 (not found under that report).
    await request(app.getHttpServer())
      .delete(`/reports/${report.id}/photos/nonexistent`)
      .set('x-device-id', did)
      .expect(404);
  }, 90_000);

  it('soft-deleting the report removes its photo rows and objects', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const report = await seedReport(did);
    const png = fixture('small-800x600.png');
    const p = await upload(did, report.id, png, { kind: 'zeroproof' }).expect(201);

    await request(app.getHttpServer())
      .delete(`/reports/${report.id}`)
      .set('x-device-id', did)
      .expect(200);

    expect(await prisma.reportPhoto.count({ where: { reportId: report.id } })).toBe(0);
    expect(await r2.objectExists(p.body.r2Key)).toBe(false);
  }, 60_000);
});
