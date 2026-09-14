import { PLATFORM_SETTING_DEFAULTS, SETTING_KEYS, SettingKey } from './platform-settings.constants';
import { SETTING_LIMITS, settingValueError } from './setting-limits';

const KEYS = Object.keys(SETTING_KEYS) as SettingKey[];

describe('SETTING_LIMITS (DEN-297)', () => {
  it('has a range for every setting and none for a removed one', () => {
    expect(Object.keys(SETTING_LIMITS).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)('%s: min < max, and the shipped default is inside the range', (key) => {
    const { min, max } = SETTING_LIMITS[key];
    expect(min).toBeLessThan(max);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(PLATFORM_SETTING_DEFAULTS[key]).toBeGreaterThanOrEqual(min);
    expect(PLATFORM_SETTING_DEFAULTS[key]).toBeLessThanOrEqual(max);
  });

  it('keeps 0 allowed where 0 is a documented lever', () => {
    for (const key of [
      'orderCapKm',
      'minReportQualityScore',
      'orderMinimumFareEur',
      'standardListingPriceEur',
      'refundBeforeAssignPercent',
      'refundAfterAssignPercent',
    ] as SettingKey[]) {
      expect(settingValueError(key, 0)).toBeNull();
    }
  });
});

describe('settingValueError (DEN-297)', () => {
  it('refuses the typing errors the ticket names', () => {
    expect(settingValueError('orderBaseFeeEur', 3900)).toContain('from 5 to 200');
    expect(settingValueError('orderSurgeMultiplier', 0)).not.toBeNull();
    expect(settingValueError('orderRatePerKmEur', 0)).not.toBeNull();
    expect(settingValueError('offerTimeoutMinutes', 0)).not.toBeNull();
    expect(settingValueError('autoApproveAfterDays', 0)).not.toBeNull();
  });

  it('accepts both ends of a range', () => {
    expect(settingValueError('orderBaseFeeEur', 5)).toBeNull();
    expect(settingValueError('orderBaseFeeEur', 200)).toBeNull();
  });

  it('refuses a value that is not a finite number', () => {
    expect(settingValueError('orderBaseFeeEur', Number.NaN)).not.toBeNull();
    expect(settingValueError('orderBaseFeeEur', Number.POSITIVE_INFINITY)).not.toBeNull();
  });
});
