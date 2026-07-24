import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

const UUID_CODE = 'CSP-67e5a3d2-9c41-4b7e-8f2a-1d3c5e7a9b0f';
const OTHER_UUID_CODE = 'CSP-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const validReportData = {
  schemaVersion: 1,
  vehicle: { vin: '1HGBH41JXMN109186', make: 'BMW', model: '320d', year: 2019, colour: 'black' },
  operational: { mileageKm: 84500, mileageUnit: 'km', keysCount: 2, engineStarts: true },
  checklist: [
    { itemNumber: 1, state: 'ok' },
    { itemNumber: 2, state: 'defect', comment: 'Stone chips on the hood' },
  ],
  wheels: [{ corner: 'fl', treadMm: 5.5, rimType: 'alloy' }],
  damages: [
    { id: 'd1', partId: 'hood', typeId: 'dent', tier: 'T2', materialsEur: 40, hours: 2.5, hourlyRate: 120 },
  ],
  signoff: { accidentFree: true, rating: 4, conditionTags: ['well-kept'] },
  scores: { qualityScore: 82 },
  meta: { appVersion: '0.1.0', locale: 'de' },
};

/** The 13 guided Lackdicke stations as the app would send them. */
const thicknessBlock = {
  panels: [
    { panelId: 'roof_rear_left', um: 118, label: 'Dach (hintere linke Ecke)' },
    { panelId: 'fender_rear_left', um: 124 },
    { panelId: 'door_rear_left', um: 121 },
    { panelId: 'opening_left', um: 133 },
    { panelId: 'door_front_left', um: 350 },
    { panelId: 'fender_front_left', um: 119 },
    { panelId: 'hood', um: 122 },
    { panelId: 'fender_front_right', um: 120 },
    { panelId: 'door_front_right', um: 117 },
    { panelId: 'opening_right', um: 131 },
    { panelId: 'door_rear_right', um: 123 },
    { panelId: 'fender_rear_right' }, // not measured
    { panelId: 'extra_1', um: 640, label: 'Tankdeckel' },
  ],
  medianUm: 122,
};

