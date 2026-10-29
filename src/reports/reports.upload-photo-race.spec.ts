import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { ReportsService } from './reports.service';

/**
 * DEN-528. Two uploads of one slot run in parallel. Both find the slot empty,
 * and the second `create` fails on a unique index. The upload must not give 500.
 */
describe('ReportsService.uploadPhoto, parallel uploads of one slot', () => {
  const bytes = Buffer.from('photo-bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = { buffer: bytes, size: bytes.length } as Express.Multer.File;
  const dto = { kind: 'exterior-front', position: 0 };

  const row = (over: Record<string, unknown>) => ({
    id: 'p-1',
    reportId: 'r-1',
    kind: 'exterior-front',
    position: 0,
    r2Key: 'report-photos/d-1/r-1/exterior-front-0-aaaaaaaa.jpg',
    publicUrl: null,
    sizeBytes: 10,
    sourceBytes: 11,
    width: 4,
    height: 3,
    format: 'jpeg',
    hash: 'other-hash',
    order: 0,
    createdAt: new Date('2026-10-28T17:48:41Z'),
    updatedAt: new Date('2026-10-28T17:48:41Z'),
    ...over,
  });

  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  function setup(winner: ReturnType<typeof row> | null) {
    const prisma = {
      report: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r-1', deviceId: 'd-1', deletedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      reportPhoto: {
        // The first read finds the slot empty. The read after the failed
        // create finds the row of the other request.
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
        create: jest.fn().mockRejectedValue(uniqueViolation()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(row({ ...data }))),
        findMany: jest.fn().mockResolvedValue([]),
      },
      listing: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const r2 = {
      isConfigured: () => true,
      putObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      createPresignedDownloadUrl: jest.fn().mockResolvedValue({ url: 'https://signed.test/x' }),
    };
    const processing = {
      compress: jest.fn().mockResolvedValue({
        data: Buffer.from('small'),
        sizeBytes: 5,
        width: 4,
        height: 3,
        format: 'jpeg',
      }),
    };
    const config = { get: () => ({ freeReportsLimit: 3, enforceFreeLimit: false }) };
    const service = new ReportsService(
      prisma as unknown as PrismaService,
      r2 as unknown as R2Service,
      {} as ModuleRef,
      processing as unknown as PhotoProcessingService,
      config as unknown as ConfigService<AppConfig, true>,
    );
    return { prisma, r2, upload: () => service.uploadPhoto('d-1', 'r-1', dto, file) };
  }

  it('returns the stored row when the other request stored the same photo', async () => {
    const stored = row({ hash, r2Key: `report-photos/d-1/r-1/exterior-front-0-${hash.slice(0, 8)}.jpg` });
    const { prisma, r2, upload } = setup(stored);

    const result = await upload();

    expect(result.photoId).toBe('p-1');
    expect(result.replaced).toBe(false);
    expect(prisma.reportPhoto.update).not.toHaveBeenCalled();
    expect(r2.deleteObject).not.toHaveBeenCalled();
  });

  it('replaces the row when the other request stored a different photo', async () => {
    const other = row({ hash: 'other-hash' });
    const { prisma, r2, upload } = setup(other);

    const result = await upload();

    expect(prisma.reportPhoto.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-1' }, data: expect.objectContaining({ hash }) }),
    );
    expect(r2.deleteObject).toHaveBeenCalledWith(other.r2Key);
    expect(result.replaced).toBe(true);
  });

  it('throws other database errors', async () => {
    const { prisma, upload } = setup(null);
    prisma.reportPhoto.create.mockRejectedValue(new Error('db down'));
    await expect(upload()).rejects.toThrow('db down');
  });
});
