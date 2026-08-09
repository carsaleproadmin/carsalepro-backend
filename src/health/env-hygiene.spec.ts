import {
  BOM,
  CRITICAL_ENV_VARS,
  describeEnvFinding,
  inspectCriticalEnv,
  inspectEnvValue,
} from './env-hygiene';

/**
 * The highest-value test in this wave: it reproduces the production Mapbox
 * defect exactly. A perfectly valid token, prefixed with an invisible BOM by
 * the editor it was pasted through, passed Joi, passed the build, passed
 * `/health`, and made every geocode 401 - so the order form told users with
 * valid addresses that their address did not exist.
 */
describe('env hygiene - BOM detector', () => {
  const token = 'pk.eyJ1IjoiY2Fyc2FsZXBybyIsImEiOiJjbHh4eHh4eHgifQ.abcdefghijklmnop';

  it('accepts the clean token', () => {
    const finding = inspectEnvValue('MAPBOX_TOKEN', token);
    expect(finding.present).toBe(true);
    expect(finding.issues).toEqual([]);
    expect(describeEnvFinding(finding)).toBe(`set (len ${token.length})`);
  });

  it('flags the same token once a BOM is prepended', () => {
    const finding = inspectEnvValue('MAPBOX_TOKEN', BOM + token);
    expect(finding.issues).toContain('bom');
    expect(describeEnvFinding(finding)).toBe(`set (len ${token.length + 1}) - has BOM`);
  });

  it('flags a BOM anywhere in the value, not only at the front', () => {
    expect(inspectEnvValue('X', `${token}${BOM}`).issues).toContain('bom');
    expect(inspectEnvValue('X', `pk.${BOM}rest`).issues).toContain('bom');
  });

  it('reports a leading BOM as `bom` alone, not also as wrapping whitespace', () => {
    // String.prototype.trim() treats U+FEFF as whitespace, so a naive
    // `value !== value.trim()` check would double-report and bury the real code.
    const finding = inspectEnvValue('MAPBOX_TOKEN', BOM + token);
    expect(finding.issues).toEqual(['bom']);
  });

  it('never puts a character of the value in the description', () => {
    const secret = 'sk_live_super_secret_key_value';
    const description = describeEnvFinding(inspectEnvValue('STRIPE_SECRET_KEY', BOM + secret));
    expect(description).not.toContain('sk_live');
    expect(description).not.toContain('secret');
    expect(description).toBe(`set (len ${secret.length + 1}) - has BOM`);
  });
});

describe('env hygiene - the other silent defects', () => {
  it('flags a trailing CR from a Windows paste', () => {
    expect(inspectEnvValue('JWT_SECRET', 'value\r').issues).toContain('crlf');
    expect(inspectEnvValue('JWT_SECRET', 'value\r\n').issues).toContain('crlf');
    expect(inspectEnvValue('JWT_SECRET', 'a\nb').issues).toContain('crlf');
  });

  it('flags wrapping whitespace', () => {
    expect(inspectEnvValue('R2_BUCKET', ' carsalepro-reports').issues).toContain('whitespace');
    expect(inspectEnvValue('R2_BUCKET', 'carsalepro-reports ').issues).toContain('whitespace');
    expect(inspectEnvValue('R2_BUCKET', 'carsalepro-reports').issues).toEqual([]);
  });

  it('does not flag inner spaces', () => {
    expect(inspectEnvValue('EMAIL_FROM', 'CarSalePro <no-reply@carsalepro.de>').issues).toEqual([]);
  });

  it('flags quotes a dashboard did not strip', () => {
    expect(inspectEnvValue('JWT_SECRET', '"secret"').issues).toContain('quoted');
    expect(inspectEnvValue('JWT_SECRET', "'secret'").issues).toContain('quoted');
    // Mismatched or one-sided quotes are not a wrapping pair.
    expect(inspectEnvValue('JWT_SECRET', '"secret').issues).not.toContain('quoted');
    expect(inspectEnvValue('JWT_SECRET', 'a"b"c').issues).not.toContain('quoted');
  });

  it('flags a non-breaking space copied out of a web page', () => {
    expect(inspectEnvValue('WEB_ORIGIN', 'https://carsalepro.de\u00A0').issues).toContain('nbsp');
  });

  it('flags stray control characters', () => {
    expect(inspectEnvValue('JWT_SECRET', 'val\u0000ue').issues).toContain('control');
    expect(inspectEnvValue('JWT_SECRET', 'val\tue').issues).toContain('control');
  });

  it('reports several defects on one value', () => {
    const finding = inspectEnvValue('MAPBOX_TOKEN', `${BOM}"pk.token"\r\n`);
    expect(finding.issues).toEqual(expect.arrayContaining(['bom', 'crlf', 'quoted']));
    expect(describeEnvFinding(finding)).toContain('has BOM');
    expect(describeEnvFinding(finding)).toContain('wrapped in quotes');
  });

  it('treats unset and empty alike, and a whitespace-only value as present-but-broken', () => {
    expect(describeEnvFinding(inspectEnvValue('X', undefined))).toBe('MISSING');
    expect(describeEnvFinding(inspectEnvValue('X', ''))).toBe('MISSING');
    const blank = inspectEnvValue('X', '   ');
    expect(blank.present).toBe(true);
    expect(blank.issues).toContain('whitespace');
  });
});

describe('the critical list', () => {
  it('covers the four variables the audit found wrong', () => {
    const names = CRITICAL_ENV_VARS.map((spec) => spec.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'MAPBOX_TOKEN',
        'CORS_ORIGINS',
        'WEB_ORIGIN',
        'R2_KYC_BUCKET',
        'R2_KYC_ACCESS_KEY_ID',
        'R2_KYC_SECRET_ACCESS_KEY',
        'JWT_SECRET',
        'DATABASE_URL',
      ]),
    );
  });

  it('lists every name once', () => {
    const names = CRITICAL_ENV_VARS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries an impact line for every entry (it is printed in the block)', () => {
    for (const spec of CRITICAL_ENV_VARS) {
      expect(spec.impact.length).toBeGreaterThan(0);
    }
  });

  it('inspects a supplied environment rather than only process.env', () => {
    const findings = inspectCriticalEnv({ JWT_SECRET: `${BOM}abc` } as NodeJS.ProcessEnv);
    const jwt = findings.find((f) => f.name === 'JWT_SECRET');
    expect(jwt?.issues).toEqual(['bom']);
    expect(findings.find((f) => f.name === 'MAPBOX_TOKEN')?.present).toBe(false);
  });
});
