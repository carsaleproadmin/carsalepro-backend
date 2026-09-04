import {
  isVinFormat,
  normalizeVin,
  vinChecksumValid,
} from './vin.util';

describe('vin.util', () => {
  describe('isVinFormat', () => {
    it.each([
      ['1HGBH41JXMN109186', true],
      ['JH4KA8260MC012345', true],
      ['SHORT', false],
      ['1234567890123456I', false],
      ['1234567890123456O', false],
      ['1234567890123456Q', false],
    ])('isVinFormat(%s) === %s', (vin, ok) => {
      expect(isVinFormat(vin)).toBe(ok);
    });
  });

  describe('normalizeVin', () => {
    it('uppercases', () => {
      expect(normalizeVin('1hgbh41jxmn109186')).toBe('1HGBH41JXMN109186');
    });
  });

  describe('vinChecksumValid', () => {
    it('accepts NHTSA canonical sample', () => {
      expect(vinChecksumValid('1HGBH41JXMN109186')).toBe(true);
    });

    it('rejects malformed VIN', () => {
      expect(vinChecksumValid('TOTALLYBOGUS123456')).toBe(false);
    });
  });
});
