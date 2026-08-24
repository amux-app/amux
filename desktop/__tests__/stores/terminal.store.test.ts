import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from '../../src/renderer/stores/terminal.store';

describe('useTerminalStore', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      attachedPaneIds: new Set<string>(),
      seenPaneIds: new Set<string>(),
    });
  });

  it('attachPane tracks attachments without marking pane as seen', () => {
    useTerminalStore.getState().attachPane('pane-1');

    const state = useTerminalStore.getState();
    expect(state.attachedPaneIds.has('pane-1')).toBe(true);
    expect(state.seenPaneIds.has('pane-1')).toBe(false);
  });

  it('markPaneSeen records the pane as seen exactly once', () => {
    useTerminalStore.getState().markPaneSeen('pane-1');
    useTerminalStore.getState().markPaneSeen('pane-1');

    const state = useTerminalStore.getState();
    expect(state.seenPaneIds.has('pane-1')).toBe(true);
    expect(state.seenPaneIds.size).toBe(1);
  });

  it('detachPane removes active attachment but keeps seen state', () => {
    useTerminalStore.getState().attachPane('pane-1');
    useTerminalStore.getState().markPaneSeen('pane-1');
    useTerminalStore.getState().detachPane('pane-1');

    const state = useTerminalStore.getState();
    expect(state.attachedPaneIds.has('pane-1')).toBe(false);
    expect(state.seenPaneIds.has('pane-1')).toBe(true);
  });

  it('detachAll clears active attachments only', () => {
    useTerminalStore.getState().attachPane('pane-1');
    useTerminalStore.getState().attachPane('pane-2');
    useTerminalStore.getState().markPaneSeen('pane-1');
    useTerminalStore.getState().detachAll();

    const state = useTerminalStore.getState();
    expect(state.attachedPaneIds.size).toBe(0);
    expect(state.seenPaneIds.has('pane-1')).toBe(true);
  });
});
