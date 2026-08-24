// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateBootstrap } from '../../src/renderer/components/layout/AppUpdateBootstrap';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import { useUpdateStore } from '../../src/renderer/stores/update.store';

describe('AppUpdateBootstrap', () => {
  beforeEach(() => {
    useNotificationStore.getState().clearToasts();
    useUpdateStore.setState({
      initialize: vi.fn(() => Promise.resolve()),
      snapshot: { currentVersion: '0.1.0', phase: 'idle', revision: 1 },
    });
  });

  afterEach(() => {
    cleanup();
    useNotificationStore.getState().clearToasts();
    useUpdateStore.getState().reset();
  });

  it('initializes once and emits one restrained toast per ready version', async () => {
    render(<AppUpdateBootstrap />);

    await act(async () => {
      useUpdateStore.setState({
        snapshot: {
          availableVersion: '0.2.0',
          currentVersion: '0.1.0',
          phase: 'ready',
          revision: 2,
        },
      });
    });
    await act(async () => {
      useUpdateStore.setState({
        snapshot: {
          availableVersion: '0.2.0',
          currentVersion: '0.1.0',
          phase: 'ready',
          revision: 3,
        },
      });
    });

    expect(useUpdateStore.getState().initialize).toHaveBeenCalledOnce();
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
    expect(useNotificationStore.getState().toasts[0]?.message).toContain('0.2.0');
  });
});
