/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The machine-readable zone, read and CHECKED. No OCR here on purpose.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is pure: text in, an identity or `null` out. The recognition
 * that produces the text is somebody else's problem (`MrzOcrService`), and
 * keeping the two apart is what lets the hard part - the field layouts and the
 * check digits - be tested against the specimen strings in ICAO Doc 9303
 * without an image, a worker or a network.
 *
 * WHY A NUMBER AT ALL, WHEN A DOCUMENT ALREADY HAS A FILE HASH (DEN-249).
 * The hash recognises the same FILE. Photograph the same passport a second
 * time and the bytes differ, so the hash sees a stranger. The document number
 * survives re-photographing, re-cropping and re-saving, which is exactly the
 * gap the hash leaves.
 *
 * IT IS NOT A GERMAN FEATURE. The MRZ is ICAO 9303 and the same three layouts
 * cover every machine-readable travel document in the world: TD3 (passport,
 * 2x44), TD1 (card, 3x30), TD2 (2x36). Every EU identity card has carried one
 * since Regulation 2019/1157, and every passport must. A national identity
 * card from outside the EU may have none - that is the real gap, and it is a
 * gap in the DOCUMENT, not in this code. See `parseMrz`'s contract: no read is
 * `null`, and a `null` must never hold an application.
 *
 * THE CHECK DIGITS ARE WHY THIS IS SAFE TO BUILD ON. OCR is a guess. The MRZ
 * carries its own arithmetic over the document number, the date of birth and
 * the date of expiry, so a misread character makes the sum disagree and the
 * whole read is dropped. What comes out of here is not "what the recogniser
 * thought it saw"; it is a string that agrees with three independent
 * checksums.
 */

/** One document, as the MRZ states it. */
export interface MrzIdentity {
  /** `P`, `ID`, `IP`, `AC`… - the document code, `<` stripped. */
  documentCode: string;
  /** Issuing STATE, three letters. Not the holder's nationality. */
  issuingState: string;
  /** Document number, filler removed, upper case. */
  documentNumber: string;
  /** Which layout it was read from - carried for the log, not for logic. */
  format: 'TD1' | 'TD2' | 'TD3';
}

/** Character values for the ICAO check-digit sum: digits, then A=10…Z=35. */
function charValue(c: string): number | null {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return null;
}

/**
 * The ICAO 9303 check digit: weights repeat 7, 3, 1 across the field and the
 * sum is taken modulo 10.
 */
export function mrzCheckDigit(field: string): number | null {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i += 1) {
    const value = charValue(field[i]);
    if (value === null) return null;
    sum += value * weights[i % 3];
  }
  return sum % 10;
}

function digitMatches(field: string, expected: string): boolean {
  // A filler in the check-digit position means the field is unused, or - on a
  // document number longer than the nine characters the field holds - that the
  // real number lives in the optional data. Either way there is nothing to
  // verify, and an unverified read is not a read.
  if (!/^[0-9]$/.test(expected)) return false;
  const actual = mrzCheckDigit(field);
  return actual !== null && actual === Number(expected);
}

/** Strip the filler that pads every MRZ field to a fixed width. */
function unpad(field: string): string {
  return field.replace(/<+$/, '').replace(/</g, '');
}

/**
 * Keep only what an MRZ may contain, and normalise the characters a recogniser
 * confuses with the filler. A long run of `<` is often read as `«`, `K<` or a
 * row of underscores depending on the font and the exposure.
 */
