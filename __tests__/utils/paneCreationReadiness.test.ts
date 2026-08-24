import { describe, expect, it, vi } from 'vitest';
import type { TmuxService } from '../../src/services/TmuxService.js';
import {
  isAgentReadyForInput,
  waitForAgentInputReady,
} from '../../src/utils/paneCreationReadiness.js';

const PI_READY_FRAME = [
  '────────────────────────────────────',
  '',
  '────────────────────────────────────',
  '~/projects/dmux (main)',
  '0.0%/1.0M (auto)  anthropic--claude-4.8-opus • high',
].join('\n');

const PI_SUBSCRIPTION_READY_FRAME = [
  '────────────────────────────────────',
  '~/projects/dmux (main)',
  '$0.000 (sub) 0.0%/1.0M (auto)  anthropic--claude-4.8-opus • high',
].join('\n');

const OPENCODE_READY_FRAME = [
  '┃  Ask anything... "Fix broken tests"',
  '┃  Build · GPT-5.5 Fast OpenAI',
  '~/projects/dmux:main  1.18.15',
].join('\n');

describe('isAgentReadyForInput', () => {
  it('recognizes the fresh Pi composer only when no active status indicator is visible', () => {
    expect(isAgentReadyForInput(PI_READY_FRAME, 'pi')).toBe(true);
    expect(isAgentReadyForInput(PI_SUBSCRIPTION_READY_FRAME, 'pi')).toBe(true);
    expect(isAgentReadyForInput(`⠋ Working...\n${PI_READY_FRAME}`, 'pi')).toBe(false);
    expect(isAgentReadyForInput(`⠙ Custom extension status\n${PI_READY_FRAME}`, 'pi')).toBe(false);
    expect(isAgentReadyForInput(`Working...\n${PI_READY_FRAME}`, 'pi')).toBe(false);
    expect(
      isAgentReadyForInput(`escape interrupt · ctrl+c/ctrl+d clear/exit\n${PI_READY_FRAME}`, 'pi'),
    ).toBe(false);
  });

  it('recognizes the OpenCode empty composer only when active chrome is absent', () => {
    expect(isAgentReadyForInput(OPENCODE_READY_FRAME, 'opencode')).toBe(true);
    expect(isAgentReadyForInput(`${OPENCODE_READY_FRAME}\nesc interrupt`, 'opencode')).toBe(false);
  });

  it('keeps ready markers scoped to their agent', () => {
    expect(isAgentReadyForInput(PI_READY_FRAME, 'opencode')).toBe(false);
    expect(isAgentReadyForInput(OPENCODE_READY_FRAME, 'pi')).toBe(false);
    expect(isAgentReadyForInput(PI_READY_FRAME, 'claude')).toBe(false);
  });
});

describe('waitForAgentInputReady', () => {
  it('resolves on the first ready capture', async () => {
    const getPaneContent = vi.fn()
      .mockResolvedValueOnce('pi booting')
      .mockResolvedValueOnce(PI_READY_FRAME);
    const tmux = { getPaneContent } as unknown as TmuxService;

    await expect(waitForAgentInputReady(tmux, '%1', 'pi', 500)).resolves.toBe(true);
    expect(getPaneContent).toHaveBeenCalledTimes(2);
  });

  it('returns false after a bounded wait when the prompt never becomes ready', async () => {
    const tmux = {
      getPaneContent: vi.fn().mockResolvedValue('pi booting'),
      paneExists: vi.fn().mockResolvedValue(true),
    } as unknown as TmuxService;

    await expect(waitForAgentInputReady(tmux, '%1', 'pi', 1)).resolves.toBe(false);
  });

  it('rejects when the early pane disappears instead of completing a zombie launch', async () => {
    const tmux = {
      getPaneContent: vi.fn().mockRejectedValue(new Error("can't find pane: %1")),
      paneExists: vi.fn().mockResolvedValue(false),
    } as unknown as TmuxService;

    await expect(waitForAgentInputReady(tmux, '%1', 'pi', 500)).rejects.toThrow(
      'Pane %1 disappeared during agent startup',
    );
  });
});
