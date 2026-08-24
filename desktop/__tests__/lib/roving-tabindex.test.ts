import { describe, expect, it } from 'vitest';
import { nextRovingIndex } from '../../src/renderer/lib/roving-tabindex';

const allAvailable = () => true;
const onlyEven = (i: number) => i % 2 === 0;

describe('nextRovingIndex', () => {
  it('returns current index for Home/End when already at boundary', () => {
    expect(nextRovingIndex('Home', 0, allAvailable, 3)).toBe(0);
    expect(nextRovingIndex('End', 2, allAvailable, 3)).toBe(2);
  });

  it('returns null for non-navigation keys', () => {
    expect(nextRovingIndex('a', 0, allAvailable, 3)).toBeNull();
    expect(nextRovingIndex('Tab', 0, allAvailable, 3)).toBeNull();
    expect(nextRovingIndex('Enter', 0, allAvailable, 3)).toBeNull();
  });

  it('moves forward and wraps with ArrowRight / ArrowDown', () => {
    expect(nextRovingIndex('ArrowRight', 0, allAvailable, 3)).toBe(1);
    expect(nextRovingIndex('ArrowDown', 1, allAvailable, 3)).toBe(2);
    expect(nextRovingIndex('ArrowRight', 2, allAvailable, 3)).toBe(0);
  });

  it('moves backward and wraps with ArrowLeft / ArrowUp', () => {
    expect(nextRovingIndex('ArrowLeft', 0, allAvailable, 3)).toBe(2);
    expect(nextRovingIndex('ArrowUp', 2, allAvailable, 3)).toBe(1);
    expect(nextRovingIndex('ArrowLeft', 1, allAvailable, 3)).toBe(0);
  });

  it('jumps to first / last available with Home / End, skipping disabled', () => {
    expect(nextRovingIndex('Home', 2, onlyEven, 3)).toBe(0);
    expect(nextRovingIndex('End', 0, onlyEven, 3)).toBe(2);
  });

  it('skips unavailable items when stepping forward', () => {
    // 0 and 2 are available, 1 is disabled — ArrowRight from 0 must land on 2.
    expect(nextRovingIndex('ArrowRight', 0, onlyEven, 3)).toBe(2);
  });

  it('skips unavailable items when stepping backward', () => {
    // 0 and 2 are available, 1 is disabled — ArrowLeft from 2 must land on 0.
    expect(nextRovingIndex('ArrowLeft', 2, onlyEven, 3)).toBe(0);
  });

  it('returns null when no items are available', () => {
    expect(nextRovingIndex('ArrowRight', 0, () => false, 3)).toBeNull();
  });

  it('returns null for empty groups', () => {
    expect(nextRovingIndex('ArrowRight', 0, allAvailable, 0)).toBeNull();
    expect(nextRovingIndex('Home', 0, allAvailable, 0)).toBeNull();
  });
});
