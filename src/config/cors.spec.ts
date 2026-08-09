import {
  VERCEL_PREVIEW,
  buildCorsOriginChecker,
  parseOriginList,
  resolveCorsOrigins,
} from './cors';

/** Run the express-style callback synchronously and return the allow decision. */
function check(allowed: string[], origin: string | undefined): boolean {
  const checker = buildCorsOriginChecker(allowed);
  let result: boolean | undefined;
  let error: Error | null = null;
  checker(origin, (err, allow) => {
    error = err;
    result = allow;
  });
  expect(error).toBeNull();
  return result === true;
}

describe('parseOriginList', () => {
  it('returns a single entry for a single value', () => {
    expect(parseOriginList('https://www.carsalepro.de')).toEqual(['https://www.carsalepro.de']);
  });

  it('splits on commas and trims surrounding whitespace', () => {
    expect(parseOriginList('https://a.example ,  https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('strips trailing slashes and lower-cases the scheme and host', () => {
    expect(parseOriginList('HTTPS://WWW.CarSalePro.DE/')).toEqual(['https://www.carsalepro.de']);
    expect(parseOriginList('https://a.example///')).toEqual(['https://a.example']);
  });

  it('drops blank entries', () => {
    expect(parseOriginList('')).toEqual([]);
    expect(parseOriginList('  ')).toEqual([]);
    expect(parseOriginList('https://a.example,, ,https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('dedupes entries that normalize to the same origin', () => {
    expect(parseOriginList('https://a.example, https://A.example/, https://a.example')).toEqual([
      'https://a.example',
    ]);
  });

  it('keeps the port, which is part of the origin', () => {
    expect(parseOriginList('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });
});

describe('resolveCorsOrigins', () => {
  it('puts the canonical origin first', () => {
    const list = resolveCorsOrigins('https://www.carsalepro.de', 'https://carsalepro.de');
    expect(list[0]).toBe('https://www.carsalepro.de');
    expect(list).toContain('https://carsalepro.de');
  });

  it('never duplicates the canonical origin when it also appears in CORS_ORIGINS', () => {
    const list = resolveCorsOrigins(
      'https://www.carsalepro.de',
      'https://www.carsalepro.de/, https://carsalepro.de',
    );
    expect(list).toEqual(['https://www.carsalepro.de', 'https://carsalepro.de']);
  });

  it('accepts a comma-separated WEB_ORIGIN and allows every entry', () => {
    const list = resolveCorsOrigins('https://www.carsalepro.de, https://carsalepro.de', '');
    expect(list).toEqual(['https://www.carsalepro.de', 'https://carsalepro.de']);
    // The canonical origin — the one used to build absolute URLs — is the first.
    expect(list[0]).toBe('https://www.carsalepro.de');
  });

  it('works with an empty CORS_ORIGINS', () => {
    expect(resolveCorsOrigins('http://localhost:3000', '')).toEqual(['http://localhost:3000']);
  });
});

describe('buildCorsOriginChecker', () => {
  const allowed = resolveCorsOrigins('https://www.carsalepro.de', 'https://carsalepro.de');

  it('allows the canonical origin', () => {
    expect(check(allowed, 'https://www.carsalepro.de')).toBe(true);
  });

  it('allows an extra configured origin', () => {
    expect(check(allowed, 'https://carsalepro.de')).toBe(true);
  });

  it('allows a request with no Origin header (server-to-server)', () => {
    expect(check(allowed, undefined)).toBe(true);
  });

  it('allows a Vercel preview deployment', () => {
    expect(check(allowed, 'https://x-1.vercel.app')).toBe(true);
    expect(VERCEL_PREVIEW.test('https://x-1.vercel.app')).toBe(true);
  });

  it('denies a look-alike domain', () => {
    expect(check(allowed, 'https://evil-carsalepro.de')).toBe(false);
  });

  it('denies the same host over plain http', () => {
    expect(check(allowed, 'http://www.carsalepro.de')).toBe(false);
  });

  it('denies a subdomain that only looks like a Vercel preview', () => {
    expect(check(allowed, 'https://evil.vercel.app.attacker.com')).toBe(false);
  });

  it('matches regardless of a trailing slash or host casing in the request', () => {
    expect(check(allowed, 'https://WWW.CarSalePro.de')).toBe(true);
  });
});
