import type { AumxPane, AumxSettings } from '../types.js';

export const CLAUDE_TERMINAL_COLS = 100;

export type PaneTerminalProfile =
  | {
    claudeRenderer: 'classic';
    terminalFixedCols: typeof CLAUDE_TERMINAL_COLS;
  }
  | {
    claudeRenderer: 'fullscreen';
    terminalFixedCols?: never;
  }
  | {
    claudeRenderer?: never;
    terminalFixedCols?: never;
  };

type TerminalProfileSettings = Pick<AumxSettings, 'claudeFullscreenRendering'>;

type ClaudeTerminalProfile = Extract<PaneTerminalProfile, { claudeRenderer: 'classic' | 'fullscreen' }>;

export interface ClaudeRendererEnvironment {
  set: Record<string, string>;
  unset: readonly string[];
}

export function claudeUsesFullscreen(settings: TerminalProfileSettings): boolean {
  return settings.claudeFullscreenRendering !== false;
}

/**
 * Resolve the launch-time terminal contract that is persisted with a pane.
 * Consumers read the pane metadata; they never need to repeat the policy.
 */
export function resolvePaneTerminalProfile(
  agent: AumxPane['agent'],
  settings: TerminalProfileSettings,
): PaneTerminalProfile {
  if (agent !== 'claude') return {};

  if (claudeUsesFullscreen(settings)) {
    return { claudeRenderer: 'fullscreen' };
  }

  return {
    claudeRenderer: 'classic',
    terminalFixedCols: CLAUDE_TERMINAL_COLS,
  };
}

export function resolveClaudeRendererEnvironment(
  profile: ClaudeTerminalProfile,
): ClaudeRendererEnvironment {
  if (profile.claudeRenderer === 'fullscreen') {
    return {
      set: { CLAUDE_CODE_NO_FLICKER: '1' },
      unset: ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'],
    };
  }

  return {
    set: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
    unset: ['CLAUDE_CODE_NO_FLICKER'],
  };
}

export function hasValidPaneTerminalProfile(
  pane: Pick<AumxPane, 'claudeRenderer' | 'terminalFixedCols'>,
): boolean {
  if (pane.claudeRenderer === 'fullscreen') return pane.terminalFixedCols === undefined;
  if (pane.claudeRenderer === 'classic') return pane.terminalFixedCols === CLAUDE_TERMINAL_COLS;
  return pane.terminalFixedCols === undefined;
}
