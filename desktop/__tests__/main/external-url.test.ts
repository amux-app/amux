import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../../src/main/utils/externalUrl';

describe('isSafeExternalUrl', () => {
  it('allows https and loopback http', () => {
    expect(isSafeExternalUrl('https://github.com/amux-app/amux')).toBe(true);
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:5173')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:5173')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1')).toBe(true);
    expect(isSafeExternalUrl('http://[::1]:8080')).toBe(true);
  });

  it('rejects public http', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
  });

  it('rejects protocols that should never be passed to openExternal', () => {
    expect(isSafeExternalUrl('file:///Users/me/secret.txt')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,hello')).toBe(false);
    expect(isSafeExternalUrl('ftp://example.com')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl('://')).toBe(false);
  });

  it('rejects out-of-range loopback-looking octets (URL parser rejects them before the regex)', () => {
    expect(isSafeExternalUrl('http://127.999.999.999')).toBe(false);
    expect(isSafeExternalUrl('http://127.0.0.256')).toBe(false);
  });
});
