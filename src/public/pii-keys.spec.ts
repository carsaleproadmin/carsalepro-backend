import { isPiiKey } from './public.service';

/*
 * The rule that decides what leaves the building - DEN-224.
 *
 * `reportData` is free-form JSON written by the mobile app, and the website
 * prints every key it does not recognise. So this function is the only thing
 * between a field the app adds tomorrow and a public page. It is tested here
 * rather than only end to end, because the interesting cases are keys nobody
 * has written yet.
 */
describe('isPiiKey — a complete key', () => {
  it('drops the keys the DTO names', () => {
    for (const key of ['signature', 'recipients', 'responsible', 'company', 'branch', 'vin']) {
      expect(isPiiKey(key)).toBe(true);
    }
  });
});

describe('isPiiKey — a person or a contact inside a longer key', () => {
  it('drops a person word wherever it is in the key', () => {
    for (const key of ['customerName', 'owner_note', 'sellerComment', 'clientId', 'buyerRemark']) {
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it('drops a way to reach somebody, in any spelling', () => {
    for (const key of [
      'inspectorEmail',
      'contactPhone',
      'phone_number',
      'ownerAddress',
      'signatureImageUrl',
      'IBANAccount',
    ]) {
      expect(isPiiKey(key)).toBe(true);
    }
  });
});

describe('isPiiKey — the word "name"', () => {
  it('drops a bare name, and a name with an owner beside it', () => {
    for (const key of ['name', 'firstName', 'fullName', 'inspectorName', 'customer_name']) {
      expect(isPiiKey(key)).toBe(true);
    }
  });

  /*
   * The report is BUILT out of names. A rule that dropped every key holding
   * the word would empty the document to protect nobody, so `name` counts only
   * when something beside it says whose name it is.
   */
  it('keeps a catalogue label', () => {
    for (const key of ['partName', 'panelName', 'methodName', 'colourName', 'repairMethodName']) {
      expect(isPiiKey(key)).toBe(false);
    }
  });
});

describe('isPiiKey — what it must not take away', () => {
  it('keeps the findings', () => {
    for (const key of [
      'damages',
      'part',
      'severity',
      'thickness',
      'wheels',
      'signoff',
      'rating',
      'accidentFree',
      'minderwert',
      'obdResult',
      'note',
      'remark',
    ]) {
      expect(isPiiKey(key)).toBe(false);
    }
  });

  it('matches a whole token, never a fragment of one', () => {
    // `platform` holds the letters of `plate` and `telemetry` those of `tel`.
    // A substring rule would have removed both.
    expect(isPiiKey('platform')).toBe(false);
    expect(isPiiKey('telemetry')).toBe(false);
    expect(isPiiKey('mailbox')).toBe(false);
  });
});
