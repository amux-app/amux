import type { MuxBasePane } from '../../src/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('legacy Claude renderer settings migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../../src/utils/atomicWrite.js');
  });

  it('launches new panes fullscreen while leaving persisted classic pane metadata untouched', async () => {
    const existingPane = {
      id: 'existing-classic-pane',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
    } as Pick<MuxBasePane, 'id' | 'claudeRenderer' | 'terminalFixedCols'>;
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => (
          filePath.endsWith('/.muxbase/settings.json') && !filePath.includes('/test-project/')
        )),
        readFileSync: vi.fn(() => JSON.stringify({ claudeFullscreenRendering: false })),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    vi.doMock('../../src/utils/atomicWrite.js', () => ({
      atomicWriteJsonSync: (filePath: string, data: unknown) => {
        writeFileSync(filePath, JSON.stringify(data, null, 2));
      },
    }));

    const [{ SettingsManager }, { resolveClaudeRendererEnvironment, resolvePaneTerminalProfile }] = await Promise.all([
      import('../../src/utils/settingsManager.js'),
      import('../../src/utils/paneTerminalProfile.js'),
    ]);
    const settings = new SettingsManager('/tmp/test-project').getSettings();
    const profile = resolvePaneTerminalProfile('claude', settings);

    expect(profile).toEqual({ claudeRenderer: 'fullscreen' });
    expect(resolveClaudeRendererEnvironment(profile)).toEqual({
      set: { CLAUDE_CODE_NO_FLICKER: '1' },
      unset: ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'],
    });
    expect(existingPane).toEqual({
      id: 'existing-classic-pane',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });
});
