import {
  isVinFormat,
  normalizeVin,
  vinChecksumValid,
  vinHistoryCoverage,
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

  describe('vinHistoryCoverage', () => {
    /*
     * The BMW is the load-bearing case. It carries the GERMAN world manufacturer
     * identifier and the provider still holds a full US history for it, because
     * it was built in Germany for sale in the United States. Any gate keyed on
     * the first character would refuse it — which is the whole reason this
     * function reads the check digit instead. See the note on the export.
     */
    it('supports a German-built US-market VIN', () => {
      expect(vinHistoryCoverage('WBAFR7C57CC811956')).toBe('supported');
    });

    it('supports a US-built VIN', () => {
      expect(vinHistoryCoverage('1HGBH41JXMN109186')).toBe('supported');
    });

    /*
     * A European domestic VIN. Well-formed, decodes to a real car, and its
     * position 9 does not compute — position 9 is optional outside the US.
     */
    it('does not support a European domestic VIN', () => {
      expect(vinHistoryCoverage('WVWZZZ1KZAW123456')).toBe('not_covered');
    });

    it('separates a malformed VIN from an uncovered one', () => {
      expect(vinHistoryCoverage('SHORT')).toBe('invalid_vin');
      expect(vinHistoryCoverage('1234567890123456I')).toBe('invalid_vin');
    });

    it('is case-insensitive', () => {
      expect(vinHistoryCoverage('wbafr7c57cc811956')).toBe('supported');
    });
  });
});
