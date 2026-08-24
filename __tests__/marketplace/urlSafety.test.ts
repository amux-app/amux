import { describe, expect, it } from 'vitest';
import { isBlockedHost, validateSourceUrl } from '../../src/services/marketplace/urlSafety.js';

describe('validateSourceUrl', () => {
  it('accepts a public https url', () => {
    // Arrange / Act / Assert
    expect(validateSourceUrl('https://github.com/org/repo')).toBeNull();
  });

  it('rejects non-https protocols', () => {
    // Arrange / Act / Assert
    expect(validateSourceUrl('http://github.com/org/repo')).toBe('Only https:// URLs are supported');
  });

  it('rejects an invalid url', () => {
    // Arrange / Act / Assert
    expect(validateSourceUrl('not a url')).toBe('Invalid URL');
  });

  it('rejects a blocked host over https', () => {
    // Arrange / Act / Assert
    expect(validateSourceUrl('https://127.0.0.1/repo')).toBe('That host is not allowed');
  });
});

describe('isBlockedHost', () => {
  it('blocks localhost and loopback', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('::1')).toBe(true);
  });

  it('blocks private ipv4 ranges', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('169.254.0.1')).toBe(true);
    expect(isBlockedHost('172.16.5.5')).toBe(true);
  });

  it('blocks numeric-encoding bypasses', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('2130706433')).toBe(true);
    expect(isBlockedHost('0x7f.0.0.1')).toBe(true);
    expect(isBlockedHost('0177.0.0.1')).toBe(true);
  });

  it('blocks ipv4-mapped ipv6', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true);
  });

  it('blocks nat64-embedded private ipv4', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('64:ff9b::7f00:1')).toBe(true);
    expect(isBlockedHost('[64:ff9b::7f00:1]')).toBe(true);
  });

  it('blocks nat64 local-use prefix embedding a private ipv4', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('64:ff9b:1::7f00:1')).toBe(true);
  });

  it('blocks 6to4 wrapping a private ipv4 but allows 6to4 of a public ipv4', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('2002:0a00:0001::')).toBe(true); // 10.0.0.1
    expect(isBlockedHost('2002:7f00:0001::')).toBe(true); // 127.0.0.1
    expect(isBlockedHost('2002:0808:0808::')).toBe(false); // 8.8.8.8, public
  });

  it('blocks fqdn-rooted trailing-dot loopback bypasses', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('localhost.')).toBe(true);
    expect(isBlockedHost('127.0.0.1.')).toBe(true);
    expect(isBlockedHost('foo.localhost.')).toBe(true);
  });

  it('allows a normal public host', () => {
    // Arrange / Act / Assert
    expect(isBlockedHost('github.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('2606:4700::1')).toBe(false);
  });
});
