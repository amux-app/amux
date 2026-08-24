import { describe, expect, it } from 'vitest';
import {
  isHeadlessE2E,
  resolveE2EActivationPolicy,
  resolveWindowOpacity,
} from '../../src/main/e2e-window-mode';

describe('isHeadlessE2E', () => {
  it('keeps ordinary application windows visible', () => {
    expect(isHeadlessE2E({ NODE_ENV: 'production' })).toBe(false);
    expect(isHeadlessE2E({ NODE_ENV: 'development', AUMX_E2E: '1' })).toBe(false);
  });

  it('hides E2E windows by default', () => {
    expect(isHeadlessE2E({ NODE_ENV: 'test', AUMX_E2E: '1' })).toBe(true);
  });

  it('shows E2E windows when headed mode is explicitly enabled', () => {
    expect(isHeadlessE2E({
      NODE_ENV: 'test',
      AUMX_E2E: '1',
      AUMX_E2E_HEADED: '1',
    })).toBe(false);
  });

  it('does not enable headed mode for ambiguous values', () => {
    expect(isHeadlessE2E({
      NODE_ENV: 'test',
      AUMX_E2E: '1',
      AUMX_E2E_HEADED: 'true',
    })).toBe(true);
  });
});

describe('resolveWindowOpacity', () => {
  it('keeps headless E2E windows transparent after persisted settings load', () => {
    expect(resolveWindowOpacity({ NODE_ENV: 'test', AUMX_E2E: '1' }, 0.85)).toBe(0);
  });

  it('preserves the configured opacity for normal and explicitly headed windows', () => {
    expect(resolveWindowOpacity({ NODE_ENV: 'production' }, 0.85)).toBe(0.85);
    expect(resolveWindowOpacity({
      NODE_ENV: 'test',
      AUMX_E2E: '1',
      AUMX_E2E_HEADED: '1',
    }, 0.85)).toBe(0.85);
  });
});

describe('resolveE2EActivationPolicy', () => {
  it('uses an accessory app on macOS for silent headless E2E runs', () => {
    expect(resolveE2EActivationPolicy(
      { NODE_ENV: 'test', AUMX_E2E: '1' },
      'darwin',
    )).toBe('accessory');
  });

  it('does not alter activation for headed, production, or non-macOS runs', () => {
    expect(resolveE2EActivationPolicy(
      { NODE_ENV: 'test', AUMX_E2E: '1', AUMX_E2E_HEADED: '1' },
      'darwin',
    )).toBeUndefined();
    expect(resolveE2EActivationPolicy({ NODE_ENV: 'production' }, 'darwin')).toBeUndefined();
    expect(resolveE2EActivationPolicy(
      { NODE_ENV: 'test', AUMX_E2E: '1' },
      'linux',
    )).toBeUndefined();
  });
});
