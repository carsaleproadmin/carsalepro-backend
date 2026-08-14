import {
  normalizeTelegramUsername,
  resolveContact,
  toE164,
  toWhatsappDigits,
  type ContactProfile,
  type ContactUser,
} from './inspector-contact';

const user = (over: Partial<ContactUser> = {}): ContactUser => ({
  id: 'usr_1',
  name: 'Anna Müller',
  email: 'anna@kfz-mueller.de',
  phone: null,
  deletedAt: null,
  ...over,
});

const profile = (over: Partial<ContactProfile> = {}): ContactProfile => ({
  companyName: 'KFZ Müller GmbH',
  contactPhone: null,
  contactEmail: null,
  contactWhatsapp: false,
  contactTelegram: null,
  ...over,
});

describe('normalizeTelegramUsername', () => {
  it.each([
    ['@kfz_mueller', 'kfz_mueller'],
    ['kfz_mueller', 'kfz_mueller'],
    ['t.me/kfz_mueller', 'kfz_mueller'],
    ['https://t.me/kfz_mueller', 'kfz_mueller'],
    ['https://t.me/kfz_mueller?start=1', 'kfz_mueller'],
    ['http://www.telegram.me/kfz_mueller/', 'kfz_mueller'],
    ['  @kfz_mueller  ', 'kfz_mueller'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeTelegramUsername(input)).toBe(expected);
  });

  it.each([
    ['', 'empty means unset'],
    ['   ', 'whitespace means unset'],
    ['abc', 'shorter than five characters'],
    ['a'.repeat(33), 'longer than thirty-two'],
    ['kfz mueller', 'a space is not a username'],
    ['kfz-mueller', 'a hyphen is not allowed'],
    ['https://example.com/kfz_mueller', 'not a Telegram host'],
  ])('refuses %j — %s', (input) => {
    expect(normalizeTelegramUsername(input)).toBeNull();
  });

  it('is idempotent, so re-saving a stored value cannot degrade it', () => {
    const once = normalizeTelegramUsername('https://t.me/kfz_mueller?start=1');
    expect(normalizeTelegramUsername(once)).toBe(once);
  });
});

describe('toE164', () => {
  it('accepts an international number regardless of country', () => {
    expect(toE164('+49 176 1234567')).toBe('+491761234567');
    expect(toE164('+48 601 234 567')).toBe('+48601234567');
    expect(toE164('+1 (415) 555-2671')).toBe('+14155552671');
  });

  /**
   * The whole point of the international rule. `User.countryCode` defaults to
   * "DE" on every account, so completing a local number would silently produce a
   * German number for a Polish inspector — and a WhatsApp link to a stranger.
   */
  it('refuses a local-format number rather than guessing a country', () => {
    expect(toE164('0176 1234567')).toBeNull();
    expect(toE164('601 234 567')).toBeNull();
  });

  it('refuses an invalid number that merely looks international', () => {
    expect(toE164('+49 1')).toBeNull();
    expect(toE164('+999 000 000')).toBeNull();
  });

  it('drops the plus for wa.me', () => {
    expect(toWhatsappDigits('+49 176 1234567')).toBe('491761234567');
    expect(toWhatsappDigits('0176 1234567')).toBeNull();
  });
});

describe('resolveContact', () => {
  it('falls back to the account phone and email when the profile sets none', () => {
    const contact = resolveContact(user({ phone: '+491761234567' }), profile());
    expect(contact).toMatchObject({
      email: 'anna@kfz-mueller.de',
      phone: '+491761234567',
      companyName: 'KFZ Müller GmbH',
    });
  });

  it('prefers the work contacts over the account ones', () => {
    const contact = resolveContact(
      user({ phone: '+491761234567', email: 'anna.private@example.com' }),
      profile({ contactPhone: '+49 30 1234567', contactEmail: 'kontakt@kfz-mueller.de' }),
    );
    expect(contact?.phone).toBe('+49 30 1234567');
    expect(contact?.email).toBe('kontakt@kfz-mueller.de');
  });

  it('offers WhatsApp only when the flag is set', () => {
    const off = resolveContact(user(), profile({ contactPhone: '+491761234567' }));
    expect(off?.whatsapp).toBeNull();

    const on = resolveContact(
      user(),
      profile({ contactPhone: '+491761234567', contactWhatsapp: true }),
    );
    expect(on?.whatsapp).toBe('491761234567');
  });

  it('offers no WhatsApp link for a local-format number even with the flag on', () => {
    const contact = resolveContact(
      user(),
      profile({ contactPhone: '0176 1234567', contactWhatsapp: true }),
    );
    // An absent button is honest; a wrong one messages a stranger.
    expect(contact?.whatsapp).toBeNull();
    expect(contact?.phone).toBe('0176 1234567');
  });

  it('normalises a stored Telegram value on the way out too', () => {
    const contact = resolveContact(user(), profile({ contactTelegram: '@kfz_mueller' }));
    expect(contact?.telegram).toBe('kfz_mueller');
  });

  it('works for a customer, who has no inspector profile', () => {
    const contact = resolveContact(user({ phone: '+491761234567' }));
    expect(contact).toMatchObject({ companyName: null, whatsapp: null, telegram: null });
    expect(contact?.email).toBe('anna@kfz-mueller.de');
  });

  /**
   * `eraseMe` anonymises rather than deletes, replacing the address with
   * `deleted+<id>@carsalepro.invalid`. Without this the email fallback would put
   * that tombstone on the customer's order card as a working mailto: link.
   */
  it('discloses nothing for an erased account', () => {
    const erased = user({
      email: 'deleted+usr_1@carsalepro.invalid',
      name: null,
      phone: null,
      deletedAt: new Date('2026-08-10T00:00:00.000Z'),
    });
    expect(resolveContact(erased, profile())).toBeNull();
  });

  it('returns null for a missing user rather than a half-filled block', () => {
    expect(resolveContact(null)).toBeNull();
    expect(resolveContact(undefined, profile())).toBeNull();
  });
});
