import { ConfigService } from '@nestjs/config';
import { KycStatus } from '@prisma/client';
import { AdminAuditService } from '../admin/admin-audit.service';
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { KycService } from './kyc.service';
import { MrzOcrService } from './mrz-ocr.service';

/**
 * "Start over" on a draft. A submit can run between the first read and the
 * delete. Then the documents are evidence for the review and must stay, in the
 * database and in the bucket.
 */
describe('KycService.resetDraft', () => {
  const doc = {
    kind: 'selfie',
    s3Key: 'kyc/u-1/a-1/selfie.jpg',
    bucket: null,
    uploadedAt: new Date('2026-11-04T10:00:00Z'),
  };
  const application = {
    id: 'a-1',
    userId: 'u-1',
    status: KycStatus.DRAFT,
    documents: [doc],
    rejectReason: null,
    submittedAt: null,
    reviewedAt: null,
    createdAt: new Date('2026-11-04T09:00:00Z'),
  };

  function setup(lockedRows: number) {
    const tx = {
      kycApplication: { updateMany: jest.fn().mockResolvedValue({ count: lockedRows }) },
      kycDocument: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      kycApplication: { findUnique: jest.fn().mockResolvedValue(application) },
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    };
    const r2 = {
      isKycConfigured: () => true,
      kycDeleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KycService(
      prisma as unknown as PrismaService,
      r2 as unknown as R2Service,
      {} as NotificationsService,
      {} as PhotoProcessingService,
      {} as AdminAuditService,
      {} as MrzOcrService,
      {} as ConfigService,
    );
    return { tx, r2, reset: () => service.resetDraft('u-1', 'a-1') };
  }

  it('deletes the rows only while the application is still a draft', async () => {
    const { tx, r2, reset } = setup(1);

    const result = await reset();

    expect(tx.kycApplication.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a-1', status: KycStatus.DRAFT } }),
    );
    expect(tx.kycDocument.deleteMany).toHaveBeenCalledWith({ where: { applicationId: 'a-1' } });
    expect(r2.kycDeleteObject).toHaveBeenCalledWith(doc.s3Key, doc.bucket);
    expect(result.documents).toEqual([]);
  });

  it('keeps the rows and the objects when a submit came first', async () => {
    const { tx, r2, reset } = setup(0);

    await expect(reset()).rejects.toMatchObject({
      response: { error: expect.objectContaining({ code: 'kyc_not_editable' }) },
    });
    expect(tx.kycDocument.deleteMany).not.toHaveBeenCalled();
    expect(r2.kycDeleteObject).not.toHaveBeenCalled();
  });
});
