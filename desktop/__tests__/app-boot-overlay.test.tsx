// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBootOverlay } from '../src/renderer/components/app-boot/AppBootOverlay';

const appActions = vi.hoisted(() => ({
  quitApp: vi.fn().mockResolvedValue(true),
  relaunchApp: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/renderer/api/app.api', () => appActions);

describe('AppBootOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses a compact, non-text indicator while startup is in progress', () => {
    const { getByRole, queryByRole, queryByText } = render(
      <AppBootOverlay state={{ phase: 'starting', revision: 0 }} />,
    );

    expect(getByRole('status', { name: 'Starting Amux' })).toBeTruthy();
    expect(queryByRole('heading')).toBeNull();
    expect(queryByText(/preparing your workspace/i)).toBeNull();
    expect(queryByText(/connecting to tmux/i)).toBeNull();
  });

  it('offers retry and quit after startup fails', () => {
    const { getByRole } = render(
      <AppBootOverlay
        state={{ message: 'Workspace startup timed out', phase: 'failed', revision: 1 }}
      />,
    );

    fireEvent.click(getByRole('button', { name: 'Retry startup' }));
    expect(appActions.relaunchApp).toHaveBeenCalledOnce();
  });

  it('uses platform-neutral guidance for a blocked startup check', () => {
    const { getByRole, getByText, queryByText } = render(
      <AppBootOverlay
        state={{ errors: ['tmux is not installed'], phase: 'blocked', revision: 1 }}
      />,
    );

    expect(getByRole('heading', { name: 'Startup check needs attention' })).toBeTruthy();
    expect(getByText(/resolve the issue below, then retry/i)).toBeTruthy();
    expect(queryByText(/brew install/i)).toBeNull();
  });
});
