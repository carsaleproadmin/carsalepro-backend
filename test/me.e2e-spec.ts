import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';

describe('DELETE /me (GDPR erasure) (e2e)', () => {
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

  it('removes reports + quota for the device', async () => {
    const did = uniqueDeviceId();
    await prisma.deviceQuota.create({ data: { deviceId: did, freeReportsUsed: 2 } });
    await prisma.report.createMany({
      data: [
        { deviceId: did, code: 'CSP-1', s3Key: `free/${did}/1.pdf`, tier: 'free' },
        { deviceId: did, code: 'CSP-2', s3Key: `free/${did}/2.pdf`, tier: 'free' },
      ],
    });

    const res = await request(app.getHttpServer())
      .delete('/me')
      .set('x-device-id', did)
      .expect(200);
    expect(res.body.reportsDeleted).toBe(2);
    expect(res.body.quotaDeleted).toBe(true);

    expect(await prisma.report.count({ where: { deviceId: did } })).toBe(0);
    expect(await prisma.deviceQuota.findUnique({ where: { deviceId: did } })).toBeNull();
  });
});
