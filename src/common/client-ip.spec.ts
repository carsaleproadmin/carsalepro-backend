import { resolveClientIp } from './client-ip';

const KEY = 'internal-key';

describe('resolveClientIp (DEN-417)', () => {
  it('uses x-client-ip when the internal key is correct', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-client-ip': '203.0.113.7', 'x-internal-key': KEY, 'cf-connecting-ip': '198.51.100.1' },
    };
    expect(resolveClientIp(req, KEY)).toBe('203.0.113.7');
  });

  it('ignores x-client-ip with a wrong key or with no key', () => {
    const wrong = {
      ip: '10.0.0.1',
      headers: { 'x-client-ip': '203.0.113.7', 'x-internal-key': 'nope', 'cf-connecting-ip': '198.51.100.1' },
    };
    const none = { ip: '10.0.0.1', headers: { 'x-client-ip': '203.0.113.7' } };
    expect(resolveClientIp(wrong, KEY)).toBe('198.51.100.1');
    expect(resolveClientIp(none, KEY)).toBe('10.0.0.1');
  });

  it('ignores x-client-ip when the server has no key', () => {
    const req = { ip: '10.0.0.1', headers: { 'x-client-ip': '203.0.113.7', 'x-internal-key': '' } };
    expect(resolveClientIp(req, '')).toBe('10.0.0.1');
  });

  it('uses cf-connecting-ip before req.ip', () => {
    expect(resolveClientIp({ ip: '10.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.1' } }, KEY)).toBe(
      '198.51.100.1',
    );
  });

  it('falls back to req.ip, then to a constant', () => {
    expect(resolveClientIp({ ip: '127.0.0.1', headers: {} }, KEY)).toBe('127.0.0.1');
    expect(resolveClientIp({ headers: {} }, KEY)).toBe('unknown');
  });
});
