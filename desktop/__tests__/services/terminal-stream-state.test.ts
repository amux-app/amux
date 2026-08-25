import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

import { capturePane, displayPaneFormat } from '../../src/main/services/terminal-stream-state';

const HOSTILE_PANE_ID = "%1'; touch /tmp/muxbase-pwn; #";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function lastExecFileCall(): [string, string[], Record<string, unknown>] {
  const call = execFileMock.mock.calls.at(-1);
  return [call[0] as string, call[1] as string[], call[2] as Record<string, unknown>];
}

describe('displayPaneFormat', () => {
  beforeEach(() => {
    execFileMock.mockReset().mockImplementation((
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => callback(null, '42\n', ''));
  });

  it('spawns tmux without a shell and keeps the pane id and format literal', async () => {
    // Arrange & Act
    const raw = await displayPaneFormat(HOSTILE_PANE_ID, '#{history_size}');

    // Assert
    const [file, args, options] = lastExecFileCall();
    expect(file).toBe('tmux');
    expect(args).toEqual(['display-message', '-p', '-t', HOSTILE_PANE_ID, '#{history_size}']);
    expect(options.shell).toBeUndefined();
    expect(raw).toBe('42\n');
  });

  it('rejects when tmux fails so callers apply their own default', async () => {
    // Arrange
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => callback(new Error("can't find pane: %404"), '', ''));

    // Act & Assert
    await expect(displayPaneFormat('%404', '#{alternate_on}')).rejects.toThrow("can't find pane");
  });
});

describe('capturePane', () => {
  beforeEach(() => {
    execFileMock.mockReset().mockImplementation((
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => callback(null, 'frame', ''));
  });

  it('spawns tmux without a shell and keeps the pane id literal', async () => {
    // Arrange & Act
    const content = await capturePane(HOSTILE_PANE_ID, { startLine: -5, endLine: -1 });

    // Assert
    const [file, args, options] = lastExecFileCall();
    expect(file).toBe('tmux');
    expect(args).toEqual([
      'capture-pane', '-t', HOSTILE_PANE_ID, '-p', '-e', '-N', '-S', '-5', '-E', '-1',
    ]);
    expect(options.shell).toBeUndefined();
    expect(content).toBe('frame');
  });
});
