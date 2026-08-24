// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateLocationNotice } from '../../src/renderer/components/layout/UpdateLocationNotice';
import { useUpdateStore } from '../../src/renderer/stores/update.store';

describe('UpdateLocationNotice', () => {
  beforeEach(() => {
    localStorage.clear();
    useUpdateStore.setState({
      snapshot: {
        currentVersion: '0.1.0',
        disabledReason: 'not-in-applications',
        phase: 'disabled',
        revision: 1,
      },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useUpdateStore.getState().reset();
  });

  it('shows actionable installation guidance and persists a one-time dismissal', () => {
    const first = render(<UpdateLocationNotice />);

    expect(screen.getByText('Move Amux to Applications to enable automatic updates.')).toBeTruthy();
    expect(screen.getByText(/quit Amux, drag it to the DMG’s Applications shortcut/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/Move Amux to Applications/i)).toBeNull();

    first.unmount();
    render(<UpdateLocationNotice />);
    expect(screen.queryByText(/Move Amux to Applications/i)).toBeNull();
  });
});
