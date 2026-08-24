import { describe, expect, it } from 'vitest';
import { compareTmuxVersions, isSupportedTmuxVersion, parseTmuxVersion } from '../../src/utils/tmuxVersion.js';

describe('parseTmuxVersion', () => {
  it('parses stable forms with and without a suffix', () => {
    // Arrange / Act / Assert
    expect(parseTmuxVersion('3.7')).toMatchObject({ major: 3, minor: 7, suffix: '' });
    expect(parseTmuxVersion('3.7a')).toMatchObject({ major: 3, minor: 7, suffix: 'a' });
    expect(parseTmuxVersion('3.7b')).toMatchObject({ major: 3, minor: 7, suffix: 'b' });
  });

  it('accepts the "tmux " prefix and surrounding whitespace while preserving raw', () => {
    // Arrange / Act
    const parsed = parseTmuxVersion('  tmux 3.6a  ');

    // Assert
    expect(parsed).toMatchObject({ major: 3, minor: 6, suffix: 'a', raw: 'tmux 3.6a' });
  });

  it('rejects malformed, prerelease, and trailing-text versions', () => {
    // Arrange / Act / Assert
    expect(parseTmuxVersion('next-3.8')).toBeNull();
    expect(parseTmuxVersion('3.7-rc')).toBeNull();
    expect(parseTmuxVersion('3.7b-openbsd')).toBeNull();
    expect(parseTmuxVersion('master')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('compareTmuxVersions', () => {
  const order = ['3.6a', '3.6b', '3.7', '3.7a', '3.7b', '3.8', '4.0'];

  it('orders the documented release sequence strictly ascending', () => {
    // Arrange / Act / Assert
    for (let i = 0; i < order.length - 1; i++) {
      const left = parseTmuxVersion(order[i])!;
      const right = parseTmuxVersion(order[i + 1])!;
      expect(compareTmuxVersions(left, right)).toBe(-1);
      expect(compareTmuxVersions(right, left)).toBe(1);
    }
  });

  it('treats identical versions as equal', () => {
    // Arrange / Act / Assert
    expect(compareTmuxVersions(parseTmuxVersion('3.7b')!, parseTmuxVersion('3.7b')!)).toBe(0);
  });
});

describe('isSupportedTmuxVersion', () => {
  it('accepts the exact minimum and every newer stable version', () => {
    // Arrange / Act / Assert
    for (const version of ['3.7b', '3.8', '3.10', '4.0']) {
      expect(isSupportedTmuxVersion(version, '3.7b')).toBe(true);
    }
  });

  it('rejects every version below the minimum, including near-misses', () => {
    // Arrange / Act / Assert
    for (const version of ['3.7', '3.7a', '3.6a', '2.9']) {
      expect(isSupportedTmuxVersion(version, '3.7b')).toBe(false);
    }
  });

  it('fails closed on unparseable input', () => {
    // Arrange / Act / Assert
    expect(isSupportedTmuxVersion('master', '3.7b')).toBe(false);
    expect(isSupportedTmuxVersion('3.7b', 'garbage')).toBe(false);
  });
});
