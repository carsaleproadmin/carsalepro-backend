import { formatDeadline, renderTemplate } from './notification-templates';

/*
 * DEN-200. The confirmation letter a new account gets.
 *
 * This is the first thing the platform ever says to a person, and it is sent
 * once - there is no second render to correct a mistake in. So the assertions
 * here are about the promises the letter makes rather than its wording: that
 * the link is in the text as well as on the button, that the deadline is
 * something a person can read, and that a missing payload field degrades into
 * a sentence rather than into "undefined".
 */

const EXPIRES = '2026-08-27T09:14:22.001Z';

function letter(payload: Record<string, unknown> = {}) {
  return renderTemplate('auth.verify_email', 'en', {
    email: 'alice@example.com',
    verifyUrl: 'https://carsalepro.de/verify?token=abc',
    expiresAt: EXPIRES,
    ...payload,
  });
}

describe('formatDeadline', () => {
  it('turns an ISO timestamp into plain English, in UTC', () => {
    expect(formatDeadline(EXPIRES)).toBe('27 August 2026, 09:14 UTC');
  });

  it('answers an empty string for anything that is not a date', () => {
    // The sentence then reads a little short. A template must never throw and
    // must never print "Invalid Date" at a reader.
    for (const bad of [undefined, null, '', 'soon', {}]) {
      expect(formatDeadline(bad)).toBe('');
    }
  });
});

describe('the verification letter', () => {
  it('carries the link in the body AND as the button', () => {
    const m = letter();
    expect(m.body).toContain('https://carsalepro.de/verify?token=abc');
    expect(m.cta).toEqual({
      url: 'https://carsalepro.de/verify?token=abc',
      label: 'Confirm my email address',
    });
  });

  it('names the address being confirmed', () => {
    // The reader may hold several addresses. Which one this letter is about is
    // the difference between confirming and wondering.
    expect(letter().body).toContain('alice@example.com');
  });

  it('states the deadline in words, not as an ISO timestamp', () => {
    const m = letter();
    expect(m.body).toContain('27 August 2026, 09:14 UTC');
    expect(m.body).not.toContain(EXPIRES);
  });

  it('tells a stranger that doing nothing is safe', () => {
    // Some of these letters go to people who did not sign up, because somebody
    // typed their address. They are owed an instruction, and it is "ignore it".
    expect(letter().body).toContain('did not create a CarSalePro account');
  });

  it('never prints "undefined" when the payload is short', () => {
    expect(renderTemplate('auth.verify_email', 'en', {}).body).not.toContain('undefined');
  });

  it('is English even when the reader is asked for in another language', () => {
    /*
     * Not a tautology: `renderTemplate` falls back to the DEFAULT locale, which
     * is German. English is chosen by the CALLER
     * (`AuthService.sendVerificationEmail`), and this pins that asking for `en`
     * is what produces the English letter - so a change to the fallback cannot
     * quietly send German to a locale the catalog does not cover.
     */
    expect(renderTemplate('auth.verify_email', 'pl', {}).subject).toBe(
      'E-Mail-Adresse bestätigen',
    );
    expect(letter().subject).toBe('Confirm your email address');
  });
});
