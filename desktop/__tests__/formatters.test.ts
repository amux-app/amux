import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTime, formatUSD, truncatePath } from '../src/renderer/lib/formatters';
import { useProjectStore } from '../src/renderer/stores/project.store';

describe('formatRelativeTime', () => {
  it('formats older timestamps with month and year buckets', () => {
    // Arrange
    vi.setSystemTime(new Date('2026-05-19T12:00:00Z'));
    const now = Date.now();

    try {
      // Act + Assert
      expect(formatRelativeTime(now - 45 * 24 * 60 * 60 * 1000)).toBe('1mo ago');
      expect(formatRelativeTime(now - 400 * 24 * 60 * 60 * 1000)).toBe('1y ago');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatUSD', () => {
  it('renders 4 decimals below $1 and 2 decimals at or above', () => {
    expect(formatUSD(0.0042)).toBe('$0.0042');
    expect(formatUSD(0.5)).toBe('$0.5000');
    expect(formatUSD(1)).toBe('$1.00');
    expect(formatUSD(12.5)).toBe('$12.50');
  });

  it('renders zero and non-finite inputs as $0', () => {
    expect(formatUSD(0)).toBe('$0');
    expect(formatUSD(Number.NaN)).toBe('$0');
    expect(formatUSD(Number.POSITIVE_INFINITY)).toBe('$0');
  });
});

describe('truncatePath', () => {
  afterEach(() => {
    useProjectStore.setState({ homeDir: '' });
  });

  it('collapses a non-/Users home dir reported by the session payload', () => {
    // Arrange
    useProjectStore.setState({ homeDir: '/home/bob' });

    // Act + Assert
    expect(truncatePath('/home/bob/projects/very-long-nested-project-name')).toBe(
      '~/projects/very-long-nested-project-name',
    );
  });

  it('does not collapse a sibling path that only shares the home prefix', () => {
    // Arrange
    useProjectStore.setState({ homeDir: '/Users/alice' });

    // Act + Assert
    expect(truncatePath('/Users/alice-work/projects/very-long-nested-project-name')).toBe(
      '...ork/projects/very-long-nested-project-name',
    );
  });
});