export function normaliseMrzLine(line: string): string {
  return line
    .toUpperCase()
    .replace(/[«‹〈<]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * Read an MRZ out of whatever text the recogniser produced.
 *
 * Returns `null` for anything that does not parse AND check out. There is no
 * middle state and no confidence score: a caller that has to decide how much
 * to trust a number will eventually decide wrongly, and the cost of deciding
 * wrongly here is telling an honest applicant that their documents belong to
 * somebody else.
 */
export function parseMrz(text: string): MrzIdentity | null {
  const lines = text
    .split(/\r?\n/)
    .map(normaliseMrzLine)
    .filter((l) => l.length >= 28);

  // Longest first: a TD3 line that lost characters must not be tried as a TD1.
  for (let i = 0; i < lines.length; i += 1) {
    const td3 = readTd3(lines, i);
    if (td3) return td3;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const td2 = readTd2(lines, i);
    if (td2) return td2;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const td1 = readTd1(lines, i);
    if (td1) return td1;
  }
  return null;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE READERS MEASURE A PREFIX AND NOT THE WHOLE LINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They used to require an exact width - 44, 36, 30 - which is what the
 * standard says and what a scanner produces. Against a real recogniser it
 * failed on documents whose data was read perfectly.
 *
 * A specimen passport rendered and read back came out as:
 *
 *   P<UTOERIKSSON<<ANNA<KMARIA<LLLLLLLLLLLLLLLLKLKL   (47 characters)
 *   L898902C36UT07408122F12041592E184226B<<<<<10      (44, every check digit right)
 *
 * The long run of filler at the end of the NAME line was read as `L`, which
 * made that line 47 characters and threw away a document number that was
 * correct and verified. The name line carries no check digit, so nothing could
 * have caught the error and nothing needed to: the only part of it this module
 * reads is the document code and the issuing state, in the first five
 * characters, which recognisers get right because they are letters among
 * letters.
 *
 * So each reader now measures the PREFIX it actually reads and lets the tail
 * be whatever the recogniser made of it. Every field it takes from that prefix
 * is still covered by a check digit. The filler is where OCR goes wrong and the
 * checked fields are where it goes right, and this follows that grain instead
 * of arguing with it.
 */

/** Passport: the document number and both dates are on the SECOND line. */
function readTd3(lines: string[], i: number): MrzIdentity | null {
  const first = lines[i];
  const second = lines[i + 1];
  if (!first || !second) return null;
  if (first.length < 5 || second.length < 44) return null;
  if (first[0] !== 'P') return null;

  const documentNumber = second.slice(0, 9);
  if (!digitMatches(documentNumber, second[9])) return null;
  if (!digitMatches(second.slice(13, 19), second[19])) return null; // date of birth
  if (!digitMatches(second.slice(21, 27), second[27])) return null; // date of expiry

  return build('TD3', first.slice(0, 2), first.slice(2, 5), documentNumber);
}

/** Older card / visa layout: the second line holds the number and the dates. */
function readTd2(lines: string[], i: number): MrzIdentity | null {
  const first = lines[i];
  const second = lines[i + 1];
  if (!first || !second) return null;
  // 36, the true TD2 width, and NOT the 28 characters this reader actually
  // touches. A TD1 line is 30 characters, so a prefix rule of 28 let an
  // identity card reach this reader - and `parseMrz` tries every TD2 read
  // before any TD1 read, so it reached it FIRST. The fields at these offsets
  // are the dates on a TD1, thus the "document number" came out of the date of
  // birth. Three check digits refuse almost every such read, but roughly one in
  // a thousand agrees by chance and the platform then stores and compares an
  // identity key that belongs to nobody.
  //
  // The prefix rule stays for the tail beyond 36, which is where the filler is
  // and where a recogniser goes wrong (see the note above).
  if (first.length < 5 || second.length < 36) return null;

  const documentNumber = second.slice(0, 9);
  if (!digitMatches(documentNumber, second[9])) return null;
  if (!digitMatches(second.slice(13, 19), second[19])) return null;
  if (!digitMatches(second.slice(21, 27), second[27])) return null;

  return build('TD2', first.slice(0, 2), first.slice(2, 5), documentNumber);
}

/** Identity card: the number is on the FIRST line, the dates on the second. */
function readTd1(lines: string[], i: number): MrzIdentity | null {
  const first = lines[i];
  const second = lines[i + 1];
  if (!first || !second) return null;
  if (first.length < 15 || second.length < 15) return null;

  const documentNumber = first.slice(5, 14);
  if (!digitMatches(documentNumber, first[14])) return null;
  if (!digitMatches(second.slice(0, 6), second[6])) return null; // date of birth
  if (!digitMatches(second.slice(8, 14), second[14])) return null; // date of expiry

  return build('TD1', first.slice(0, 2), first.slice(2, 5), documentNumber);
}

function build(
  format: MrzIdentity['format'],
  documentCode: string,
  issuingState: string,
  documentNumber: string,
): MrzIdentity | null {
  const code = unpad(documentCode);
  const state = unpad(issuingState);
  const number = unpad(documentNumber);

  // A three-letter issuing state is required, and so is a number of at least
  // five characters. Both guard against a line that satisfied the arithmetic by
  // being mostly filler.
  if (!/^[A-Z]{3}$/.test(state)) return null;
  if (number.length < 5) return null;
  if (code.length === 0) return null;

  return { documentCode: code, issuingState: state, documentNumber: number, format };
}

/**
 * The string that is hashed and stored.
 *
 * ISSUING STATE AND DOCUMENT TYPE ARE PART OF THE KEY, and leaving them out is
 * a real defect rather than a tidiness question: a document number is unique
 * WITHIN a country, not across them. Two applicants from different states can
 * hold the same number, and on a bare number the second one is held for a
 * theft they had nothing to do with.
 */
export function mrzIdentityKey(identity: MrzIdentity): string {
  return `${identity.issuingState}|${identity.documentCode}|${identity.documentNumber}`;
}