describe('Report sync v2 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDb(app);
  });

  const post = (did: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/reports').set('x-device-id', did).send(body);

  describe('code format', () => {
    it('accepts a CSP-<uuid v4> code', async () => {
      if (!r2Configured) return;
      const res = await post(uniqueDeviceId(), { code: UUID_CODE }).expect(201);
      expect(res.body.reportId).toBeTruthy();
      expect(res.body.reused).toBeUndefined();
    });

    it('still accepts a legacy CSP-### code', async () => {
      if (!r2Configured) return;
      await post(uniqueDeviceId(), { code: 'CSP-042' }).expect(201);
    });

    it('rejects malformed codes', async () => {
      await post(uniqueDeviceId(), { code: 'CSP-xyz' }).expect(400);
      // Non-v4 UUID (version nibble 1) must not pass either.
      await post(uniqueDeviceId(), {
        code: 'CSP-67e5a3d2-9c41-1b7e-8f2a-1d3c5e7a9b0f',
      }).expect(400);
    });
  });

  describe('idempotent create (UUID codes)', () => {
    it('re-posting the same code returns the same report and consumes quota once', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();

      const first = await post(did, { code: UUID_CODE, make: 'BMW' }).expect(201);
      const second = await post(did, { code: UUID_CODE, make: 'BMW', model: '320d' }).expect(201);

      expect(second.body.reportId).toBe(first.body.reportId);
      expect(second.body.reused).toBe(true);
      expect(second.body.presignedUploadUrl).toBeTruthy();

      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota?.freeReportsUsed).toBe(1);

      const row = await prisma.report.findUnique({ where: { id: first.body.reportId } });
      expect(row?.model).toBe('320d'); // metadata refreshed on the idempotent hit
      expect(row?.uploaded).toBe(false); // a new PDF must be re-verified
    });

    it('the same UUID code from ANOTHER device conflicts with 409 and rolls back quota', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const otherDid = uniqueDeviceId('other');

      await post(did, { code: UUID_CODE }).expect(201);
      const res = await post(otherDid, { code: UUID_CODE });
      expect(res.status).toBe(409);
      expect(res.body.error ?? res.body.message?.error).toBeDefined();

      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: otherDid } });
      expect(quota?.freeReportsUsed).toBe(0); // rolled back
    });

    it('legacy CSP-### codes may still collide across devices (both 201)', async () => {
      if (!r2Configured) return;
      await post(uniqueDeviceId(), { code: 'CSP-1' }).expect(201);
      await post(uniqueDeviceId('other'), { code: 'CSP-1' }).expect(201);
    });
  });

  describe('structured reportData v1', () => {
    it('validates and denormalizes listing fields onto the Report row', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const res = await post(did, {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: validReportData,
        finishedAt: '2026-07-16T12:00:00.000Z',
      }).expect(201);

      const row = await prisma.report.findUnique({ where: { id: res.body.reportId } });
      expect(row?.reportSchemaVersion).toBe(1);
      expect(row?.vin).toBe('1HGBH41JXMN109186');
      expect(row?.make).toBe('BMW');
      expect(row?.model).toBe('320d');
      expect(row?.year).toBe(2019);
      expect(row?.mileageKm).toBe(84500);
      expect(row?.color).toBe('black');
      expect(row?.qualityScore).toBe(82);
      expect(row?.finishedAt?.toISOString()).toBe('2026-07-16T12:00:00.000Z');
    });

    it('rejects an invalid v1 payload with 400 and does NOT consume quota', async () => {
      const did = uniqueDeviceId();
      const res = await post(did, {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          checklist: [{ itemNumber: 1, state: 'broken' }], // invalid state
        },
      });
      expect(res.status).toBe(400);

      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota?.freeReportsUsed ?? 0).toBe(0);
    });

    it('validation failures win over quota exhaustion (400, not 402)', async () => {
      const did = uniqueDeviceId();
      await prisma.deviceQuota.create({ data: { deviceId: did, freeReportsUsed: 3 } });
      const res = await post(did, {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: { schemaVersion: 2 }, // wrong version claim
      });
      expect(res.status).toBe(400);
    });

    it('legacy free-form reportData (no version) is stored untouched', async () => {
      if (!r2Configured) return;
      const res = await post(uniqueDeviceId(), {
        code: OTHER_UUID_CODE,
        reportData: { anything: 'goes', nested: { deep: true } },
      }).expect(201);
      const row = await prisma.report.findUnique({ where: { id: res.body.reportId } });
      expect(row?.reportSchemaVersion).toBeNull();
      expect(row?.reportData).toEqual({ anything: 'goes', nested: { deep: true } });
    });
  });

  describe('paint thickness (Lackdicke) block', () => {
    it('accepts and stores a v1 payload carrying thickness readings', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const res = await post(did, {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          thickness: thicknessBlock,
          signoff: { ...validReportData.signoff, paintMeasured: true },
        },
      }).expect(201);

      const row = await prisma.report.findUnique({ where: { id: res.body.reportId } });
      const stored = row?.reportData as { thickness?: typeof thicknessBlock };
      expect(stored.thickness?.panels).toHaveLength(13);
      expect(stored.thickness?.medianUm).toBe(122);
      expect(stored.thickness?.panels[4]).toEqual({ panelId: 'door_front_left', um: 350 });
      // Ad-hoc `extra_`-prefixed panel ids survive the round trip.
      expect(stored.thickness?.panels[12].panelId).toBe('extra_1');
    });

    it('rejects a negative µm reading with 400 and no quota burn', async () => {
      const did = uniqueDeviceId();
      const res = await post(did, {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          thickness: { panels: [{ panelId: 'hood', um: -1 }] },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error ?? res.body.message?.error).toBe('invalid_report_data');

      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota?.freeReportsUsed ?? 0).toBe(0);
    });

    it('rejects an out-of-range µm reading (> 5000) with 400', async () => {
      const res = await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          thickness: { panels: [{ panelId: 'hood', um: 5001 }] },
        },
      });
      expect(res.status).toBe(400);
    });

    it('keeps unknown extra keys inside thickness (forward compatibility)', async () => {
      if (!r2Configured) return;
      const res = await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          thickness: {
            panels: [{ panelId: 'hood', um: 120, sensorSerial: 'EL-2201' }],
            medianUm: 120,
            deviceName: 'ElcoMeter 456',
            calibratedAt: '2026-07-24T08:00:00.000Z',
          },
        },
      }).expect(201);

      const row = await prisma.report.findUnique({ where: { id: res.body.reportId } });
      const stored = row?.reportData as {
        thickness?: { deviceName?: string; panels: { sensorSerial?: string }[] };
      };
      expect(stored.thickness?.deviceName).toBe('ElcoMeter 456');
      expect(stored.thickness?.panels[0].sensorSerial).toBe('EL-2201');
    });
  });

  describe('photo metadata', () => {
    it('accepts 200 photo metas (the cap is 300)', async () => {
      if (!r2Configured) return;
      const photos = Array.from({ length: 200 }, (_, i) => ({
        kind: i < 8 ? 'exterior-extra' : `damage-d${i}`,
        position: i,
        widthPx: 1920,
        heightPx: 1440,
        caption: i === 0 ? 'Kratzer über die ganze Tür' : undefined,
      }));
      const res = await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: { ...validReportData, photos },
      }).expect(201);

      const row = await prisma.report.findUnique({ where: { id: res.body.reportId } });
      const stored = row?.reportData as { photos: unknown[] };
      expect(stored.photos).toHaveLength(200);
    });

    it('rejects more photo metas than the cap allows', async () => {
      const photos = Array.from({ length: 301 }, (_, i) => ({ kind: 'extra', position: i }));
      await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: { ...validReportData, photos },
      }).expect(400);
    });

    it('rejects a photo caption longer than 200 characters', async () => {
      const res = await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          photos: [{ kind: 'exterior-front', position: 0, caption: 'x'.repeat(201) }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error ?? res.body.message?.error).toBe('invalid_report_data');
    });

    it('accepts a caption at the 200-character limit', async () => {
      if (!r2Configured) return;
      await post(uniqueDeviceId(), {
        code: UUID_CODE,
        reportSchemaVersion: 1,
        reportData: {
          ...validReportData,
          photos: [{ kind: 'exterior-front', position: 0, caption: 'x'.repeat(200) }],
        },
      }).expect(201);
    });
  });

  describe('PUT /reports/:id (re-sync)', () => {
    it('updates metadata + reportData without touching quota', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const created = await post(did, { code: UUID_CODE, make: 'BMW' }).expect(201);
      const before = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });

      const res = await request(app.getHttpServer())
        .put(`/reports/${created.body.reportId}`)
        .set('x-device-id', did)
        .send({
          mileageKm: 91000,
          reportSchemaVersion: 1,
          reportData: { ...validReportData, operational: { mileageKm: 91000 } },
        })
        .expect(200);
      expect(res.body.reportId).toBe(created.body.reportId);
      expect(res.body.presignedUploadUrl).toBeUndefined();

      // Idempotent: identical second PUT is still 200.
      await request(app.getHttpServer())
        .put(`/reports/${created.body.reportId}`)
        .set('x-device-id', did)
        .send({ mileageKm: 91000 })
        .expect(200);

      const after = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(after?.freeReportsUsed).toBe(before?.freeReportsUsed);

      const row = await prisma.report.findUnique({ where: { id: created.body.reportId } });
      expect(row?.mileageKm).toBe(91000);
    });

    it('regeneratePdfUploadUrl returns a fresh URL and re-arms /complete', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const created = await post(did, { code: UUID_CODE }).expect(201);
      await prisma.report.update({
        where: { id: created.body.reportId },
        data: { uploaded: true },
      });

      const res = await request(app.getHttpServer())
        .put(`/reports/${created.body.reportId}`)
        .set('x-device-id', did)
        .send({ regeneratePdfUploadUrl: true })
        .expect(200);
      expect(res.body.presignedUploadUrl).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();

      const row = await prisma.report.findUnique({ where: { id: created.body.reportId } });
      expect(row?.uploaded).toBe(false);
    });

    it('403 on another device´s report, 404 on soft-deleted', async () => {
      const did = uniqueDeviceId();
      const otherDid = uniqueDeviceId('other');
      const rep = await prisma.report.create({
        data: { deviceId: otherDid, code: 'CSP-9', s3Key: `free/${otherDid}/9.pdf`, tier: 'free' },
      });
      await request(app.getHttpServer())
        .put(`/reports/${rep.id}`)
        .set('x-device-id', did)
        .send({ make: 'Audi' })
        .expect(403);

      await prisma.report.update({ where: { id: rep.id }, data: { deletedAt: new Date() } });
      await request(app.getHttpServer())
        .put(`/reports/${rep.id}`)
        .set('x-device-id', otherDid)
        .send({ make: 'Audi' })
        .expect(404);
    });

    it('invalid v1 payload on PUT → 400, row unchanged', async () => {
      const did = uniqueDeviceId();
      const rep = await prisma.report.create({
        data: { deviceId: did, code: 'CSP-9', s3Key: `free/${did}/9.pdf`, tier: 'free', make: 'BMW' },
      });
      await request(app.getHttpServer())
        .put(`/reports/${rep.id}`)
        .set('x-device-id', did)
        .send({
          make: 'Audi',
          reportSchemaVersion: 1,
          reportData: { schemaVersion: 1, vehicle: {}, checklist: [{ itemNumber: 0, state: 'ok' }] },
        })
        .expect(400);
      const row = await prisma.report.findUnique({ where: { id: rep.id } });
      expect(row?.make).toBe('BMW');
    });

    it('re-syncs a thickness block via PUT', async () => {
      if (!r2Configured) return;
      const did = uniqueDeviceId();
      const created = await post(did, { code: UUID_CODE }).expect(201);

      await request(app.getHttpServer())
        .put(`/reports/${created.body.reportId}`)
        .set('x-device-id', did)
        .send({
          reportSchemaVersion: 1,
          reportData: { ...validReportData, thickness: thicknessBlock },
        })
        .expect(200);

      const row = await prisma.report.findUnique({ where: { id: created.body.reportId } });
      const stored = row?.reportData as { thickness?: { medianUm?: number } };
      expect(stored.thickness?.medianUm).toBe(122);
    });
  });
});
