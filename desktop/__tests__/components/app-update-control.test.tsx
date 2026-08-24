// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateControl } from '../../src/renderer/components/layout/AppUpdateControl';
import { useUpdateStore } from '../../src/renderer/stores/update.store';

const systemApi = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));
vi.mock('../../src/renderer/api/system.api', () => systemApi);

describe('AppUpdateControl', () => {
  beforeEach(() => {
    useUpdateStore.setState({ initialized: true, snapshot: null });
  });

  afterEach(() => {
    cleanup();
    useUpdateStore.getState().reset();
  });

  it('stays hidden for idle and wrong-location states', () => {
    const { rerender } = render(<AppUpdateControl />);
    useUpdateStore.setState({
      snapshot: { currentVersion: '0.1.0', phase: 'idle', revision: 1 },
    });
    rerender(<AppUpdateControl />);
    expect(screen.queryByRole('button')).toBeNull();

    useUpdateStore.setState({
      snapshot: {
        currentVersion: '0.1.0',
        disabledReason: 'not-in-applications',
        phase: 'disabled',
        revision: 2,
      },
    });
    rerender(<AppUpdateControl />);
    expect(screen.queryByText(/restart and update/i)).toBeNull();
  });

  it('announces finite download progress with an accessible 32px control', () => {
    useUpdateStore.setState({
      snapshot: {
        availableVersion: '0.2.0',
        currentVersion: '0.1.0',
        phase: 'downloading',
        progress: { bytesPerSecond: 50, percent: 42, total: 100, transferred: 42 },
        revision: 3,
      },
    });

    render(<AppUpdateControl />);

    const button = screen.getByRole('button', { name: 'Downloading Amux 0.2.0 — 42%' });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('min-w-8');
    expect(screen.getByRole('status').textContent).toContain('42%');
  });

  it('opens a focus-managed ready surface and installs through the store once', async () => {
    const installUpdate = vi.fn(() => Promise.resolve(true));
    useUpdateStore.setState({
      installUpdate,
      snapshot: {
        availableVersion: '0.2.0',
        currentVersion: '0.1.0',
        phase: 'ready',
        releaseNotesUrl: 'https://github.com/amux-app/amux/releases/tag/v0.2.0',
        revision: 4,
      },
    });

    render(<AppUpdateControl />);
    const trigger = screen.getByRole('button', { name: 'Update Amux to 0.2.0' });
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Amux update ready' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View release notes' }));
    expect(systemApi.openExternal).toHaveBeenCalledWith(
      'https://github.com/amux-app/amux/releases/tag/v0.2.0',
    );
    const install = screen.getByRole('button', { name: 'Restart and update' });
    fireEvent.click(install);
    fireEvent.click(install);

    await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());
  });

  it('closes with Later and returns focus to the title-bar trigger', async () => {
    useUpdateStore.setState({
      snapshot: {
        availableVersion: '0.2.0',
        currentVersion: '0.1.0',
        phase: 'ready',
        revision: 4,
      },
    });
    render(<AppUpdateControl />);
    const trigger = screen.getByRole('button', { name: 'Update Amux to 0.2.0' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
