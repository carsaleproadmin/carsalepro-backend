import { normalizeCompact, normalizeSearchText } from '../common/search-text';

/**
 * The three derived columns the showroom actually searches - DEN-205.
 *
 * `citySearch`, `makeSearch` and `modelSearch` are folded copies of `city`,
 * `make` and `model`: lower case, no diacritics, Cyrillic transliterated, and -
 * for the two car fields - no separators either. The filters match on THESE, so
 * a row written without them exists and cannot be found, which is exactly the
 * defect this work started from.
 *
 * Prisma 6 removed `$use`, so there is no middleware to hang this on and no way
 * to make it automatic below every caller. This function is the next best
 * thing: one definition, spread at each write, and named so that a reader
 * building a listing row by hand can see that the columns exist at all. Both
 * production writes are in `listings.service.ts`; test fixtures that construct
 * rows directly need it too.
 *
 * A missing key gives an empty string rather than null, so "this row has been
 * normalized and has no city" stays distinguishable from "nobody has normalized
 * this row yet", which is what the nullable column means.
 */
export function listingSearchColumns(row: {
  city?: string | null;
  make?: string | null;
  model?: string | null;
}): { citySearch: string; makeSearch: string; modelSearch: string } {
  return {
    citySearch: normalizeSearchText(row.city),
    makeSearch: normalizeCompact(row.make),
    modelSearch: normalizeCompact(row.model),
  };
}
