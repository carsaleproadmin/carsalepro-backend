import configuration from './configuration';

/**
 * The IAP bundle id is the only value in this file that IGNORES what the
 * environment says, so it is the only one that needs a spec: `com.carsalepro.app`
 * is a package that has never existed in either store, and obeying it rejects
 * every Apple and Google receipt on a bundle mismatch.
 */
describe('configuration() - IAP bundle id', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.IAP_BUNDLE_ID;
    delete process.env.GOOGLE_PLAY_PACKAGE_NAME;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('resolves the shipped id when nothing is set', () => {
    const { iap } = configuration();
    expect(iap.bundleId).toBe('us.designkey.carsalepro');
    expect(iap.google.packageName).toBe('us.designkey.carsalepro');
    expect(iap.retiredBundleIdInEnv).toBe(false);
  });

  it('ignores the retired package in IAP_BUNDLE_ID, for Apple AND Google', () => {
    process.env.IAP_BUNDLE_ID = 'com.carsalepro.app';
    const { iap } = configuration();

    // Google's package name falls through to IAP_BUNDLE_ID, which is how ONE
    // stale variable pointed both stores at nothing.
    expect(iap.bundleId).toBe('us.designkey.carsalepro');
    expect(iap.google.packageName).toBe('us.designkey.carsalepro');
    expect(iap.retiredBundleIdInEnv).toBe(true);
  });

  it('ignores the retired package in GOOGLE_PLAY_PACKAGE_NAME too', () => {
    process.env.IAP_BUNDLE_ID = 'us.designkey.carsalepro';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = ' com.carsalepro.app ';
    const { iap } = configuration();

    expect(iap.google.packageName).toBe('us.designkey.carsalepro');
    expect(iap.retiredBundleIdInEnv).toBe(true);
  });

  it('believes any other value, so a second app or a staging id still works', () => {
    process.env.IAP_BUNDLE_ID = 'us.designkey.carsalepro.staging';
    const { iap } = configuration();

    expect(iap.bundleId).toBe('us.designkey.carsalepro.staging');
    expect(iap.google.packageName).toBe('us.designkey.carsalepro.staging');
    expect(iap.retiredBundleIdInEnv).toBe(false);
  });

  it('treats a blank variable as absent', () => {
    process.env.IAP_BUNDLE_ID = '   ';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = '';
    const { iap } = configuration();

    expect(iap.bundleId).toBe('us.designkey.carsalepro');
    expect(iap.google.packageName).toBe('us.designkey.carsalepro');
    expect(iap.retiredBundleIdInEnv).toBe(false);
  });
});
