import { describe, expect, it } from 'vitest';

import { validateAppliedContentSize } from './e2e/window-size-policy';

describe('validateAppliedContentSize', () => {
  it('accepts a macOS-clamped height when the responsive width and minimum height are preserved', () => {
    expect(validateAppliedContentSize(
      { width: 1600, height: 950 },
      [1600, 674],
      600,
    )).toEqual({ width: 1600, height: 674 });
  });

  it('accepts the exact requested content size', () => {
    expect(validateAppliedContentSize(
      { width: 800, height: 600 },
      [800, 600],
      600,
    )).toEqual({ width: 800, height: 600 });
  });

  it('rejects a clamped width because it changes responsive behavior', () => {
    expect(() => validateAppliedContentSize(
      { width: 1600, height: 950 },
      [1440, 900],
      600,
    )).toThrow('requires exactly 1600px of content width');
  });

  it('rejects a height below the minimum usable test viewport', () => {
    expect(() => validateAppliedContentSize(
      { width: 1600, height: 950 },
      [1600, 599],
      600,
    )).toThrow('at least 600px of content height');
  });

  it('rejects a missing application window', () => {
    expect(() => validateAppliedContentSize(
      { width: 1600, height: 950 },
      null,
      600,
    )).toThrow('received no application window');
  });
});
