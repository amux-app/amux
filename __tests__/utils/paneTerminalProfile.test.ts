import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AumxPane } from '../../src/types.js';
import {
  CLAUDE_TERMINAL_COLS,
  hasValidPaneTerminalProfile,
  resolveClaudeRendererEnvironment,
  resolvePaneTerminalProfile,
} from '../../src/utils/paneTerminalProfile.js';
import {
  resolvePaneBirthGeometry,
  resizePaneBeforeAgentLaunch,
} from '../../src/utils/paneTerminalGeometry.js';
import { execAsync } from '../../src/utils/execAsync.js';

vi.mock('../../src/utils/execAsync.js', () => ({
  execAsync: vi.fn(async () => ''),
}));

describe('pane terminal profile', () => {
  it('makes classic Claude a persisted exact-width profile', () => {
    expect(resolvePaneTerminalProfile('claude', { claudeFullscreenRendering: false }))
      .toEqual({
        claudeRenderer: 'classic',
        terminalFixedCols: CLAUDE_TERMINAL_COLS,
      });
    expect(CLAUDE_TERMINAL_COLS).toBe(100);
  });

  it('leaves fullscreen Claude and other agents fluid-width', () => {
    expect(resolvePaneTerminalProfile('claude', { claudeFullscreenRendering: true }))
      .toEqual({ claudeRenderer: 'fullscreen' });
    expect(resolvePaneTerminalProfile('claude', {}))
      .toEqual({ claudeRenderer: 'fullscreen' });
    expect(resolvePaneTerminalProfile('codex', {})).toEqual({});
    expect(resolvePaneTerminalProfile('opencode', {})).toEqual({});
    expect(resolvePaneTerminalProfile(undefined, {})).toEqual({});
  });

  it('resolves exact, two-way Claude renderer environments', () => {
    expect(resolveClaudeRendererEnvironment({ claudeRenderer: 'fullscreen' })).toEqual({
      set: { CLAUDE_CODE_NO_FLICKER: '1' },
      unset: ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'],
    });
    expect(resolveClaudeRendererEnvironment({
      claudeRenderer: 'classic',
      terminalFixedCols: CLAUDE_TERMINAL_COLS,
    })).toEqual({
      set: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
      unset: ['CLAUDE_CODE_NO_FLICKER'],
    });
  });

  it('round-trips terminal policy through the persisted pane JSON', () => {
    const pane: AumxPane = {
      id: 'aumx-1',
      slug: 'task',
      prompt: 'task',
      paneId: '%1',
      agent: 'claude',
      ...resolvePaneTerminalProfile('claude', {}),
    };

    expect(JSON.parse(JSON.stringify(pane))).toMatchObject({
      claudeRenderer: 'fullscreen',
    });
  });

  it('rejects mixed persisted Claude renderer profiles at runtime', () => {
    expect(hasValidPaneTerminalProfile({ claudeRenderer: 'fullscreen' })).toBe(true);
    expect(hasValidPaneTerminalProfile({
      claudeRenderer: 'classic',
      terminalFixedCols: CLAUDE_TERMINAL_COLS,
    })).toBe(true);
    expect(hasValidPaneTerminalProfile({
      claudeRenderer: 'fullscreen',
      terminalFixedCols: CLAUDE_TERMINAL_COLS,
    })).toBe(false);
    expect(hasValidPaneTerminalProfile({ claudeRenderer: 'classic' })).toBe(false);
    expect(hasValidPaneTerminalProfile({ terminalFixedCols: CLAUDE_TERMINAL_COLS })).toBe(false);
  });
});

describe('pane birth geometry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execAsync).mockImplementation(async (command) => (
      command.includes('display-message') ? '100x24' : ''
    ));
  });

  it('establishes a fixed width even when no preferred rows are available', () => {
    expect(resolvePaneBirthGeometry(
      { claudeRenderer: 'classic', terminalFixedCols: 100 },
      null,
    )).toEqual({ cols: 100 });
  });

  it('keeps preferred rows while replacing the width with the exact profile width', () => {
    expect(resolvePaneBirthGeometry(
      { claudeRenderer: 'classic', terminalFixedCols: 100 },
      { cols: 144, rows: 42 },
    )).toEqual({ cols: 100, rows: 42 });
  });

  it('keeps fluid profiles at the proposed geometry', () => {
    expect(resolvePaneBirthGeometry(
      { claudeRenderer: 'fullscreen' },
      { cols: 144, rows: 42 },
    )).toEqual({ cols: 144, rows: 42 });
    expect(resolvePaneBirthGeometry({}, null)).toBeNull();
  });

  it('resizes the isolated window and pane before launch with width-only geometry', async () => {
    await resizePaneBeforeAgentLaunch('%9', { cols: 100 });

    expect(execAsync).toHaveBeenNthCalledWith(
      1,
      "tmux resize-window -t '%9' -x 100",
      { timeout: 5000 },
    );
    expect(execAsync).toHaveBeenNthCalledWith(
      2,
      "tmux resize-pane -t '%9' -x 100",
      { timeout: 5000 },
    );
    expect(execAsync).toHaveBeenNthCalledWith(
      3,
      "tmux display-message -t '%9' -p '#{pane_width}x#{pane_height}'",
      { timeout: 5000 },
    );
  });

  it.each([
    ['width', { cols: 100 }, '99x24'],
    ['rows', { cols: 100, rows: 42 }, '100x41'],
  ] as const)('rejects a successful tmux command when reported %s does not match', async (_dimension, geometry, reported) => {
    vi.mocked(execAsync).mockImplementation(async (command) => (
      command.includes('display-message') ? reported : ''
    ));

    await expect(resizePaneBeforeAgentLaunch('%9', geometry))
      .rejects.toThrow(`did not reach requested birth geometry`);
  });
});
