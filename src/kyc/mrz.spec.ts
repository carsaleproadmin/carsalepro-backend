import { mrzCheckDigit, mrzIdentityKey, normaliseMrzLine, parseMrz } from './mrz';

/*
 * The specimen documents from ICAO Doc 9303 (the fictional state UTO, holder
 * ANNA MARIA ERIKSSON). They are used here for the reason they exist: the
 * check digits in them are correct, so a parser that "works" by ignoring the
 * arithmetic cannot pass.
 *
 * Every line's length is asserted before it is parsed. A layout is decided by
 * width - 44, 36 or 30 - so a typo in a fixture would otherwise silently make
 * the test about a different document than it claims.
 */
const TD3 = [
  'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
];

const TD1 = [
  'I<UTOD231458907<<<<<<<<<<<<<<<',
  '7408122F1204159UTO<<<<<<<<<<<6',
  'ERIKSSON<<ANNA<MARIA<<<<<<<<<<',
];

describe('mrzCheckDigit', () => {
  it('computes the ICAO 7-3-1 sum, letters included', () => {
    // Worked examples from Doc 9303 part 3.
    expect(mrzCheckDigit('L898902C3')).toBe(6);
    expect(mrzCheckDigit('740812')).toBe(2);
    expect(mrzCheckDigit('120415')).toBe(9);
    expect(mrzCheckDigit('D23145890')).toBe(7);
  });

  it('treats the filler as zero and refuses anything outside the alphabet', () => {
    expect(mrzCheckDigit('<<<<<<')).toBe(0);
    expect(mrzCheckDigit('ABC-123')).toBeNull();
  });
});

describe('parseMrz', () => {
  it('reads a TD3 passport', () => {
    expect(TD3.every((l) => l.length === 44)).toBe(true);
    expect(parseMrz(TD3.join('\n'))).toEqual({
      documentCode: 'P',
      issuingState: 'UTO',
      documentNumber: 'L898902C3',
      format: 'TD3',
    });
  });

  it('reads a TD1 identity card, whose number is on the FIRST line', () => {
    expect(TD1.every((l) => l.length === 30)).toBe(true);
    expect(parseMrz(TD1.join('\n'))).toEqual({
      documentCode: 'I',
      issuingState: 'UTO',
      documentNumber: 'D23145890',
      format: 'TD1',
    });
  });

  it('finds the zone among the rest of the page the recogniser returned', () => {
    const page = ['BUNDESREPUBLIK DEUTSCHLAND', '', ...TD1, 'some footer'].join('\n');
    expect(parseMrz(page)!.documentNumber).toBe('D23145890');
  });

  /*
   * THE POINT OF THE WHOLE MODULE. A recogniser reading `8` as `B` produces a
   * document number that looks perfectly plausible, and acting on it would
   * accuse an unrelated applicant. The arithmetic refuses it.
   */
  it('returns null when one character of the number is misread', () => {
    const misread = [TD3[0], TD3[1].replace('L898902C3', 'LB98902C3')];
    expect(misread[1].length).toBe(44);
    expect(parseMrz(misread.join('\n'))).toBeNull();
  });

  it('returns null when the date of birth does not check out', () => {
    const misread = [TD3[0], `${TD3[1].slice(0, 13)}7408123${TD3[1].slice(20)}`];
    expect(misread[1].length).toBe(44);
    expect(parseMrz(misread.join('\n'))).toBeNull();
  });

  it('returns null when the check digit itself is filler (an extended number)', () => {
    const unverifiable = [TD3[0], `${TD3[1].slice(0, 9)}<${TD3[1].slice(10)}`];
    expect(parseMrz(unverifiable.join('\n'))).toBeNull();
  });

  /*
   * REGRESSION. This is verbatim what `tesseract` returned for a rendered
   * specimen passport: the filler at the end of the NAME line came back as a
   * run of `L`, making that line 47 characters long. An exact-width rule threw
   * away a document number whose three check digits were all correct.
   */
  it('reads a zone whose name line the recogniser lengthened', () => {
    const asRead = [
      'P<UTOERIKSSON<<ANNA<KMARIA<LLLLLLLLLLLLLLLLKLKL',
      'L898902C36UT07408122F12041592E184226B<<<<<10',
    ];
    expect(asRead[0].length).toBe(47);
    expect(parseMrz(asRead.join('\n'))).toEqual({
      documentCode: 'P',
      issuingState: 'UTO',
      documentNumber: 'L898902C3',
      format: 'TD3',
    });
  });

  it('returns null for a page with no zone in it at all', () => {
    expect(parseMrz('GEWERBEANMELDUNG\nStadt Berlin\n')).toBeNull();
    expect(parseMrz('')).toBeNull();
  });

  it('returns null for a line of the right width that is only filler', () => {
    const filler = ['P<UTO<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', '<'.repeat(44)];
    expect(parseMrz(filler.join('\n'))).toBeNull();
  });
});

describe('normaliseMrzLine', () => {
  it('folds the characters a recogniser substitutes for the filler', () => {
    expect(normaliseMrzLine('p«uto erik')).toBe('P<UTOERIK');
  });
});

describe('mrzIdentityKey', () => {
  it('includes the issuing state and the document code, not the number alone', () => {
    // Two states may issue the same number. On a bare number the second holder
    // is held for somebody else's rejection.
    const de = mrzIdentityKey({
      documentCode: 'ID',
      issuingState: 'D',
      documentNumber: 'L01X00T47',
      format: 'TD1',
    });
    const ua = mrzIdentityKey({
      documentCode: 'ID',
      issuingState: 'UKR',
      documentNumber: 'L01X00T47',
      format: 'TD1',
    });
    expect(de).not.toBe(ua);
    expect(de).toContain('L01X00T47');
  });
});
