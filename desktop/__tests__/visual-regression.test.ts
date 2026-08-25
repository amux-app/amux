import { describe, expect, it } from 'vitest';
import { assertVisualDiff } from './e2e/visual-regression';

describe('visual regression thresholds', () => {
  it('accepts small rendering variance within both budgets', () => {
    expect(() => assertVisualDiff('fleet-dark', {
      actualHeight: 720,
      actualWidth: 1000,
      baselineHeight: 720,
      baselineWidth: 1000,
      changedPixelRatio: 0.001,
      meanChannelDelta: 0.4,
    })).not.toThrow();
  });

  it('accepts the observed macOS runner rasterization variance', () => {
    expect(() => assertVisualDiff('fleet-dark', {
      actualHeight: 720,
      actualWidth: 1000,
      baselineHeight: 720,
      baselineWidth: 1000,
      changedPixelRatio: 0.009,
      meanChannelDelta: 1.55,
    })).not.toThrow();
  });

  it('rejects a materially changed pixel area', () => {
    expect(() => assertVisualDiff('fleet-dark', {
      actualHeight: 720,
      actualWidth: 1000,
      baselineHeight: 720,
      baselineWidth: 1000,
      changedPixelRatio: 0.02,
      meanChannelDelta: 0.4,
    })).toThrow(/changed pixels/);
  });

  it('rejects a broad low-amplitude color shift', () => {
    expect(() => assertVisualDiff('fleet-dark', {
      actualHeight: 720,
      actualWidth: 1000,
      baselineHeight: 720,
      baselineWidth: 1000,
      changedPixelRatio: 0,
      meanChannelDelta: 3,
    })).toThrow(/mean channel delta/);
  });

  it('rejects dimension changes before evaluating pixels', () => {
    expect(() => assertVisualDiff('fleet-dark', {
      actualHeight: 719,
      actualWidth: 1000,
      baselineHeight: 720,
      baselineWidth: 1000,
      changedPixelRatio: 0,
      meanChannelDelta: 0,
    })).toThrow(/dimensions/);
  });
});
