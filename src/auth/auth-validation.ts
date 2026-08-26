/**
 * The rules for the three fields a person types to get an account: name,
 * e-mail and password (DEN-187).
 *
 * They live in one file because the same rules are enforced twice - here, and
 * in the browser by `lib/auth-validation.ts` in the web app, which carries a
 * copy of these expressions. The browser copy is for the reader, so the
 * message arrives before the request does. THIS copy is the one that decides:
 * the API is public, the mobile app posts to it, and a form that validates
 * itself protects nobody.
 *
 * The messages below are CODES, not sentences. The web app shows text in 35
 * languages and cannot translate an English string that arrived in a 400; it
 * maps the code to its own catalogue. See `ValidationPipe` in `main.ts`, which
 * returns them in `message[]`.
 */

/** A name is at most this long. The column is wider; this is the rule. */
export const NAME_MAX = 100;

/**
 * Letters, and the three characters that join them inside a real name.
 *
 * `\p{L}` and not `[A-Za-z]`: the site serves 35 languages, and a rule that
 * only knows the Latin alphabet rejects Анна, Δημήτρης and 李 - people who are
 * trying to give us money. `u` makes `\p{L}` legal and makes the expression
 * count characters rather than UTF-16 code units.
 *
 * The space, the hyphen and the apostrophe are here on purpose, and this is a
 * DELIBERATE WIDENING of "letters only" as it was asked for:
 *
 *   - a space, or "Anna Maria" cannot register, and most of the world writes a
 *     full name with one;
 *   - a hyphen, for Anne-Marie and Müller-Lüdenscheidt;
 *   - an apostrophe, for O'Brien and D'Angelo.
 *
 * Everything else is still refused: digits, @, punctuation, emoji, and the
 * control characters that a paste from a PDF brings with it. To make the rule
 * strict after all, delete the three characters from the class - the tests name
 * each of them, so it will be obvious what stopped being accepted.
 */
export const NAME_PATTERN = /^[\p{L}][\p{L} '-]*$/u;

/**
 * A single at sign, something in front of it, and a dotted domain behind it.
 *
 * No attempt at RFC 5322. That grammar admits quoted strings, comments and
 * addresses at bare hostnames, and an expression that implements it is
 * unreadable and still not proof of delivery. The only proof is the
 * verification e-mail, which this codebase already sends; the pattern's job is
 * to catch a typo while the reader is still looking at the field.
 *
 * `@nestjs/class-validator`'s `@IsEmail` runs BESIDE this, not instead of it.
 * It is the stricter of the two on the local part; this one is what guarantees
 * the "with an @" shape the client asked for, and what the browser copy mirrors.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Passwords: eight characters at least, and a sane ceiling. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * Letters and digits, as the client asked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A SECURITY IMPROVEMENT, AND IT IS ONLY ON THE WAY IN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Forbidding punctuation makes passwords WEAKER: it removes about thirty
 * characters from the alphabet an attacker has to guess. It is applied because
 * it was asked for, and it is applied only where a password is CREATED -
 * registration and reset.
 *
 * `LoginDto` deliberately does not carry it. Accounts already exist whose
 * passwords contain a symbol, or predate the eight-character floor, and
 * enforcing the new rule at sign-in would lock those people out of their own
 * accounts with a message about character sets. Sign-in checks the password
 * against the hash; that is the only test that means anything there.
 */
export const PASSWORD_PATTERN = /^[A-Za-z0-9]+$/;

/** The codes returned in `message[]`, and the web app's map into its catalogue. */
export const AUTH_VALIDATION_CODES = {
  name: 'name_invalid',
  nameLength: 'name_too_long',
  email: 'email_invalid',
  passwordLength: 'password_too_short',
  passwordCharset: 'password_charset',
} as const;
