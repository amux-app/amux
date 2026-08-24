// @vitest-environment happy-dom
/**
 * Boot-window reconciliation always re-fetches the authoritative pane list
 * on the ready transition. Runtime activity is delivered through its own
 * epoch-versioned snapshot/delta channel.
 */
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, IPC_EVENT } from '../src/shared/ipc-channels';
import type { AppBootState } from '../src/shared/ipc-types';
import { usePaneStore } from '../src/renderer/stores/pane.store';

const ipcMock = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      listeners.set(channel, cb);
      return () => {
        listeners.delete(channel);
      };
    }),
    emit(channel: string, payload: unknown) {
      listeners.get(channel)?.(payload);
    },
    reset() {
      listeners.clear();
    },
  };
});

vi.mock('../src/renderer/api/ipc', () => ({
  invoke: ipcMock.invoke,
  on: ipcMock.on,
}));

vi.mock('../src/renderer/components/layout/AppShell', () => ({ AppShell: () => null }));
vi.mock('../src/renderer/components/create/CreatePaneDialog', () => ({ CreatePaneDialog: () => null }));
vi.mock('../src/renderer/components/command-palette/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/renderer/components/workspace-picker/WorkspacePicker', () => ({ WorkspacePicker: () => null }));
vi.mock('../src/renderer/components/decompose/DecomposeSideSheet', () => ({ DecomposeSideSheet: () => null }));
vi.mock('../src/renderer/components/shared/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../src/renderer/components/app-boot/AppBootOverlay', () => ({ AppBootOverlay: () => null }));

import App from '../src/renderer/App';

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'working',
    id: 'pane-a',
    paneId: '%1',
    prompt: '',
    slug: 'pane-a',
    ...overrides,
  } as AumxPane;
}

function bootState(overrides: Partial<AppBootState> = {}): AppBootState {
  return { phase: 'starting', revision: 0, ...overrides } as AppBootState;
}

function defaultInvokeHandler(channel: string): unknown {
  switch (channel) {
    case IPC.APP_BOOT_STATE_GET:
      return bootState();
    case IPC.PROJECT_LIST:
      return [];
    case IPC.SESSION_INFO:
      return { projectName: '', projectRoot: '', sessionName: '' };
    default:
      return undefined;
  }
}

describe('App boot-ready pane reconciliation', () => {
  const paneInitial = usePaneStore.getState();

  beforeEach(() => {
    ipcMock.invoke.mockReset();
    ipcMock.on.mockClear();
    ipcMock.reset();
    ipcMock.invoke.mockImplementation((channel: string) => Promise.resolve(defaultInvokeHandler(channel)));
    usePaneStore.setState(paneInitial);
  });

  afterEach(() => {
    cleanup();
    usePaneStore.setState(paneInitial);
  });

  it('reconciles from the fresh pane list once boot becomes ready', async () => {
    // Arrange — StateManager's authoritative list is already idle by the time boot finishes.
    ipcMock.invoke.mockImplementation((channel: string) => {
      if (channel === IPC.PANE_LIST) return Promise.resolve([pane({ agentStatus: 'idle' })]);
      return Promise.resolve(defaultInvokeHandler(channel));
    });

    render(<App />);
    await waitFor(() => expect(ipcMock.on).toHaveBeenCalledWith(IPC_EVENT.PANE_LIST_CHANGED, expect.any(Function)));

    // Act — boot transitions to ready.
    act(() => {
      ipcMock.emit(IPC_EVENT.APP_BOOT_STATE_CHANGED, bootState({ phase: 'ready', revision: 1 }));
    });

    // Assert — the one-shot reconciliation re-fetches the authoritative list and the store holds idle.
    await waitFor(() => {
      expect(usePaneStore.getState().panes).toEqual([expect.objectContaining({ id: 'pane-a', agentStatus: 'idle' })]);
    });
  });
});
