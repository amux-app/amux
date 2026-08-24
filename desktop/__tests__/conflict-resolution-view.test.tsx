// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paneApi = vi.hoisted(() => ({ executeCallback: vi.fn() }));
const conflictState = vi.hoisted(() => ({
  callbackId: 'callback-1',
  closeConflictResolution: vi.fn(),
  conflictFiles: ['src/app.ts'],
  message: 'Resolve the conflict\n• src/app.ts',
  options: [
    { default: true, description: 'Keep the incoming change', id: 'theirs', label: 'Use theirs' },
    { description: 'Stop the merge', id: 'cancel', label: 'Cancel' },
  ],
  paneId: 'pane-1',
}));
const uiState = vi.hoisted(() => ({
  closeConflictView: vi.fn(),
  focusPane: vi.fn(),
}));
const notificationState = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);
vi.mock('../src/renderer/stores/conflict-resolution.store', () => ({
  useConflictResolutionStore: (selector: (state: typeof conflictState) => unknown) => selector(conflictState),
}));
vi.mock('../src/renderer/stores', () => ({
  useNotificationStore: (selector: (state: typeof notificationState) => unknown) => selector(notificationState),
  usePaneById: () => ({ id: 'pane-1', slug: 'feature-task' }),
  useUiStore: (selector: (state: typeof uiState) => unknown) => selector(uiState),
}));
vi.mock('../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: () => <div data-testid="diff" />,
}));

import { ConflictResolutionView } from '../src/renderer/components/conflict-resolution/ConflictResolutionView';

describe('ConflictResolutionView', () => {
  beforeEach(() => {
    paneApi.executeCallback.mockReset();
    conflictState.closeConflictResolution.mockReset();
    uiState.closeConflictView.mockReset();
    uiState.focusPane.mockReset();
    notificationState.addToast.mockReset();
  });

  afterEach(() => cleanup());

  it('routes a successful merge callback to the requested pane', async () => {
    paneApi.executeCallback.mockResolvedValue({
      message: 'Merged',
      targetPaneId: 'pane-main',
      type: 'navigation',
    });
    render(<ConflictResolutionView />);

    fireEvent.click(screen.getByTestId('strategy-theirs'));

    await waitFor(() => expect(uiState.focusPane).toHaveBeenCalledWith('pane-main'));
    expect(conflictState.closeConflictResolution).toHaveBeenCalledTimes(1);
    expect(uiState.closeConflictView).toHaveBeenCalledTimes(1);
    expect(notificationState.addToast).toHaveBeenCalledWith('Merged', 'success');
  });

  it('keeps the view open and reports callback errors', async () => {
    paneApi.executeCallback.mockResolvedValue({ message: 'Merge failed', type: 'error' });
    render(<ConflictResolutionView />);

    fireEvent.click(screen.getByTestId('strategy-theirs'));

    await waitFor(() => expect(notificationState.addToast).toHaveBeenCalledWith('Merge failed', 'error'));
    expect(conflictState.closeConflictResolution).not.toHaveBeenCalled();
    expect(uiState.closeConflictView).not.toHaveBeenCalled();
  });

  it('reports IPC failures and clears the loading state', async () => {
    paneApi.executeCallback.mockRejectedValue(new Error('IPC unavailable'));
    render(<ConflictResolutionView />);

    fireEvent.click(screen.getByTestId('strategy-theirs'));

    await waitFor(() => expect(notificationState.addToast).toHaveBeenCalledWith('Strategy failed: IPC unavailable', 'error'));
    expect(screen.getByTestId('strategy-theirs').getAttribute('disabled')).toBeNull();
  });
});
