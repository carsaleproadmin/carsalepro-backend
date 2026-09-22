import {
  COLOURS,
  FUEL_TYPES,
  TRANSMISSIONS,
  normalizeColour,
  normalizeFuelType,
  normalizeTransmission,
} from './vehicle-vocabulary';

describe('vehicle vocabulary', () => {
  describe('normalizeFuelType', () => {
    it('folds what the VIN decoder actually answers', () => {
      // Real NHTSA values - the reason this module exists.
      expect(normalizeFuelType('Gasoline')).toBe('petrol');
      expect(normalizeFuelType('Flexible Fuel Vehicle (FFV)')).toBe('petrol');
      expect(normalizeFuelType('Diesel')).toBe('diesel');
    });

    it('reads a hybrid as a hybrid, not as the fuel it also names', () => {
      // The rule order is the assertion: a list sorted by slug calls these petrol.
      expect(normalizeFuelType('Gasoline Hybrid')).toBe('hybrid');
      expect(normalizeFuelType('Plug-in Hybrid (PHEV)')).toBe('hybrid');
    });

    it('folds an inspector writing in their own language', () => {
      expect(normalizeFuelType('Benzin')).toBe('petrol');
      expect(normalizeFuelType('Дизель 2.0')).toBe('diesel');
      expect(normalizeFuelType('Электро')).toBe('electric');
      expect(normalizeFuelType('ГБО')).toBe('lpg');
    });

    it('is a fixed point on its own slugs, which is what makes the backfill idempotent', () => {
      for (const slug of FUEL_TYPES) expect(normalizeFuelType(slug)).toBe(slug);
    });

    it('keeps the words of a value it does not recognise', () => {
      // Blanking it would destroy a fact about the car to tidy a dropdown.
      expect(normalizeFuelType('Hydrogen fuel cell')).toBe('Hydrogen fuel cell');
    });

    it('reads absent as absent', () => {
      expect(normalizeFuelType(null)).toBeNull();
      expect(normalizeFuelType('   ')).toBeNull();
      expect(normalizeFuelType(42)).toBeNull();
    });
  });

  describe('normalizeTransmission', () => {
    it('folds every clutchless gearbox onto automatic', () => {
      expect(normalizeTransmission('CVT')).toBe('automatic');
      expect(normalizeTransmission('7-speed DSG')).toBe('automatic');
      expect(normalizeTransmission('АКПП')).toBe('automatic');
    });

    it('reads an automated manual as automatic', () => {
      // It contains the word `manual` and has no clutch pedal, which is the
      // question the filter asks.
      expect(normalizeTransmission('Automated manual (AMT)')).toBe('automatic');
      expect(normalizeTransmission('Semi-automatic')).toBe('automatic');
    });

    it('folds a real manual', () => {
      expect(normalizeTransmission('Manual')).toBe('manual');
      expect(normalizeTransmission('Schaltgetriebe')).toBe('manual');
      expect(normalizeTransmission('Механика')).toBe('manual');
    });

    it('is a fixed point on its own slugs', () => {
      for (const slug of TRANSMISSIONS) expect(normalizeTransmission(slug)).toBe(slug);
    });
  });

  describe('normalizeColour', () => {
    it('folds a compound onto the more specific colour', () => {
      // Silver is tested before grey; the reverse order swallows both of these.
      expect(normalizeColour('Silbergrau')).toBe('silver');
      expect(normalizeColour('серо-серебристый')).toBe('silver');
    });

    it('folds the languages a legacy report was typed in', () => {
      expect(normalizeColour('Schwarz')).toBe('black');
      expect(normalizeColour('Чёрный')).toBe('black');
      expect(normalizeColour('weiß')).toBe('white');
    });

    it('is a fixed point on its own slugs', () => {
      for (const slug of COLOURS) expect(normalizeColour(slug)).toBe(slug);
    });

    it('keeps a marketing name nobody can fold', () => {
      expect(normalizeColour('Nardo')).toBe('Nardo');
    });
  });
});
