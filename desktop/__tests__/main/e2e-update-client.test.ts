import { describe, expect, it, vi } from 'vitest';
import { createE2EUpdateHarness } from '../../src/main/services/E2EUpdateClient';

describe('createE2EUpdateHarness', () => {
  it('cannot be enabled without both test-mode guards', () => {
    expect(createE2EUpdateHarness({
      MUXBASE_E2E: '1',
      MUXBASE_E2E_UPDATE_SCENARIO: 'ready',
      NODE_ENV: 'production',
    })).toBeNull();
    expect(createE2EUpdateHarness({
      MUXBASE_E2E_UPDATE_SCENARIO: 'ready',
      NODE_ENV: 'test',
    })).toBeNull();
  });

  it('emits a deterministic complete download only for the selected E2E scenario', async () => {
    vi.useFakeTimers();
    const harness = createE2EUpdateHarness({
      MUXBASE_E2E: '1',
      MUXBASE_E2E_UPDATE_SCENARIO: 'ready',
      MUXBASE_E2E_UPDATE_VERSION: '1.2.3',
      NODE_ENV: 'test',
    });
    expect(harness).not.toBeNull();

    const events: string[] = [];
    harness?.updater.on('update-available', () => events.push('available'));
    harness?.updater.on('download-progress', () => events.push('progress'));
    harness?.updater.on('update-downloaded', () => events.push('downloaded'));
    await harness?.updater.checkForUpdates();
    await vi.runAllTimersAsync();

    expect(events).toEqual(['available', 'progress', 'downloaded']);
    vi.useRealTimers();
  });

  it('models the Applications-folder gate without invoking a feed', () => {
    const harness = createE2EUpdateHarness({
      MUXBASE_E2E: '1',
      MUXBASE_E2E_UPDATE_SCENARIO: 'not-in-applications',
      NODE_ENV: 'test',
    });
    expect(harness?.inApplicationsFolder).toBe(false);
  });
});
