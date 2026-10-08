import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { AppConfig } from '../config/configuration';
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import { ReportsService } from './reports.service';

/**
 * DEN-434. A re-synced report refreshes the engine volume of its listing, and
 * only that value.
 */
describe('ReportsService.syncListingEngineVolume', () => {
  function setup(listing: { id: string; vehicleData: unknown } | null) {
    const prisma = {
      listing: {
        findFirst: jest.fn().mockResolvedValue(listing),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const config = { get: () => ({ freeReportsLimit: 3, enforceFreeLimit: false }) };
    const service = new ReportsService(
      prisma as unknown as PrismaService,
      {} as R2Service,
      {} as ModuleRef,
      {} as PhotoProcessingService,
      config as unknown as ConfigService<AppConfig, true>,
    );
    const sync = (data: Record<string, unknown>) =>
      (
        service as unknown as {
          syncListingEngineVolume(id: string, d: Record<string, unknown>): Promise<void>;
        }
      ).syncListingEngineVolume('r-1', data);
    return { prisma, sync };
  }

  it('writes the new volume and keeps the other vehicle data', async () => {
    const { prisma, sync } = setup({
      id: 'l-1',
      vehicleData: { vehicle: { engineVolumeL: 1.6, doors: 5 }, equipment: ['ac'] },
    });
    await sync({ vehicle: { engineVolumeL: 1.968 } });
    expect(prisma.listing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reportId: 'r-1', source: 'report' } }),
    );
    expect(prisma.listing.update).toHaveBeenCalledWith({
      where: { id: 'l-1' },
      data: { vehicleData: { vehicle: { engineVolumeL: 2, doors: 5 }, equipment: ['ac'] } },
    });
  });

  it('removes the volume when the report no longer has one', async () => {
    const { prisma, sync } = setup({ id: 'l-1', vehicleData: { vehicle: { engineVolumeL: 2 } } });
    await sync({ vehicle: {} });
    expect(prisma.listing.update).toHaveBeenCalledWith({
      where: { id: 'l-1' },
      data: { vehicleData: { vehicle: {} } },
    });
  });

  it('writes nothing when the value did not change', async () => {
    const { prisma, sync } = setup({ id: 'l-1', vehicleData: { vehicle: { engineVolumeL: 2 } } });
    await sync({ vehicle: { engineVolumeL: 2 } });
    expect(prisma.listing.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the report has no listing', async () => {
    const { prisma, sync } = setup(null);
    await sync({ vehicle: { engineVolumeL: 2 } });
    expect(prisma.listing.update).not.toHaveBeenCalled();
  });

  it('does not throw when the database fails', async () => {
    const { prisma, sync } = setup({ id: 'l-1', vehicleData: null });
    prisma.listing.update.mockRejectedValue(new Error('db down'));
    await expect(sync({ vehicle: { engineVolumeL: 2 } })).resolves.toBeUndefined();
  });
});
