/**
 * What the order's contact field may hold — DEN-361.
 *
 * The field takes ONE of two answers (DEN-116): a telephone number the
 * inspector can call, or a link to the listing. Until this rule it took any
 * text at all, so an order could reach an inspector carrying "ask Peter" or a
 * link to a marketplace this platform cannot open the photographs of.
 *
 * A listing link must be a listing ON THIS SITE. The car is expected to be
 * published here, and the inspector opens that page before driving out.
 *
 * The website enforces the SAME rule in `lib/seller-contact.ts`, which is
 * where a customer sees the message. This copy is what makes the rule true:
 * the website is one client of this endpoint, and a rule that lives only in a
 * form is a rule anyone can walk around with curl.
 */

/** Our own hosts. `www.` is accepted on each; no other subdomain is. */
const SITE_HOSTS = ['carsalepro.de', 'carsalepro.net', 'carsalepro.us'] as const;

/** Development hosts, accepted only outside production. */
const DEV_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'] as const;

/** A car listing is `/cars/<id>`, optionally behind a locale prefix. */
const LISTING_SEGMENT = 'cars';

/**
 * A locale prefix as the website's router writes one: `ru`, `pt`, `zh-Hant`.
 * Matched by SHAPE rather than against the list of 35 tags, which lives in the
 * website and is not worth a second copy here — the segment after it still has
 * to be `cars`, so a wrong guess fails on the route and not on the language.
 */
const LOCALE_SEGMENT = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

const PHONE_SHAPE = /^\+\s*[1-9][\d\s()./-]*$/;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

/**
 * A telephone number.
 *
 * Loose about the shape and strict about the LENGTH, for the reason written
 * out in the website's copy: the number is read off a listing by a customer in
 * any European formatting habit, and rejecting a number written correctly is
 * worse than accepting one written oddly. The country code is REQUIRED, on the
 * client's instruction (DEN-366): the inspector who dials the number can be in
 * a different country from the seller, where a national number is unreachable.
 * The test is the leading `+` and a first digit that is not zero - no country
 * code starts with a zero, thus `0049...` and `030...` are national forms.
 */
export function isSellerPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!PHONE_SHAPE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '').length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

function allowedHosts(): string[] {
  const hosts = SITE_HOSTS.flatMap((host) => [host, `www.${host}`]);
  return process.env.NODE_ENV === 'production' ? hosts : [...hosts, ...DEV_HOSTS];
}

/**
 * A link to a car listing on this site. Host AND path: a link to the start
 * page is on our domain and still tells the inspector nothing about the car.
 */
export function isSellerListingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!allowedHosts().includes(url.hostname)) return false;

  const segments = url.pathname.split('/').filter(Boolean);
  const rest =
    segments.length > 0 && LOCALE_SEGMENT.test(segments[0]) && segments[0] !== LISTING_SEGMENT
      ? segments.slice(1)
      : segments;
  return rest.length === 2 && rest[0] === LISTING_SEGMENT && rest[1].length > 0;
}

export function isValidSellerContact(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return isSellerPhone(trimmed) || isSellerListingUrl(trimmed);
}
