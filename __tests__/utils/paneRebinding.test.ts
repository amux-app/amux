// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsyncMock = vi.fn();

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: (...args: unknown[]) => execFileAsyncMock(...args),
}));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import {
  MUXBASE_PANE_INCARNATION_OPTION,
  ensureTmuxPaneIncarnationOption,
  stampTmuxPaneIncarnationOption,
} from '../../src/utils/paneRebinding.js';

beforeEach(() => {
  execFileAsyncMock.mockReset();
  execFileAsyncMock.mockResolvedValue('');
});

describe('stampTmuxPaneIncarnationOption', () => {
  it('mints a fresh UUID without ever reading the existing pane option', async () => {
    const incarnationId = await stampTmuxPaneIncarnationOption('%1');

    expect(incarnationId).toMatch(UUID_PATTERN);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'tmux',
      ['set', '-p', '-t', '%1', MUXBASE_PANE_INCARNATION_OPTION, incarnationId],
      { silent: true },
    );
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args[0] === 'show-options')).toBe(false);
  });

  it('mints a different UUID on every call, regardless of any pre-existing option value', async () => {
    const first = await stampTmuxPaneIncarnationOption('%1');
    const second = await stampTmuxPaneIncarnationOption('%1');

    expect(first).not.toBe(second);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('ensureTmuxPaneIncarnationOption', () => {
  it('reuses an existing incarnation option instead of minting a fresh one', async () => {
    execFileAsyncMock.mockResolvedValueOnce('existing-incarnation-id\n');

    const result = await ensureTmuxPaneIncarnationOption('%1');

    expect(result).toBe('existing-incarnation-id');
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'tmux',
      ['show-options', '-p', '-v', '-t', '%1', MUXBASE_PANE_INCARNATION_OPTION],
      { silent: true },
    );
  });

  it('mints a fresh incarnation when show-options returns an empty value', async () => {
    execFileAsyncMock.mockResolvedValueOnce('   \n');

    const result = await ensureTmuxPaneIncarnationOption('%1');

    expect(result).toMatch(UUID_PATTERN);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'tmux',
      ['set', '-p', '-t', '%1', MUXBASE_PANE_INCARNATION_OPTION, result],
      { silent: true },
    );
  });

  it('mints a fresh incarnation when the pane has no option set yet (show-options rejects)', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('no such option'));

    const result = await ensureTmuxPaneIncarnationOption('%1');

    expect(result).toMatch(UUID_PATTERN);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'tmux',
      ['set', '-p', '-t', '%1', MUXBASE_PANE_INCARNATION_OPTION, result],
      { silent: true },
    );
  });
});
