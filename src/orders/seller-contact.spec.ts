import { isSellerListingUrl, isSellerPhone, isValidSellerContact } from './seller-contact';

/**
 * The API's half of DEN-361. The website has the same table in
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
      'https://carsalepro.de/cars/abc123',
      'https://carsalepro.net/ru/cars/abc123',
      'https://carsalepro.us/zh-Hant/cars/abc123',
      'https://www.carsalepro.de/cars/abc123?utm_source=x',
    ])('accepts %s', (value) => {
      expect(isSellerListingUrl(value)).toBe(true);
    });

    it.each([
      ['another marketplace', 'https://www.mobile.de/listing/123'],
      ['a look-alike domain', 'https://carsalepro.de.example.com/cars/abc123'],
      ['a subdomain that is not www', 'https://img.carsalepro.de/cars/abc123'],
      ['our start page', 'https://www.carsalepro.de/'],
      ['another page of ours', 'https://www.carsalepro.de/faq'],
      ['the catalogue without a car', 'https://www.carsalepro.de/cars'],
      ['a deeper path under a car', 'https://www.carsalepro.de/cars/abc123/photos'],
      ['a scheme that is not http', 'javascript:alert(1)'],
      ['a bare host', 'carsalepro.de'],
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
});
