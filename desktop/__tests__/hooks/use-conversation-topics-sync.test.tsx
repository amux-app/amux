// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTopicsSync } from '../../src/renderer/hooks/useConversationTopicsSync';
import {
  useElectronSettingsStore,
  useProjectStore,
  useTopicsStore,
} from '../../src/renderer/stores';
import type { PaneTopics } from '../../src/shared/topic-types';

const listTopics = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/api/topics.api', () => ({
  listTopics,
}));

const topic: PaneTopics = {
  agent: 'claude',
  paneId: 'pane-1',
  sessionId: 'session-1',
  topics: [],
  updatedAt: 1,
};

function Harness(): null {
  useConversationTopicsSync(true);
  return null;
}

describe('useConversationTopicsSync', () => {
  beforeEach(() => {
    listTopics.mockReset();
    useElectronSettingsStore.setState({
      isLoading: false,
      settings: {
        enableConversationTopics: false,
      } as never,
    });
    useProjectStore.setState({
      activeProject: {
        configPath: '/repo/.aumx/aumx.config.json',
        name: 'repo',
        paneCount: 1,
        root: '/repo',
        sessionName: 'aumx-repo',
      },
    });
    useTopicsStore.getState().setAll([topic]);
  });

  afterEach(() => {
    cleanup();
  });

  it('clears topics without issuing a boot-time list while disabled', () => {
    render(<Harness />);

    expect(listTopics).not.toHaveBeenCalled();
    expect(useTopicsStore.getState().topicsByPane).toEqual({});
  });

  it('backfills once when enabled and refreshes for a same-root project replacement', async () => {
    listTopics.mockResolvedValue([topic]);
    render(<Harness />);

    act(() => useElectronSettingsStore.setState((state) => ({
      settings: { ...state.settings!, enableConversationTopics: true },
    })));
    await waitFor(() => expect(listTopics).toHaveBeenCalledOnce());
    expect(useTopicsStore.getState().topicsByPane).toEqual({ 'pane-1': topic });

    act(() => useProjectStore.setState((state) => ({
      activeProject: { ...state.activeProject!, paneCount: 0 },
    })));
    await waitFor(() => expect(listTopics).toHaveBeenCalledTimes(2));
  });

  it('clears stale topics when an enabled backfill fails', async () => {
    listTopics.mockRejectedValue(new Error('list failed'));
    useElectronSettingsStore.setState((state) => ({
      settings: { ...state.settings!, enableConversationTopics: true },
    }));
    render(<Harness />);

    await waitFor(() => {
      expect(useTopicsStore.getState().topicsByPane).toEqual({});
    });
  });

  it('clears the previous project topics before an enabled backfill settles', async () => {
    let resolveBackfill: (topics: PaneTopics[]) => void = () => {};
    const pendingBackfill = new Promise<PaneTopics[]>((resolve) => {
      resolveBackfill = resolve;
    });
    listTopics
      .mockResolvedValueOnce([topic])
      .mockReturnValueOnce(pendingBackfill);
    useElectronSettingsStore.setState((state) => ({
      settings: { ...state.settings!, enableConversationTopics: true },
    }));
    render(<Harness />);
    await waitFor(() => {
      expect(useTopicsStore.getState().topicsByPane).toEqual({ 'pane-1': topic });
    });

    act(() => useProjectStore.setState({
      activeProject: {
        configPath: '/other/.aumx/aumx.config.json',
        name: 'other',
        paneCount: 0,
        root: '/other',
        sessionName: 'aumx-other',
      },
    }));

    expect(listTopics).toHaveBeenCalledTimes(2);
    expect(useTopicsStore.getState().topicsByPane).toEqual({});
    resolveBackfill([]);
    await pendingBackfill;
  });
});
