// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutSettings } from '../src/renderer/components/settings/AboutSettings';
import { useUpdateStore } from '../src/renderer/stores/update.store';

const systemApi = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}));

vi.mock('../src/renderer/api/system.api', () => systemApi);

describe('AboutSettings', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useUpdateStore.getState().reset();
  });

  it('keeps Applications-folder remediation visible and disables manual checks', async () => {
    systemApi.getAppInfo.mockResolvedValue({ buildVersion: '0.0.1', version: '0.0.1' });
    useUpdateStore.setState({
      initialized: true,
      snapshot: {
        currentVersion: '0.0.1',
        disabledReason: 'not-in-applications',
        phase: 'disabled',
        revision: 1,
      },
    });

    render(<AboutSettings />);

    expect(await screen.findByText(/automatic updates unavailable/i)).toBeTruthy();
    expect(screen.getByText(/quit MuxBase, drag it to Applications/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check for Updates' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('shows the installed app version from the main process', async () => {
    // Arrange
    systemApi.getAppInfo.mockResolvedValue({ buildVersion: '0.0.1', version: '0.0.1' });

    // Act
    render(<AboutSettings />);

    // Assert
    expect(await screen.findByText('0.0.1')).toBeTruthy();
  });

  it('shows the local install build number when it is stamped into the app', async () => {
    // Arrange
    systemApi.getAppInfo.mockResolvedValue({
      buildNumber: '20260517203045',
      buildVersion: '0.0.1.20260517203045',
      version: '0.0.1',
    });

    // Act
    render(<AboutSettings />);

    // Assert
    expect(await screen.findByText('0.0.1 (20260517203045)')).toBeTruthy();
  });
});
