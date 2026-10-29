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

  type Row = ReturnType<typeof row>;

  /**
   * `reads` are the slot reads in order: the first read, then one after each
   * write that lost. `updated` is the number of rows each conditional update
   * changes, in order.
   */
  function setup(reads: (Row | null)[], updated: number[] = []) {
    const prisma = {
      report: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r-1', deviceId: 'd-1', deletedAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      reportPhoto: {
        findUnique: jest.fn(),
        create: jest.fn().mockRejectedValue(uniqueViolation()),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue(row({ id: 'p-1', hash })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      listing: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    for (const r of reads) prisma.reportPhoto.findUnique.mockResolvedValueOnce(r);
    for (const count of updated) prisma.reportPhoto.updateMany.mockResolvedValueOnce({ count });
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

  const ours = () =>
    row({ hash, r2Key: `report-photos/d-1/r-1/exterior-front-0-${hash.slice(0, 8)}.jpg` });

  describe('empty slot, create fails on the unique index', () => {
    it('returns the stored row when the other request stored the same photo', async () => {
      const { prisma, r2, upload } = setup([null, ours()]);

      const result = await upload();

      expect(result.photoId).toBe('p-1');
      expect(result.replaced).toBe(false);
      expect(prisma.reportPhoto.updateMany).not.toHaveBeenCalled();
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('replaces the row when the other request stored a different photo', async () => {
      const other = row({ hash: 'other-hash' });
      const { prisma, r2, upload } = setup([null, other], [1]);

      const result = await upload();

      expect(prisma.reportPhoto.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p-1', r2Key: other.r2Key },
          data: expect.objectContaining({ hash }),
        }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(other.r2Key);
      expect(result.replaced).toBe(true);
    });

    it('throws other database errors', async () => {
      const { prisma, upload } = setup([null]);
      prisma.reportPhoto.create.mockRejectedValue(new Error('db down'));
      await expect(upload()).rejects.toThrow('db down');
    });
  });

  describe('occupied slot, another request changed it first', () => {
    it('returns the stored row when that request stored the same photo', async () => {
      const old = row({ hash: 'old-hash', r2Key: 'report-photos/d-1/r-1/old.jpg' });
      const { r2, upload } = setup([old, ours()], [0]);

      const result = await upload();

      expect(result.replaced).toBe(false);
      // The old object belongs to the request that replaced it.
      expect(r2.deleteObject).not.toHaveBeenCalled();
    });

    it('replaces the newer photo and deletes only that object', async () => {
      const old = row({ hash: 'old-hash', r2Key: 'report-photos/d-1/r-1/old.jpg' });
      const newer = row({ hash: 'newer-hash', r2Key: 'report-photos/d-1/r-1/newer.jpg' });
      const { prisma, r2, upload } = setup([old, newer], [0, 1]);

      const result = await upload();

      expect(prisma.reportPhoto.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'p-1', r2Key: newer.r2Key } }),
      );
      expect(r2.deleteObject).toHaveBeenCalledTimes(1);
      expect(r2.deleteObject).toHaveBeenCalledWith(newer.r2Key);
      expect(result.replaced).toBe(true);
    });

    it('gives 409 photo_slot_busy when the slot keeps changing', async () => {
      const other = (n: number) => row({ hash: `h-${n}`, r2Key: `report-photos/d-1/r-1/${n}.jpg` });
      const { upload } = setup([other(1), other(2), other(3), other(4)], [0, 0, 0]);

      await expect(upload()).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'photo_slot_busy' }),
      });
    });
  });
});
