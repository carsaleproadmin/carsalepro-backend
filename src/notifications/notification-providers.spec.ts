import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { EmailProviderImpl } from './notification-providers';
import { RenderedTemplate } from './notification-templates';

// The factory is invoked at require() time, so it must not touch `mockSend`
// eagerly — the arrow defers the reference until an actual send() call, by which
// point the const below is initialised.
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: (...args: unknown[]) => mockSend(...args),
    },
  })),
}));

const mockSend = jest.fn();

const MESSAGE: RenderedTemplate = {
  subject: 'Bestätige deine E-Mail-Adresse',
  body: 'Hallo <Kunde>,\n\nbitte bestätige: https://carsalepro.de/verify?t=abc',
  short: 'Bitte bestätigen',
};

const TARGET = { address: 'inspector@example.com' };

function makeProvider(opts: { key?: string; replyTo?: string } = {}): EmailProviderImpl {
  const config = {
    get: jest.fn((section: string) => {
      if (section !== 'email') throw new Error(`unexpected config section ${section}`);
      return {
        resendApiKey: opts.key ?? '',
        from: 'no-reply@carsalepro.de',
        replyTo: opts.replyTo,
      };
    }),
  } as unknown as ConfigService<AppConfig, true>;
  return new EmailProviderImpl(config);
}

describe('EmailProviderImpl (Resend)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSend.mockReset();
    // Silence the Nest logger — the DevOutbox path deliberately logs the whole
    // message body, which would drown the unit-test output.
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('falls back to the DevOutbox and reports success when no key is configured', async () => {
    process.env.NODE_ENV = 'development';
    const provider = makeProvider();

    expect(provider.enabled).toBe(false);
    await expect(provider.send(TARGET, MESSAGE)).resolves.toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends through Resend with both text and escaped html when a key is configured', async () => {
    process.env.NODE_ENV = 'development';
    mockSend.mockResolvedValue({ data: { id: 're_123' }, error: null });
    const provider = makeProvider({ key: 're_live_key', replyTo: 'support@carsalepro.de' });

    expect(provider.enabled).toBe(true);
    await expect(provider.send(TARGET, MESSAGE)).resolves.toBe(true);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.from).toBe('no-reply@carsalepro.de');
    expect(payload.to).toEqual([TARGET.address]);
    expect(payload.subject).toBe(MESSAGE.subject);
    expect(payload.text).toBe(MESSAGE.body);
    expect(payload.replyTo).toBe('support@carsalepro.de');
    // The html part must exist and must escape the payload, not inject it raw.
    const html = payload.html as string;
    expect(html).toContain('&lt;Kunde&gt;');
    expect(html).not.toContain('<Kunde>');
    expect(html).toContain('href="https://carsalepro.de/verify?t=abc"');
  });

  it('omits replyTo when EMAIL_REPLY_TO is unset', async () => {
    process.env.NODE_ENV = 'development';
    mockSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    await makeProvider({ key: 're_live_key' }).send(TARGET, MESSAGE);
    expect(mockSend.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('returns false when Resend answers with an error object', async () => {
    process.env.NODE_ENV = 'development';
    mockSend.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field' },
    });

    await expect(makeProvider({ key: 're_live_key' }).send(TARGET, MESSAGE)).resolves.toBe(false);
  });

  it('returns false — and does NOT rethrow — when the Resend SDK throws', async () => {
    process.env.NODE_ENV = 'development';
    mockSend.mockRejectedValue(new Error('socket hang up'));

    await expect(makeProvider({ key: 're_live_key' }).send(TARGET, MESSAGE)).resolves.toBe(false);
  });

  it('forces the DevOutbox under NODE_ENV=test even when a key is present', async () => {
    process.env.NODE_ENV = 'test';
    const provider = makeProvider({ key: 're_live_key' });

    expect(provider.enabled).toBe(false);
    await expect(provider.send(TARGET, MESSAGE)).resolves.toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns false without calling Resend when there is no recipient address', async () => {
    process.env.NODE_ENV = 'development';
    const provider = makeProvider({ key: 're_live_key' });

    await expect(provider.send({ address: null }, MESSAGE)).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
