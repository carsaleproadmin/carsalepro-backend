import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { R2Service } from '../r2/r2.service';
import { BOM, CRITICAL_ENV_VARS } from './env-hygiene';
import {
  StartupCheckFailedError,
  StartupCheckReport,
  StartupCheckService,
  resolveSeverity,
} from './startup-check.service';

/**
 * The classification is the load-bearing decision of this wave: what stops a
 * deploy and what only colours the log. Getting it wrong in either direction is
 * expensive - a fatal third-party ping loops the deploy of a perfectly healthy
 * service, and a non-fatal KYC bucket is how identity documents ended up beside
 * the paid report PDFs in the first place.
 */
describe('resolveSeverity', () => {
  const prodStrict = { production: true, strict: true };
  const prodLoose = { production: true, strict: false };
  const dev = { production: false, strict: true };

  it('keeps fatal fatal in a strict production boot', () => {
    expect(resolveSeverity('fatal', prodStrict)).toBe('fatal');
  });

  it('downgrades fatal to error when STARTUP_CHECK_STRICT=false', () => {
    expect(resolveSeverity('fatal', prodLoose)).toBe('error');
  });

  it('never makes anything fatal outside production', () => {
    expect(resolveSeverity('fatal', dev)).toBe('warn');
    expect(resolveSeverity('fatal', { production: false, strict: false })).toBe('warn');
  });

  it('never escalates a non-fatal finding, whatever the environment', () => {
    for (const ctx of [prodStrict, prodLoose, dev]) {
      expect(resolveSeverity('error', ctx)).toBe('error');
      expect(resolveSeverity('warn', ctx)).toBe('warn');
      expect(resolveSeverity('info', ctx)).toBe('info');
      expect(resolveSeverity('ok', ctx)).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------

interface StubOptions {
  nodeEnv?: AppConfig['nodeEnv'];
  strict?: boolean;
  allowSharedKycBucket?: boolean;
  corsOrigins?: string[];
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeConnectWebhookSecret?: string;
  mapboxToken?: string;
  r2?: Record<string, unknown>;
  iap?: Record<string, unknown>;
}

function buildConfig(opts: StubOptions): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    nodeEnv: opts.nodeEnv ?? 'production',
    startupCheck: {
      strict: opts.strict ?? true,
      allowSharedKycBucket: opts.allowSharedKycBucket ?? false,
      internalKey: '',
    },
    web: {
      origin: 'https://www.carsalepro.de',
      corsOrigins: opts.corsOrigins ?? ['https://www.carsalepro.de'],
      appEnv: 'production',
    },
    stripe: {
      secretKey: opts.stripeSecretKey ?? '',
      webhookSecret: opts.stripeWebhookSecret ?? 'whsec_platform',
      connectWebhookSecret: opts.stripeConnectWebhookSecret ?? 'whsec_connect',
    },
    mapbox: { token: opts.mapboxToken ?? '' },
    vinHistory: { provider: 'mock', apiKey: '', allowSyntheticSale: false },
    // Absent unless a case exercises it, like every other optional block here.
    ...(opts.iap ? { iap: opts.iap } : {}),
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

function buildR2(overrides: Record<string, unknown> = {}): R2Service {
  const stub = {
    isConfigured: () => true,
    headBucket: jest.fn().mockResolvedValue(undefined),
    bucketName: 'carsalepro-reports',
    isKycDedicated: () => true,
    kycHeadBucket: jest.fn().mockResolvedValue(undefined),
    kycBucketName: 'carsalepro-kyc',
    isPublicBucketConfigured: () => false,
    publicHeadBucket: jest.fn().mockResolvedValue(undefined),
    publicBucketName: '',
    objectExists: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  return stub as unknown as R2Service;
}

function build(opts: StubOptions = {}): StartupCheckService {
  return new StartupCheckService(buildConfig(opts), buildR2(opts.r2));
}

/** A healthy production environment, so a test only introduces its own defect. */
function setCleanEnv(): void {
  for (const spec of CRITICAL_ENV_VARS) delete process.env[spec.name];
  for (const spec of CRITICAL_ENV_VARS) {
    if (spec.requiredInProduction) process.env[spec.name] = `value-for-${spec.name}`;
  }
}

function findingsFor(report: StartupCheckReport, id: string) {
  return report.findings.filter((finding) => finding.id === id);
}

describe('StartupCheckService', () => {
  const ORIGINAL_ENV = process.env;
  let logs: string[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setCleanEnv();
    logs = [];
    const capture = (message: unknown): undefined => {
      logs.push(String(message));
      return undefined;
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  describe('env hygiene', () => {
    it('is fatal in production when a critical value carries a BOM', async () => {
      process.env.MAPBOX_TOKEN = `${BOM}pk.a-perfectly-valid-token`;
      const report = await build().run();

      const hygiene = findingsFor(report, 'env.hygiene');
      expect(hygiene).toHaveLength(1);
      expect(hygiene[0].severity).toBe('fatal');
      expect(hygiene[0].message).toContain('MAPBOX_TOKEN');
      expect(hygiene[0].message).toContain('has BOM');
      expect(report.status).toBe('fail');
    });

    it('never puts the value in the report or in the printed block', async () => {
      const secret = 'sk_live_51NotARealKeyButLongEnough';
      process.env.STRIPE_SECRET_KEY = `${secret}\r`;

      const service = build({ strict: false });
      await service.onApplicationBootstrap();
      const report = service.getReport()!;

      expect(JSON.stringify(report)).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(report.env.find((row) => row.name === 'STRIPE_SECRET_KEY')?.description).toBe(
        `set (len ${secret.length + 1}) - has CR/LF`,
      );
    });

    it('reports a missing required variable as an error, not a fatal', async () => {
      delete process.env.RESEND_API_KEY;
      const report = await build().run();

      const missing = findingsFor(report, 'env.missing');
      expect(missing).toHaveLength(1);
      expect(missing[0].severity).toBe('error');
      expect(missing[0].message).toContain('RESEND_API_KEY');
      expect(report.counts.fatal).toBe(0);
    });

    it('lists every critical variable in the env table, defect or not', async () => {
      const report = await build().run();
      expect(report.env.map((row) => row.name)).toEqual(CRITICAL_ENV_VARS.map((s) => s.name));
    });
  });

  describe('IAP', () => {
    /**
     * The retired package used to be FATAL in `server` mode, which took the
     * whole API down over a mobile-only setting that `configuration.ts` now
     * ignores anyway. A stale variable nobody reads is a warning.
     */
    it('warns about the retired bundle id rather than failing the boot', async () => {
      const report = await build({
        iap: {
          mode: 'server',
          bundleId: 'net.carsalepro.app',
          retiredBundleIdInEnv: true,
          google: { packageName: 'net.carsalepro.app', subscriptionProductIds: [] },
        },
      }).run();

      const bundle = findingsFor(report, 'iap.bundle');
      expect(bundle).toHaveLength(1);
      expect(bundle[0].severity).toBe('warn');
      expect(bundle[0].message).toContain('com.carsalepro.app');
      expect(bundle[0].message).toContain('us.designkey.carsalepro');
      expect(bundle[0].message).toContain('net.carsalepro.app');
      expect(report.counts.fatal).toBe(0);
    });

    it('says nothing about the bundle id when the environment is clean', async () => {
      const report = await build({
        iap: {
          mode: 'server',
          bundleId: 'net.carsalepro.app',
          retiredBundleIdInEnv: false,
          google: { packageName: 'net.carsalepro.app', subscriptionProductIds: [] },
        },
      }).run();

      expect(findingsFor(report, 'iap.bundle')).toHaveLength(0);
      expect(findingsFor(report, 'iap')[0].severity).toBe('info');
      expect(report.counts.fatal).toBe(0);
    });
  });

  describe('CORS', () => {
    it('is fatal in production when the allow-list has no https origin', async () => {
      const report = await build({ corsOrigins: ['http://localhost:3000'] }).run();
      const cors = findingsFor(report, 'cors');
      expect(cors[0].severity).toBe('fatal');
      expect(cors[0].message).toContain('no https:// origin');
    });

    it('is fatal in production when the allow-list is empty', async () => {
      const report = await build({ corsOrigins: [] }).run();
      expect(findingsFor(report, 'cors')[0].severity).toBe('fatal');
    });

    it('passes, and prints the list, when a real origin is allowed', async () => {
      const report = await build({
        corsOrigins: ['https://www.carsalepro.de', 'https://carsalepro.de'],
      }).run();
      const cors = findingsFor(report, 'cors')[0];
      expect(cors.severity).toBe('info');
      expect(cors.message).toContain('https://www.carsalepro.de');
    });
  });

  describe('buckets', () => {
    it('is fatal when the reports bucket does not answer HeadBucket', async () => {
      const report = await build({
        r2: { headBucket: jest.fn().mockRejectedValue(new Error('NoSuchBucket')) },
      }).run();
      const r2 = findingsFor(report, 'r2.reports')[0];
      expect(r2.severity).toBe('fatal');
      expect(r2.message).toContain('NoSuchBucket');
    });

    it('is fatal when R2_KYC_* is unset - identity documents would share the reports bucket', async () => {
      const report = await build({ r2: { isKycDedicated: () => false } }).run();
      const kyc = findingsFor(report, 'r2.kyc')[0];
      expect(kyc.severity).toBe('fatal');
      expect(kyc.message).toContain('R2_KYC_');
    });

    it('is fatal when the KYC bucket IS the reports bucket', async () => {
      const report = await build({ r2: { kycBucketName: 'carsalepro-reports' } }).run();
      expect(findingsFor(report, 'r2.kyc')[0].severity).toBe('fatal');
    });

    it('is waived to a warning by ALLOW_SHARED_KYC_BUCKET=true', async () => {
      const report = await build({
        allowSharedKycBucket: true,
        r2: { isKycDedicated: () => false },
      }).run();
      const kyc = findingsFor(report, 'r2.kyc')[0];
      expect(kyc.severity).toBe('warn');
      expect(kyc.message).toContain('ALLOW_SHARED_KYC_BUCKET');
      expect(report.counts.fatal).toBe(0);
    });

    it('treats an unreachable public bucket as an error, never fatal', async () => {
      const report = await build({
        r2: {
          isPublicBucketConfigured: () => true,
          publicBucketName: 'carsalepro-public',
          publicHeadBucket: jest.fn().mockRejectedValue(new Error('403 Forbidden')),
        },
      }).run();
      expect(findingsFor(report, 'r2.public')[0].severity).toBe('error');
      expect(report.counts.fatal).toBe(0);
    });
  });

  describe('third parties are never fatal', () => {
    it('reports an unset Stripe key as an error in production', async () => {
      const report = await build().run();
      expect(findingsFor(report, 'stripe')[0].severity).toBe('error');
      expect(report.counts.fatal).toBe(0);
    });

    /*
     * The webhook secrets, which fail in a way nothing else reports.
     *
     * A missing Connect secret refuses `account.updated`, which is the only
     * event that sets `stripeOnboarded` - so no inspector becomes eligible for
     * an order, the dispatch finds nobody, and every surface reports the truth
     * it was given. The refusals are visible in the Stripe dashboard, and only
     * if somebody opens it.
     */
    it('reports a missing Connect webhook secret, which nothing else would', async () => {
      const report = await build({
        stripeSecretKey: 'sk_live_x',
        stripeConnectWebhookSecret: '',
      }).run();
      const messages = findingsFor(report, 'stripe').map((finding) => finding.message);
      expect(messages.some((m) => m.includes('STRIPE_CONNECT_WEBHOOK_SECRET is unset'))).toBe(true);
      expect(report.counts.fatal).toBe(0);
    });

    it('reports a missing platform webhook secret', async () => {
      const report = await build({
        stripeSecretKey: 'sk_live_x',
        stripeWebhookSecret: '',
      }).run();
      const messages = findingsFor(report, 'stripe').map((finding) => finding.message);
      expect(messages.some((m) => m.includes('STRIPE_WEBHOOK_SECRET is unset'))).toBe(true);
    });

    /*
     * Stripe issues one secret per endpoint, so the same value in both fields
     * means one endpoint was read twice in the dashboard - and that endpoint
     * is refusing everything it sends. It is the same defect as an unset
     * secret, wearing a value.
     */
    it('reports two webhook secrets that are the same value', async () => {
      const report = await build({
        stripeSecretKey: 'sk_live_x',
        stripeWebhookSecret: 'whsec_same',
        stripeConnectWebhookSecret: 'whsec_same',
      }).run();
      const messages = findingsFor(report, 'stripe').map((finding) => finding.message);
      expect(messages.some((m) => m.includes('equals STRIPE_WEBHOOK_SECRET'))).toBe(true);
    });

    it('says nothing about the secrets outside production', async () => {
      const report = await build({
        nodeEnv: 'development',
        stripeSecretKey: 'sk_test_x',
        stripeWebhookSecret: '',
        stripeConnectWebhookSecret: '',
      }).run();
      const messages = findingsFor(report, 'stripe').map((finding) => finding.message);
      expect(messages.some((m) => m.includes('WEBHOOK_SECRET'))).toBe(false);
    });

    it('reports a rejected Mapbox token as an error and never echoes it', async () => {
      const token = 'pk.this-token-is-rejected';
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: false, status: 401 } as unknown as Response);

      const service = build({ mapboxToken: token, strict: false });
      await service.onApplicationBootstrap();
      const report = service.getReport()!;

      const mapbox = findingsFor(report, 'mapbox')[0];
      expect(mapbox.severity).toBe('error');
      expect(mapbox.message).toContain('401');
      expect(mapbox.message).not.toContain(token);
      expect(report.counts.fatal).toBe(0);
      // The token rides in the query string, so the URL is itself a secret.
      expect(logs.join('\n')).not.toContain(token);
    });

    it('gives up on a hanging Mapbox call instead of holding the boot', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => new Promise<Response>(() => undefined));

      const report = await build({ mapboxToken: 'pk.hangs' }).run();

      const mapbox = findingsFor(report, 'mapbox')[0];
      expect(mapbox.severity).toBe('error');
      expect(mapbox.message).toContain('timed out');
    }, 10_000);
  });

  describe('strict-mode override', () => {
    it('fails the boot on a fatal finding when strict', async () => {
      const service = build({ corsOrigins: [] });
      await expect(service.onApplicationBootstrap()).rejects.toBeInstanceOf(
        StartupCheckFailedError,
      );
      expect(service.getReport()?.status).toBe('fail');
    });

    it('downgrades every fatal to an error and boots when STARTUP_CHECK_STRICT=false', async () => {
      process.env.MAPBOX_TOKEN = `${BOM}pk.token`;
      const service = build({ strict: false, corsOrigins: [] });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      const report = service.getReport()!;
      expect(report.counts.fatal).toBe(0);
      expect(findingsFor(report, 'cors')[0].severity).toBe('error');
      expect(report.findings.filter((f) => f.downgradedFrom === 'fatal').length).toBeGreaterThan(1);
    });

    it('says loudly, in the log, that the override is in force', async () => {
      const service = build({ strict: false, corsOrigins: [] });
      await service.onApplicationBootstrap();
      expect(logs.join('\n')).toContain('STARTUP_CHECK_STRICT=false');
      expect(logs.join('\n')).toContain('DISABLED');
    });

    it('is never fatal outside production, whatever is broken', async () => {
      process.env.MAPBOX_TOKEN = `${BOM}pk.token`;
      const service = build({
        nodeEnv: 'development',
        corsOrigins: [],
        r2: { isKycDedicated: () => false },
      });

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      const report = service.getReport()!;
      expect(report.counts.fatal).toBe(0);
      expect(findingsFor(report, 'r2.kyc')[0].severity).toBe('warn');
    });
  });

  describe('the printed block', () => {
    it('emits one block carrying the greppable summary line', async () => {
      const service = build({ strict: false, corsOrigins: [] });
      await service.onApplicationBootstrap();

      const block = logs.find((line) => line.includes('STARTUP SELF-CHECK'));
      expect(block).toBeDefined();
      expect(block).toContain('STARTUP_CHECK status=degraded');
      expect(block).toContain('fatal=0');
      expect(block).toContain('strict=false');
    });

    it('skips network probes under NODE_ENV=test so the e2e suite stays offline', async () => {
      const r2 = buildR2();
      const service = new StartupCheckService(buildConfig({ nodeEnv: 'test' }), r2);
      const report = await service.run();

      expect(r2.headBucket).not.toHaveBeenCalled();
      expect(r2.kycHeadBucket).not.toHaveBeenCalled();
      expect(report.findings.some((f) => f.message.includes('NODE_ENV=test'))).toBe(true);
    });
  });
});
