import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH } from '../src/renderer/lib/constants';

describe('sidebar width bounds', () => {
  it('publishes a default that fits the nav labels inside the drag range', () => {
    // Arrange & Act & Assert
    expect([SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH, SIDEBAR_MAX_WIDTH]).toEqual([180, 260, 480]);
  });

  it('clamps a persisted width to the drag range', () => {
    // Arrange
    const widths = [0, SIDEBAR_MIN_WIDTH - 1, SIDEBAR_MIN_WIDTH, 260, SIDEBAR_MAX_WIDTH, SIDEBAR_MAX_WIDTH + 1];

    // Act
    const clamped = widths.map(clampSidebarWidth);

    // Assert
    expect(clamped).toEqual([180, 180, 180, 260, 480, 480]);
  });

  it('falls back to the default when the persisted value is not a number', () => {
    // Arrange & Act & Assert
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH);
  });
});
