import {
  isSellerListingUrl,
  isSellerPhone,
  isValidSellerContact,
  normalizeSellerContact,
} from './seller-contact';

/**
 * The API's half of DEN-361 and DEN-380. The website has the same table in
 * `lib/seller-contact.test.ts`; the two must agree, or the form accepts what
 * the endpoint refuses and the customer loses the order at the last step.
 */
describe('the order contact field', () => {
  describe('a telephone number', () => {
    it.each([
      '+4930123456',
      '+49 30 123 456',
      '+49 (30) 123-456',
      '+380 44 123 45 67',
      '+1 (202) 555-0142',
      '+380 67 123 4567',
      '+49 176 1234567',
      '+49 30 123456/7',
    ])('accepts %s', (value) => {
      expect(isSellerPhone(value)).toBe(true);
      expect(isValidSellerContact(value)).toBe(true);
    });

    it.each([
      ['a name', 'Peter'],
      ['an e-mail address', 'peter@example.com'],
      ['a sentence with a number', 'call Peter on 030 123456'],
      ['too few digits', '+12345'],
      ['more digits than E.164 allows', '+1234567890123456'],
      // DEN-380. The length is checked against the plan of the country.
      ['a Ukrainian number that is too short', '+380 67 123 45'],
      ['a Ukrainian number that is too long', '+380 67 123 45678'],
      ['a US number that is too short', '+1 202 555 014'],
      ['nothing at all', '   '],
      // DEN-366. The country code is necessary, thus a national number and the
      // international prefix written as digits are both refused.
      ['a national number', '030 123456/7'],
      ['a national number without spacing', '0301234567'],
      ['the prefix written as 00', '004930123456'],
      ['a plus followed by a zero', '+049 30 123456'],
    ])('refuses %s', (_case, value) => {
      expect(isValidSellerContact(value)).toBe(false);
    });
  });

  describe('a listing link', () => {
    it.each([
      'https://www.carsalepro.de/cars/abc123',
      'https://carsalepro.net/ru/cars/abc123',
      // DEN-380. Links to other marketplaces are accepted.
      'https://www.mobile.de/listing/123',
      'https://suchen.mobile.de/fahrzeuge/details.html?id=123',
      'https://www.autoscout24.de/angebote/bmw-320-abc',
      'https://auto.ria.com/uk/auto_bmw_x5_123.html',
      'http://www.olx.ua/d/obyavlenie/abc',
      'https://www.carsalepro.de/',
    ])('accepts %s', (value) => {
      expect(isSellerListingUrl(value)).toBe(true);
      expect(isValidSellerContact(value)).toBe(true);
    });

    it.each([
      ['a scheme that is not http', 'javascript:alert(1)'],
      ['an ftp link', 'ftp://example.com/car'],
      ['a bare word', 'carsalepro'],
      ['a bare IPv4 address', '192.168.0.1/cars/1'],
      ['a sentence with a host in it', 'see mobile.de please'],
      ['a host without a dot', 'http://intranet/cars/1'],
      ['an IPv4 address', 'http://192.168.0.1/cars/1'],
      ['an IPv6 address', 'http://[2001:db8::1]/cars/1'],
      ['a link with credentials', 'https://user:pass@example.com/car'],
    ])('refuses %s', (_case, value) => {
      expect(isValidSellerContact(value)).toBe(false);
    });
  });

  /**
   * The development hosts exist so a developer can paste the listing they are
   * looking at. Production must not take one: a link nobody outside a laptop
   * can open is the same defect as a link to a marketplace.
   */
  describe('the development hosts', () => {
    const LOCAL = 'http://localhost:3000/cars/abc123';
    const original = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = original;
    });

    it('accepts one outside production', () => {
      process.env.NODE_ENV = 'development';
      expect(isValidSellerContact(LOCAL)).toBe(true);
    });

    it('refuses one in production', () => {
      process.env.NODE_ENV = 'production';
      expect(isValidSellerContact(LOCAL)).toBe(false);
    });
  });

  // DEN-421. The website's order field shows the code in brackets and takes
  // links without a scheme; both are stored in one form.
  describe('the normalization', () => {
    it.each([
      ['google.com', 'https://google.com'],
      ['www.mobile.de/listing/123', 'https://www.mobile.de/listing/123'],
      ['  auto.ria.com/uk/x.html?id=1 ', 'https://auto.ria.com/uk/x.html?id=1'],
      ['(+49) 30 123456', '+49 30 123456'],
      ['(+380) 67 123 4567', '+380 67 123 4567'],
      ['+49 30 123456', '+49 30 123456'],
      ['https://www.mobile.de/x', 'https://www.mobile.de/x'],
      ['carsalepro', 'carsalepro'],
    ])('turns %s into %s', (value, expected) => {
      expect(normalizeSellerContact(value)).toBe(expected);
    });

    it.each(['google.com', '(+49) 30 123456', '(+380) 67 123 4567'])('accepts %s', (value) => {
      expect(isValidSellerContact(value)).toBe(true);
    });
  });
});
