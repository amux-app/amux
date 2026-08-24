// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTab } from '../../src/renderer/stores';

const actions = vi.hoisted(() => ({
  closeActiveTab: vi.fn(),
  closeAllTabs: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTab: vi.fn(),
  closeTabsToRight: vi.fn(),
  setActiveTab: vi.fn(),
}));

vi.mock('../../src/renderer/stores', () => ({
  useWorkspaceTabsStore: (selector: (state: typeof actions) => unknown) => selector(actions),
}));

import { useFileTabHandlers } from '../../src/renderer/hooks/useFileTabHandlers';

const tab: FileTab = {
  fileName: 'index.ts',
  id: '/workspace::src/index.ts',
  openedAt: 1,
  relativePath: 'src/index.ts',
  rootPath: '/workspace',
};

describe('useFileTabHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(actions).forEach((action) => action.mockResolvedValue(true));
  });

  it('binds every workspace-tab operation to the provided scope', async () => {
    const { result } = renderHook(() => useFileTabHandlers('pane-1'));

    await act(async () => {
      await expect(result.current.handleFileTabClick(tab)).resolves.toBe(true);
      await expect(result.current.handleFileTabClose(tab)).resolves.toBe(true);
      await expect(result.current.handleFileTabCloseAll()).resolves.toBe(true);
      await expect(result.current.handleFileTabCloseOthers(tab)).resolves.toBe(true);
      await expect(result.current.handleFileTabCloseToRight(tab)).resolves.toBe(true);
      await expect(result.current.closeActiveFileTab()).resolves.toBe(true);
      await expect(result.current.setActiveFileTab(null)).resolves.toBe(true);
    });

    expect(actions.setActiveTab).toHaveBeenNthCalledWith(1, 'pane-1', tab.id);
    expect(actions.setActiveTab).toHaveBeenNthCalledWith(2, 'pane-1', null);
    expect(actions.closeTab).toHaveBeenCalledWith('pane-1', tab.id);
    expect(actions.closeAllTabs).toHaveBeenCalledWith('pane-1');
    expect(actions.closeOtherTabs).toHaveBeenCalledWith('pane-1', tab.id);
    expect(actions.closeTabsToRight).toHaveBeenCalledWith('pane-1', tab.id);
    expect(actions.closeActiveTab).toHaveBeenCalledWith('pane-1');
  });

  it('returns false without calling the store when no scope exists', async () => {
    const { result } = renderHook(() => useFileTabHandlers(undefined));

    await expect(result.current.handleFileTabClick(tab)).resolves.toBe(false);
    await expect(result.current.handleFileTabClose(tab)).resolves.toBe(false);
    await expect(result.current.handleFileTabCloseAll()).resolves.toBe(false);
    await expect(result.current.handleFileTabCloseOthers(tab)).resolves.toBe(false);
    await expect(result.current.handleFileTabCloseToRight(tab)).resolves.toBe(false);
    await expect(result.current.closeActiveFileTab()).resolves.toBe(false);
    await expect(result.current.setActiveFileTab(null)).resolves.toBe(false);

    Object.values(actions).forEach((action) => expect(action).not.toHaveBeenCalled());
  });
});
