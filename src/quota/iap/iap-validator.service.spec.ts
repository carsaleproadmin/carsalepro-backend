import { ConfigService } from '@nestjs/config';
import { AppleValidator } from './apple-validator';
import { GoogleValidator } from './google-validator';
import { IapValidatorService } from './iap-validator.service';
import { IapValidationError } from './iap.types';

function build(mode: 'client-trust' | 'server', configured: { apple: boolean; google: boolean }) {
  const apple = { isConfigured: () => configured.apple, validate: jest.fn() };
  const google = { isConfigured: () => configured.google, validate: jest.fn() };
  const config = { get: () => ({ mode }) } as unknown as ConfigService;
  const service = new IapValidatorService(
    config as never,
    apple as unknown as AppleValidator,
    google as unknown as GoogleValidator,
  );
  return { service, apple, google };
}

describe('IapValidatorService', () => {
  it('client-trust accepts anything and contacts no store', async () => {
    const { service, apple } = build('client-trust', { apple: false, google: false });
    await expect(service.validate({ platform: 'ios', receipt: 'fake' })).resolves.toMatchObject({
      valid: true,
      provider: 'client-trust',
    });
    expect(apple.validate).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'] as const)(
    'server mode fails closed on %s with 503-class iap_not_configured when credentials are missing',
    async (platform) => {
      const { service } = build('server', { apple: false, google: false });
      const err = await service
        .validate({ platform, receipt: 'x', productId: 'carsalepro_pro_lifetime' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IapValidationError);
      expect((err as IapValidationError).code).toBe('iap_not_configured');
      expect((err as IapValidationError).unavailable).toBe(true);
    },
  );

  it('server mode routes each platform to its own validator', async () => {
    const { service, apple, google } = build('server', { apple: true, google: true });
    apple.validate.mockResolvedValue({ valid: true });
    google.validate.mockResolvedValue({ valid: true });
    await service.validate({ platform: 'ios', receipt: 'a' });
    await service.validate({ platform: 'android', receipt: 'b', productId: 'p' });
    expect(apple.validate).toHaveBeenCalledTimes(1);
    expect(google.validate).toHaveBeenCalledTimes(1);
  });
});
