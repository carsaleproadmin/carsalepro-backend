/*
 * What country a Stripe connected account is created in, and what kind of
 * business it belongs to.
 *
 * Both were hardcoded (`country: 'DE'`, `business_type: 'individual'`) until
 * 2026-08-19, which meant the platform could onboard exactly one population: a
 * German natural person or sole trader. A company anywhere — a GmbH, an OÜ, a
 * Polish sp. z o.o. — could not be paid out at all, and Express onboarding never
 * even offered the company form, because the account already claimed to be a
 * natural person.
 *
 * The rules live here, as a pure function, for the same reason
 * `inspector-contact.ts` does: they are decisions worth reading and asserting on
 * their own, away from Prisma and Stripe. The service maps a refusal onto an
 * HTTP envelope; nothing here knows about HTTP.
 */

import { isStripeBusinessType, type StripeBusinessType } from '../payments/stripe.service';

/**
 * ISO 3166-1 alpha-2, upper case, or null when the input cannot be one.
 *
 * The SHAPE is all that is checked. Whether Stripe supports payouts in that
 * country is Stripe's answer at the moment of the call, not a list to go stale
 * in this repo — a hardcoded roster would refuse a country the day Stripe adds
 * it, and every country Stripe drops would be a silent 500 either way. A
 * rejection comes back named (`connect_country_unsupported`) instead.
 */
export function normalizeCountryCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** What the caller asked for. Both keys optional — an inspector may say neither. */
export interface ConnectAccountRequest {
  country?: string | null;
  businessType?: string | null;
}

/** What the profile already holds. */
export interface StoredConnectAccount {
  accountId: string | null;
  country: string | null;
  businessType: string | null;
}

export interface ConnectAccountParams {
  /** ISO 3166-1 alpha-2, upper case. Always resolved — Stripe requires one. */
  country: string;
  /**
   * Null means "the inspector has not said", and it is passed to Stripe as an
   * ABSENT field so Express onboarding asks them. That is the freest default
   * available and strictly better than guessing: a wrong guess is a form the
   * applicant cannot complete honestly.
   */
  businessType: StripeBusinessType | null;
  /**
   * True when an account already exists and the caller named a DIFFERENT
   * business type. Stripe accepts the change until the account is verified, so
   * the service attempts it rather than storing a value the account does not
   * carry — an inspector who ticked "individual" by mistake would otherwise need
   * support to get out of it.
   */
  businessTypeChanged: boolean;
}

export type ConnectAccountResolution =
  | { ok: true; params: ConnectAccountParams }
  | { ok: false; code: 'country_invalid'; requested: string }
  | { ok: false; code: 'business_type_invalid'; requested: string }
  | { ok: false; code: 'country_locked'; stored: string; requested: string };

/**
 * Resolve the two parameters, or refuse.
 *
 * Precedence is request → stored → platform default. The platform default is
 * the last resort rather than the first answer so that an existing client which
 * sends no body keeps behaving exactly as it did (the default is the country
 * that used to be hardcoded), while an inspector who does answer is believed.
 *
 * The COUNTRY LOCK is the rule worth knowing: Stripe fixes an account's country
 * at creation and offers no way to change it — the account must be replaced. So
 * once an account exists, a request naming another country is refused. Ignoring
 * it would be worse in a way that is invisible: onboarding would open, the
 * inspector would submit German documents against a French account (or the
 * reverse), and the failure would surface as an unpayable account weeks later.
 *
 * An account with no stored country is read as belonging to the platform default
 * — that is literally what the old code sent, and what the backfill in
 * `20260819100000_inspector_stripe_country_business_type` writes. The two must
 * keep agreeing.
 *
 * `country_invalid` / `business_type_invalid` are unreachable through
 * `POST /inspector/stripe-onboarding`, whose DTO refuses both shapes first. They
 * exist because this function is total: a direct service call (a script, a
 * future admin route) must not be able to send junk to Stripe.
 */
export function resolveConnectAccountParams(
  request: ConnectAccountRequest,
  stored: StoredConnectAccount,
  platformCountry: string,
): ConnectAccountResolution {
  const fallback = normalizeCountryCode(platformCountry) ?? 'DE';

  let requestedCountry: string | null = null;
  if (typeof request.country === 'string' && request.country.trim() !== '') {
    requestedCountry = normalizeCountryCode(request.country);
    if (!requestedCountry) return { ok: false, code: 'country_invalid', requested: request.country };
  }

  let requestedBusinessType: StripeBusinessType | null = null;
  if (typeof request.businessType === 'string' && request.businessType.trim() !== '') {
    const candidate = request.businessType.trim().toLowerCase();
    if (!isStripeBusinessType(candidate)) {
      return { ok: false, code: 'business_type_invalid', requested: request.businessType };
    }
    requestedBusinessType = candidate;
  }

  const storedCountry = normalizeCountryCode(stored.country);
  const countryOfRecord = storedCountry ?? (stored.accountId ? fallback : null);

  if (stored.accountId && requestedCountry && countryOfRecord && requestedCountry !== countryOfRecord) {
    return { ok: false, code: 'country_locked', stored: countryOfRecord, requested: requestedCountry };
  }

  const country = stored.accountId
    ? (countryOfRecord ?? requestedCountry ?? fallback)
    : (requestedCountry ?? storedCountry ?? fallback);

  const storedBusinessType = isStripeBusinessType(stored.businessType) ? stored.businessType : null;
  const businessType = requestedBusinessType ?? storedBusinessType;

  return {
    ok: true,
    params: {
      country,
      businessType,
      businessTypeChanged: Boolean(
        stored.accountId && requestedBusinessType && requestedBusinessType !== storedBusinessType,
      ),
    },
  };
}
