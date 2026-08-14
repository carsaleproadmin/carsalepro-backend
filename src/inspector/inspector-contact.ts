/**
 * Contact channels for the two parties to an order, and the rules for turning
 * what someone typed into a link that works.
 *
 * A plain module rather than a provider, on purpose: `orders/`, `inspector/`
 * and `users/` all need these rules, and the moment two of them hold their own
 * copy the inspector's profile page and the customer's order page start
 * disagreeing about what is disclosed.
 *
 * Three rules live here and nowhere else:
 *
 * - **A phone is only WhatsApp-eligible when it parses to E.164 unaided.** The
 *   platform is international, so there is no default country to fall back on:
 *   `User.countryCode` is `@default("DE")` on every account and means "nobody
 *   changed it", not "this person is in Germany". Completing `601 234 567` with
 *   +49 would hand the customer a button that messages a stranger, and a wrong
 *   number is worse than a missing one — an absent button is honest.
 * - **Telegram is a username, not a number.** `wa.me/<digits>` exists;
 *   `t.me/<username>` is the only reliable public link Telegram offers. There is
 *   no stable https deep link to a chat by phone (`tg://resolve?phone=` needs an
 *   installed client, and `t.me/+…` is the invite-link format).
 * - **An erased account discloses nothing.** `UsersService.eraseMe` anonymises
 *   rather than deletes: the row survives with a tombstone address. Without the
 *   `deletedAt` check below, the email fallback would publish
 *   `deleted+<id>@carsalepro.invalid` to the customer as a live mailto: link.
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Telegram allows 5–32 of [A-Za-z0-9_]. Deliberately lenient beyond that. */
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/** Everything a username may arrive wrapped in. */
const TELEGRAM_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i;

export interface PartyContact {
  userId: string;
  name: string | null;
  /** Present for inspectors; always null for a customer. */
  companyName: string | null;
  /** Always present — every account has one, which is what makes it the guaranteed channel. */
  email: string;
  /** As stored. Free-form on purpose: `tel:` tolerates any national format. */
  phone: string | null;
  /**
   * Bare digits in E.164 order with no leading `+`, ready for `wa.me/<digits>`.
   * Null means no WhatsApp button — either the flag is off or the number could
   * not be resolved without guessing a country.
   */
  whatsapp: string | null;
  /** Bare username, no `@`. Render as `@name`, link as `t.me/<name>`. */
  telegram: string | null;
}

/** The `User` columns a contact is built from. */
export interface ContactUser {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  deletedAt: Date | null;
}

/** The `InspectorProfile` columns a contact is built from. */
export interface ContactProfile {
  companyName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactWhatsapp: boolean;
  contactTelegram: string | null;
}

/**
 * Normalise a Telegram username to its bare form.
 *
 * Accepts `@ivan`, `ivan`, `t.me/ivan`, `https://t.me/ivan?start=1` and the
 * telegram.me variants. Returns null for anything that is not a plausible
 * username — including an empty string, so a cleared field reads as "unset".
 *
 * Storing the raw input instead would produce `https://t.me/https://t.me/ivan`
 * the moment the link is built.
 */
export function normalizeTelegramUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  value = value.replace(TELEGRAM_URL_PREFIX, '');
  // Drop a query string or fragment (`?start=1`, `#top`) and any trailing slash.
  value = value.split(/[?#]/)[0].replace(/\/+$/, '');
  value = value.replace(/^@+/, '');

  return TELEGRAM_USERNAME.test(value) ? value : null;
}

/**
 * Normalise a phone number to E.164, or return null when that cannot be done
 * without assuming a country.
 *
 * `parsePhoneNumberFromString` is called WITHOUT a default country by design —
 * see the note at the top of this file. A number lacking a `+` therefore fails
 * here, which is the intended outcome: it stays usable for `tel:` and simply
 * earns no WhatsApp button.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith('+')) return null;
  const parsed = parsePhoneNumberFromString(value);
  return parsed?.isValid() ? parsed.number : null;
}

/** The digits `wa.me` wants: E.164 without the leading `+`. */
export function toWhatsappDigits(raw: string | null | undefined): string | null {
  const e164 = toE164(raw);
  return e164 ? e164.slice(1) : null;
}

/**
 * Build the contact block for one party, or null when there is nothing to
 * disclose.
 *
 * Null is returned for an erased account and for a missing user — never a
 * half-filled block, because the caller renders a card if this is non-null.
 *
 * `profile` is optional: a customer has no inspector profile, so their contact
 * is the User row alone, which is exactly why email is the channel that always
 * works.
 */
export function resolveContact(
  user: ContactUser | null | undefined,
  profile?: ContactProfile | null,
): PartyContact | null {
  if (!user) return null;
  // An erased account keeps its row for accounting. It discloses nothing.
  if (user.deletedAt) return null;

  const phone = profile?.contactPhone ?? user.phone ?? null;
  const email = profile?.contactEmail ?? user.email;

  return {
    userId: user.id,
    name: user.name,
    companyName: profile?.companyName ?? null,
    email,
    phone,
    whatsapp: profile?.contactWhatsapp ? toWhatsappDigits(phone) : null,
    telegram: normalizeTelegramUsername(profile?.contactTelegram),
  };
}
