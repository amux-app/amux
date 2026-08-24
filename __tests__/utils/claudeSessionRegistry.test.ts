import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'aumx-registry-home-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const { ensureClaudeSessionHookSettings, ensureClaudeSessionShellWrapper, readRegisteredSession, registryRecordPath } = await import(
  '../../src/utils/claudeSessionRegistry'
);

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('claudeSessionRegistry', () => {
  it('writes the SessionStart hook script and a --settings file that references it', () => {
    // Act
    const settingsPath = ensureClaudeSessionHookSettings();

    // Assert
    expect(settingsPath).toBeTruthy();
    const settings = JSON.parse(readFileSync(settingsPath as string, 'utf8'));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain('record-claude-session.cjs');
    const scriptPath = command.match(/node '(.+)'/)?.[1] as string;
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('AUMX_PANE_ID');
    expect(script).toContain('Failed to record Claude session');
    expect(script).toContain('Notification');
    expect(script).toContain('PreCompact');
    expect(script).toContain('PostCompact');
    expect(script).toContain('background_tasks');
    expect(script).toContain('legacy-session-turn');
  });

  it('writes an executable shell wrapper for manual claude relaunches', () => {
    // Act
    const wrapperDir = ensureClaudeSessionShellWrapper('/tmp/aumx-hook.settings.json');

    // Assert
    expect(wrapperDir).toBeTruthy();
    const wrapperPath = join(wrapperDir as string, 'claude');
    expect(readFileSync(wrapperPath, 'utf8')).toContain("exec claude --settings '/tmp/aumx-hook.settings.json'");
    expect(statSync(wrapperPath).mode & 0o111).toBeTruthy();
  });

  it('reads back a registered pane -> transcript mapping', () => {
    // Arrange
    const paneId = 'aumx-123';
    mkdirSync(join(fakeHome, '.aumx', 'claude-sessions'), { recursive: true });
    writeFileSync(
      registryRecordPath(paneId),
      JSON.stringify({ paneId, sessionId: 'sess-1', transcriptPath: '/tmp/session.jsonl', updatedAt: Date.now() }),
    );

    // Act
    const record = readRegisteredSession(paneId);

    // Assert
    expect(record?.transcriptPath).toBe('/tmp/session.jsonl');
    expect(record?.sessionId).toBe('sess-1');
  });

  it('returns null for an unknown pane', () => {
    expect(readRegisteredSession('aumx-unknown')).toBeNull();
  });
});
