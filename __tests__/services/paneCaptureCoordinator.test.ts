import { describe, expect, it, vi } from 'vitest';
import { PaneCaptureCoordinator } from '../../src/services/PaneCaptureCoordinator.js';
import type {
  PaneWindowCaptureBatch,
  PaneWindowCaptureRequest,
} from '../../src/utils/paneCapture.js';

function captureBatch(
  requests: PaneWindowCaptureRequest[],
  tmuxInvocations = 1,
): PaneWindowCaptureBatch {
  return {
    captures: new Map(requests.map(({ paneId }) => [
      paneId,
      { content: `content:${paneId}`, visibleFrame: `visible:${paneId}` },
    ])),
    tmuxInvocations,
  };
}

async function flushCoordinator(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('PaneCaptureCoordinator', () => {
  it('coalesces capture requests queued in the same event-loop turn', async () => {
    const deliver = vi.fn();
    const capture = vi.fn(async (requests: PaneWindowCaptureRequest[]) => captureBatch(requests));
    const coordinator = new PaneCaptureCoordinator(deliver, capture);

    coordinator.request({ generation: 1, paneId: 'pane-1', tmuxPaneId: '%1' });
    coordinator.request({ generation: 1, paneId: 'pane-2', tmuxPaneId: '%2' });
    await flushCoordinator();

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith([
      { lines: 30, paneId: '%1' },
      { lines: 30, paneId: '%2' },
    ]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(coordinator.getStats()).toEqual({
      batches: 1,
      captureRequests: 2,
      tmuxInvocations: 1,
    });
  });

  it('delivers an empty result when batch capture fails', async () => {
    const deliver = vi.fn();
    const coordinator = new PaneCaptureCoordinator(
      deliver,
      vi.fn().mockRejectedValue(new Error('tmux unavailable')),
    );

    coordinator.request({ generation: 4, paneId: 'pane-1', tmuxPaneId: '%1' });
    await flushCoordinator();

    expect(deliver).toHaveBeenCalledWith(
      { generation: 4, paneId: 'pane-1', tmuxPaneId: '%1' },
      { content: '', visibleFrame: '' },
    );
  });
});
