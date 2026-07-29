import {
  JsonObject,
  mergeVehicleData,
  projectVehicleColumns,
  sanitizeVehicleData,
} from './listing-vehicle-data';

describe('listing vehicleData helpers (BE-S2)', () => {
  describe('mergeVehicleData', () => {
    it('merges nested objects key by key', () => {
      const base: JsonObject = { vehicle: { make: 'Opel', model: 'Astra', year: 2016 } };
      const out = mergeVehicleData(base, { vehicle: { year: 2017 } });
      expect(out.vehicle).toEqual({ make: 'Opel', model: 'Astra', year: 2017 });
    });

    it('replaces arrays WHOLESALE rather than merging element-wise', () => {
      // Element-wise merging would make a list append-only: the client could
      // never express "delete the second damage".
      const base: JsonObject = { damages: [{ id: 'a' }, { id: 'b' }] };
      const out = mergeVehicleData(base, { damages: [{ id: 'c' }] });
      expect(out.damages).toEqual([{ id: 'c' }]);
    });

    it('deletes a key on an explicit null', () => {
      const base: JsonObject = { selfDeclaration: { ownersCount: 2 }, vehicle: { make: 'Opel' } };
      const out = mergeVehicleData(base, { selfDeclaration: null });
      expect('selfDeclaration' in out).toBe(false);
      expect(out.vehicle).toEqual({ make: 'Opel' });
    });

    it('leaves untouched keys alone and does not mutate the base', () => {
      const base: JsonObject = { vehicle: { make: 'Opel' }, operational: { mileageKm: 1000 } };
      const out = mergeVehicleData(base, { operational: { keysCount: 2 } });
      expect(out.operational).toEqual({ mileageKm: 1000, keysCount: 2 });
      expect(base.operational).toEqual({ mileageKm: 1000 });
    });

    it('overwrites a scalar with an object and an object with a scalar', () => {
      expect(mergeVehicleData({ a: 1 }, { a: { b: 2 } }).a).toEqual({ b: 2 });
      expect(mergeVehicleData({ a: { b: 2 } }, { a: 1 }).a).toBe(1);
    });
  });

  describe('sanitizeVehicleData', () => {
    it('strips every money field from seller-declared damages', () => {
      const out = sanitizeVehicleData({
        damages: [
          {
            id: 'd1',
            tier: 'T2',
            note: 'dent',
            materialsEur: 120,
            hours: 3,
            hourlyRate: 90,
            manualCostEur: 400,
          },
        ],
      });
      expect(out.damages).toEqual([{ id: 'd1', tier: 'T2', note: 'dent' }]);
    });

    it('strips inspector-only blocks even if they get past validation', () => {
      const out = sanitizeVehicleData({
        scores: { qualityScore: 100 },
        signoff: { accidentFree: true },
        vehicle: { make: 'Opel' },
      });
      expect('scores' in out).toBe(false);
      expect('signoff' in out).toBe(false);
      expect(out.vehicle).toEqual({ make: 'Opel' });
    });

    it('always stamps schemaVersion 1', () => {
      expect(sanitizeVehicleData({}).schemaVersion).toBe(1);
    });
  });

  describe('projectVehicleColumns', () => {
    it('projects the searchable columns out of the payload', () => {
      const cols = projectVehicleColumns({
        vehicle: {
          vin: 'wauzzz8v8ma012345',
          make: '  Opel ',
          model: 'Astra',
          year: 2016,
          fuelType: 'petrol',
          transmission: 'manual',
          powerKw: 92,
          colour: 'silver',
          bodyType: 'estate',
          driveType: 'fwd',
          tuvDate: '2027-06',
          firstRegistration: '2016-04-12',
        },
        operational: { mileageKm: 132000 },
      });

      expect(cols.vin).toBe('WAUZZZ8V8MA012345');
      expect(cols.make).toBe('Opel');
      expect(cols.year).toBe(2016);
      expect(cols.mileageKm).toBe(132000);
      expect(cols.powerKw).toBe(92);
      expect(cols.color).toBe('silver');
      // Free text on the mobile contract ("2027-06"), so it stays text.
      expect(cols.huValidUntil).toBe('2027-06');
      expect(cols.firstRegistration?.toISOString()).toContain('2016-04-12');
    });

    it('returns nulls rather than throwing on an empty or malformed payload', () => {
      const empty = projectVehicleColumns({});
      expect(empty.make).toBeNull();
      expect(empty.firstRegistration).toBeNull();

      const junk = projectVehicleColumns({
        vehicle: { year: 'nineteen', firstRegistration: 'not-a-date', make: '   ' },
      });
      expect(junk.year).toBeNull();
      expect(junk.firstRegistration).toBeNull();
      expect(junk.make).toBeNull();
    });
  });
});
