import { NotificationsService } from '../notifications/notifications.service';
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { SettingsService } from '../settings/settings.service';
import { ListingsService } from './listings.service';

/**
 * Two calls of `copyReportData` for one listing (a double click, or a retry
 * after a timeout). The second call joins the copy that runs and does not
 * copy the same photos a second time.
 */
describe('ListingsService.copyReportData, parallel calls', () => {
  const listing = {
    id: 'l-1',
    sellerId: 'u-1',
    source: 'report',
    status: 'DRAFT',
    reportId: 'r-1',
    vehicleData: {},
    reportDataCopiedAt: null,
    reportPhotosCopiedAt: null,
  };

  function setup() {
    let finishReport!: (value: unknown) => void;
    const prisma = {
      listing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        update: jest.fn().mockResolvedValue({ ...listing, reportDataCopiedAt: new Date() }),
      },
      // The report read is held open, so the second call starts while the
      // first one is still copying.
      report: {
        findUnique: jest.fn(
          () =>
            new Promise((resolve) => {
              finishReport = resolve;
            }),
        ),
      },
    };
    const service = new ListingsService(
      prisma as unknown as PrismaService,
      {} as SettingsService,
      {} as NotificationsService,
      {} as R2Service,
      {} as PhotoProcessingService,
    );
    return {
      prisma,
      service,
      finish: () => finishReport({ reportData: {}, photosManifest: null, uploaded: true }),
    };
  }

  it('runs one copy for two calls', async () => {
    const { prisma, service, finish } = setup();

    const first = service.copyReportData('u-1', 'l-1');
    const second = service.copyReportData('u-1', 'l-1');
    await new Promise((resolve) => setImmediate(resolve));
    finish();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(prisma.report.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.listing.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller who does not own the listing, also while a copy runs', async () => {
    const { service, finish } = setup();

    const first = service.copyReportData('u-1', 'l-1');
    await expect(service.copyReportData('u-2', 'l-1')).rejects.toMatchObject({
      response: { error: expect.objectContaining({ code: 'not_listing_owner' }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await first;
  });

  it('starts a new copy after the first one is finished', async () => {
    const { prisma, service, finish } = setup();

    const first = service.copyReportData('u-1', 'l-1');
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await first;

    const again = service.copyReportData('u-1', 'l-1');
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await again;
    expect(prisma.report.findUnique).toHaveBeenCalledTimes(2);
  });
});
