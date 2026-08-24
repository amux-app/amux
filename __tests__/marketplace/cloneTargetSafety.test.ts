import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'dns/promises';
import { assertSafeCloneTarget, isPrivateIp } from '../../src/services/marketplace/urlSafety.js';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const resolveTo = (...addresses: string[]): void => {
  asMock(lookup).mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};

describe('isPrivateIp', () => {
  it('returns true for private/reserved ipv4 and ipv6 addresses', () => {
    // Arrange
    const privateIps = [
      '127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1',
      '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
    ];

    // Act / Assert
    for (const ip of privateIps) expect(isPrivateIp(ip), ip).toBe(true);
  });

  it('returns false for public addresses', () => {
    // Arrange / Act / Assert
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1']) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe('assertSafeCloneTarget', () => {
  afterEach(() => vi.clearAllMocks());

  it('rejects when a public hostname resolves to a loopback address', async () => {
    // Arrange
    resolveTo('127.0.0.1');

    // Act / Assert
    await expect(assertSafeCloneTarget('https://evil.attacker.com/repo')).rejects.toThrow('That host is not allowed');
    expect(lookup).toHaveBeenCalledWith('evil.attacker.com', { all: true });
  });

  it('resolves successfully when the hostname resolves to a public address', async () => {
    // Arrange
    resolveTo('8.8.8.8');

    // Act / Assert
    await expect(assertSafeCloneTarget('https://github.com/org/repo')).resolves.toBeUndefined();
  });

  it('rejects a mix where any single resolved address is private', async () => {
    // Arrange
    resolveTo('8.8.8.8', '169.254.169.254');

    // Act / Assert
    await expect(assertSafeCloneTarget('https://mixed.attacker.com/repo')).rejects.toThrow('That host is not allowed');
  });

  it('rejects an ip-literal url without performing a dns lookup', async () => {
    // Act / Assert
    await expect(assertSafeCloneTarget('https://127.0.0.1/repo')).rejects.toThrow('That host is not allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a trailing-dot loopback fqdn without a lookup', async () => {
    // Act / Assert
    await expect(assertSafeCloneTarget('https://localhost./x')).rejects.toThrow('That host is not allowed');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects non-https urls before any lookup', async () => {
    // Act / Assert
    await expect(assertSafeCloneTarget('http://github.com/org/repo')).rejects.toThrow('Only https:// URLs are supported');
    expect(lookup).not.toHaveBeenCalled();
  });
});
