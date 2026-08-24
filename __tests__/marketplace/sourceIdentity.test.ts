import { describe, expect, it } from 'vitest';
import { canonicalizeSourceUrl, deriveCloneDirName } from '../../src/services/marketplace/sourceIdentity.js';

describe('canonicalizeSourceUrl', () => {
  it('normalizes .git suffix, trailing slash, and host case to the same value', () => {
    // Arrange
    const variants = [
      'https://github.com/a/b.git',
      'https://github.com/a/b/',
      'HTTPS://GitHub.com/a/b',
    ];

    // Act
    const canonical = variants.map(canonicalizeSourceUrl);

    // Assert
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('https://github.com/a/b');
  });

  it('preserves path case because git forge paths are case-sensitive', () => {
    // Arrange / Act
    const a = canonicalizeSourceUrl('https://github.com/Org/Tools');
    const b = canonicalizeSourceUrl('https://github.com/org/tools');

    // Assert
    expect(a).not.toBe(b);
  });

  it('drops the default https port', () => {
    // Arrange / Act
    const canonical = canonicalizeSourceUrl('https://github.com:443/a/b');

    // Assert
    expect(canonical).toBe('https://github.com/a/b');
  });

  it('throws on an unparseable url', () => {
    // Arrange / Act / Assert
    expect(() => canonicalizeSourceUrl('not a url')).toThrow();
  });
});

describe('deriveCloneDirName', () => {
  it('produces different dir names for urls that share a readable prefix', () => {
    // Arrange
    const a = 'https://github.com/Org/Tools';
    const b = 'https://github.com/org-tools';
    const c = `https://github.com/org/tools-${'x'.repeat(200)}`;

    // Act
    const nameA = deriveCloneDirName(a);
    const nameB = deriveCloneDirName(b);
    const nameC = deriveCloneDirName(c);

    // Assert
    expect(new Set([nameA, nameB, nameC]).size).toBe(3);
  });

  it('appends a 12-char hex hash for uniqueness', () => {
    // Arrange / Act
    const name = deriveCloneDirName('https://github.com/a/b');

    // Assert
    expect(name).toMatch(/-[0-9a-f]{12}$/);
  });

  it('is stable across equivalent canonical forms', () => {
    // Arrange / Act
    const a = deriveCloneDirName('https://github.com/a/b.git');
    const b = deriveCloneDirName('https://github.com/a/b/');

    // Assert
    expect(a).toBe(b);
  });
});
