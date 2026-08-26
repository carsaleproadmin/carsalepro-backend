import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { AUTH_VALIDATION_CODES as CODE } from './auth-validation';

/*
 * The rules a person meets on the way to an account (DEN-187).
 *
 * The DTOs are validated here rather than the raw expressions, because the
 * expression is not the rule - the decorator stack is. A `@Matches` that never
 * runs because `@IsOptional` swallowed the field passes any test written
 * against the regex alone.
 */

/** Every failure code the pipe would put in `message[]`. */
function codesFor(dto: object): string[] {
  return validateSync(dto, { whitelist: true }).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
}

function register(over: Partial<RegisterDto> = {}): string[] {
  return codesFor(
    plainToInstance(RegisterDto, {
      email: 'anna@example.com',
      password: 'hunter2hunter',
      name: 'Anna',
      gdprConsent: true,
      ...over,
    }),
  );
}

describe('registration: the name', () => {
  it.each([
    ['a plain one', 'Anna'],
    ['two words, which is how most of the world writes a name', 'Anna Maria'],
    ['a hyphen', 'Anne-Marie'],
    ['an apostrophe', "O'Brien"],
    // The site serves 35 languages. A rule that only knows the Latin alphabet
    // turns away paying customers, so these are the point of `\p{L}`.
    ['Cyrillic', 'Анна Волошко'],
    ['Greek', 'Δημήτρης'],
    ['Chinese', '李雷'],
    ['Arabic', 'محمد'],
    ['German with an umlaut and an eszett', 'Weiß Müller'],
    ['exactly 100 characters', 'a'.repeat(100)],
  ])('accepts %s', (_why, name) => {
    expect(register({ name })).toEqual([]);
  });

  it.each([
    ['a digit', 'Anna2'],
    ['an e-mail address pasted into the wrong field', 'anna@example.com'],
    ['punctuation', 'Anna!'],
    ['a full stop', 'Dr. Anna'],
    ['an underscore', 'anna_v'],
    ['a leading space', ' Anna'],
    ['a leading hyphen', '-Anna'],
    ['a newline, which a paste brings with it', 'Anna\nMaria'],
    ['emoji', 'Anna 🚗'],
    ['nothing at all', ''],
  ])('refuses %s', (_why, name) => {
    expect(register({ name })).toContain(CODE.name);
  });

  it('refuses 101 characters, and says which rule was broken', () => {
    const codes = register({ name: 'a'.repeat(101) });
    expect(codes).toContain(CODE.nameLength);
    // The length code, not the character-set one: "shorter than 100" and
    // "letters only" send the writer to two different edits.
    expect(codes).not.toContain(CODE.name);
  });

  it('is optional - an OAuth account arrives without one', () => {
    expect(register({ name: undefined })).toEqual([]);
  });
});

describe('registration: the e-mail', () => {
  it.each([
    ['a plain one', 'anna@example.com'],
    ['a subdomain', 'anna@mail.example.co.uk'],
    ['a plus tag', 'anna+cars@example.com'],
  ])('accepts %s', (_why, email) => {
    expect(register({ email })).toEqual([]);
  });

  it.each([
    ['no at sign', 'anna.example.com'],
    ['nothing before the at sign', '@example.com'],
    ['nothing after it', 'anna@'],
    ['no dot in the domain', 'anna@example'],
    ['a space', 'anna @example.com'],
    ['two at signs', 'anna@@example.com'],
    ['empty', ''],
  ])('refuses %s', (_why, email) => {
    expect(register({ email })).toContain(CODE.email);
  });
});

describe('registration: the password', () => {
  it.each([
    ['letters and digits', 'hunter2hunter'],
    ['letters alone', 'password'],
    ['digits alone', '12345678'],
    ['exactly eight', 'abcd1234'],
  ])('accepts %s', (_why, password) => {
    expect(register({ password })).toEqual([]);
  });

  it('refuses seven characters', () => {
    expect(register({ password: 'abc1234' })).toContain(CODE.passwordLength);
  });

  it.each([
    ['a symbol', 'hunter2!'],
    ['a space', 'hunter 2222'],
    ['a non-Latin letter, which the client asked to exclude', 'парольпароль'],
  ])('refuses %s', (_why, password) => {
    expect(register({ password })).toContain(CODE.passwordCharset);
  });

  it('is optional - an OAuth account has no password of its own', () => {
    expect(register({ password: undefined })).toEqual([]);
  });
});

describe('signing in', () => {
  const login = (over: Partial<LoginDto> = {}) =>
    codesFor(
      plainToInstance(LoginDto, {
        email: 'anna@example.com',
        password: 'hunter2hunter',
        ...over,
      }),
    );

  it('checks the shape of the e-mail', () => {
    expect(login({ email: 'anna.example.com' })).toContain(CODE.email);
  });

  /*
   * The point of the whole file. Accounts exist whose passwords hold a symbol,
   * or are shorter than the floor introduced today. Applying the creation rules
   * here would tell those people their own password is invalid - and no edit
   * they can make to the form would let them in.
   */
  it.each([
    ['a symbol', 'my-old-p@ssword!'],
    ['fewer than eight characters', 'short'],
  ])('accepts an existing password containing %s', (_why, password) => {
    expect(login({ password })).toEqual([]);
  });

  it('still refuses an empty password', () => {
    expect(login({ password: '' })).toContain(CODE.passwordLength);
  });
});
