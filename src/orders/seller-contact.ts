/**
 * What the order's contact field may hold — DEN-361, DEN-380.
 *
 * The field takes ONE of two answers (DEN-116): a telephone number the
 * inspector can call, or a link to the listing. Until DEN-361 it took any
 * text at all, so an order could reach an inspector carrying "ask Peter".
 *
 * A listing link can point to ANY website (DEN-380). Customers find cars on
 * other marketplaces too, and they must be able to paste those links. The
 * link must still be a real web address that the inspector can open.
 *
 * The website enforces the SAME rule in `lib/seller-contact.ts`, which is
 * where a customer sees the message. This copy is what makes the rule true:
 * the website is one client of this endpoint, and a rule that lives only in a
 * form is a rule anyone can walk around with curl.
 */
import { isValidPhoneNumber } from 'libphonenumber-js';

/** Development hosts, accepted only outside production. */
const DEV_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'] as const;

/** The last label of a public host name: letters, or an IDN in `xn--` form. */
const TOP_LEVEL_DOMAIN = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const PHONE_SHAPE = /^\+\s*[1-9][\d\s()./-]*$/;

/**
 * A telephone number.
 *
 * Loose about the shape and strict about the NUMBER. The customer reads the
 * number off a listing in any European formatting habit, thus spaces,
 * brackets, dashes, dots and the German slash are all accepted. The digits
 * are then checked against the numbering plan of the country (DEN-380): a
 * Ukrainian number must have 9 digits after `+380`, not "some" digits.
 *
 * The country code is REQUIRED, on the client's instruction (DEN-366): the
 * inspector who dials the number can be in a different country from the
 * seller, where a national number is unreachable. The test is the leading `+`
 * and a first digit that is not zero - no country code starts with a zero,
 * thus `0049...` and `030...` are national forms.
 */
export function isSellerPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!PHONE_SHAPE.test(trimmed)) return false;
  return isValidPhoneNumber(`+${trimmed.replace(/\D/g, '')}`);
}

function isPublicHost(hostname: string): boolean {
  const labels = hostname.split('.');
  // A bare word (`intranet`) and an IP address are not a website that the
  // inspector can open from a telephone. An IPv4 address ends in digits, so
  // the top-level check refuses it; IPv6 has no dots at all.
  if (labels.length < 2 || labels.some((label) => label === '')) return false;
  return TOP_LEVEL_DOMAIN.test(labels[labels.length - 1]);
}

/**
 * A link to a listing on any website. Only the scheme and the host are
 * checked: the path of a listing is different on each marketplace.
 */
export function isSellerListingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (isPublicHost(url.hostname)) return true;
  return (
    process.env.NODE_ENV !== 'production' &&
    (DEV_HOSTS as readonly string[]).includes(url.hostname)
  );
}

export function isValidSellerContact(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return isSellerPhone(trimmed) || isSellerListingUrl(trimmed);
}
