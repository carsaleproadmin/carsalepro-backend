import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { MrzOcrService, MrzRecogniser } from './mrz-ocr.service';

/*
 * The recogniser is replaced. What is under test is everything AROUND it: that
 * a failure is silent, that the switch works, and that a read only survives
 * when the check digits agree - which is the whole reason the number can be
 * acted on at all.
 */
const TD3 = [
  'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
].join('\n');

function serviceWith(
  recogniser: MrzRecogniser,
  settings: Record<string, unknown> = {},
): MrzOcrService {
  const config = { get: (key: string) => settings[key] } as unknown as ConfigService;
  const service = new MrzOcrService(config);
  // The worker is a private cache of a promise; injecting a resolved one is
  // what "replace the recogniser" means without exporting a seam nothing else
  // would use.
  (service as unknown as { worker: Promise<MrzRecogniser> }).worker =
    Promise.resolve(recogniser);
  return service;
}

/** A real 200x60 image, so `sharp` in `prepare()` runs for its own sake. */
async function image(): Promise<Buffer> {
  return sharp({
    create: { width: 200, height: 60, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
}

describe('MrzOcrService', () => {
  it('returns the identity when the zone checks out', async () => {
    const service = serviceWith({ recognise: async () => TD3 });
    await expect(service.read(await image())).resolves.toEqual({
      documentCode: 'P',
      issuingState: 'UTO',
      documentNumber: 'L898902C3',
      format: 'TD3',
    });
  });

  it('returns null when the recogniser produced nothing usable', async () => {
    const service = serviceWith({ recognise: async () => 'GEWERBEANMELDUNG\nBERLIN' });
    await expect(service.read(await image())).resolves.toBeNull();
  });

  /*
   * A misread character is the ordinary case, not the exceptional one, and the
   * consequence of acting on one is accusing an unrelated applicant. The check
   * digits refuse it and this service reports nothing at all.
   */
  it('returns null when a character was misread, rather than a plausible number', async () => {
    const misread = TD3.replace('L898902C3', 'LB98902C3');
    const service = serviceWith({ recognise: async () => misread });
    await expect(service.read(await image())).resolves.toBeNull();
  });

  it('is silent when the recogniser throws - an unreadable document is not a fault', async () => {
    const service = serviceWith({
      recognise: async () => {
        throw new Error('worker died');
      },
    });
    await expect(service.read(await image())).resolves.toBeNull();
  });

  it('is silent when the image itself cannot be decoded', async () => {
    const service = serviceWith({ recognise: async () => TD3 });
    await expect(service.read(Buffer.from('not an image'))).resolves.toBeNull();
  });

  it('reads nothing at all when switched off', async () => {
    const recognise = jest.fn(async () => TD3);
    const service = serviceWith({ recognise }, { 'kyc.mrzOcrEnabled': false });
    await expect(service.read(await image())).resolves.toBeNull();
    expect(recognise).not.toHaveBeenCalled();
  });

  it('releases the worker on shutdown', async () => {
    const terminate = jest.fn(async () => undefined);
    const service = serviceWith({ recognise: async () => TD3, terminate });
    await service.onModuleDestroy();
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
