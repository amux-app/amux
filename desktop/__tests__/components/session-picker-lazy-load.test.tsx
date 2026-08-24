// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionPicker } from '../../src/renderer/components/create/SessionPicker';
import type { PastSession } from '../../src/shared/ipc-types';

function makeSessions(count: number, offset = 0): PastSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `session-${offset + i}`,
    title: `Session ${offset + i}`,
    updatedAt: 1_000_000 - (offset + i),
  }));
}

function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /session/i }));
}

afterEach(() => {
  cleanup();
});

describe('SessionPicker lazy loading', () => {
  it('offers the sessions that were not read yet and requests them on demand', () => {
    // Arrange
    const onShowAll = vi.fn();
    render(
      <SessionPicker
        sessions={makeSessions(10)}
        value={undefined}
        onChange={vi.fn()}
        loading={false}
        totalCount={58}
        onShowAll={onShowAll}
      />,
    );

    // Act
    openPicker();
    fireEvent.click(screen.getByText('Show 48 more'));

    // Assert
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('lists every loaded session and drops the affordance once none are missing', () => {
    // Arrange
    const onShowAll = vi.fn();
    render(
      <SessionPicker
        sessions={makeSessions(12)}
        value={undefined}
        onChange={vi.fn()}
        loading={false}
        totalCount={12}
        onShowAll={onShowAll}
      />,
    );

    // Act
    openPicker();

    // Assert
    expect(screen.getByText('Session 11')).toBeTruthy();
    expect(screen.queryByText(/more$/)).toBeNull();
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it('keeps selecting a session by its id', () => {
    // Arrange
    const onChange = vi.fn();
    render(
      <SessionPicker
        sessions={makeSessions(3)}
        value={undefined}
        onChange={onChange}
        loading={false}
        totalCount={58}
        onShowAll={vi.fn()}
      />,
    );

    // Act
    openPicker();
    fireEvent.click(screen.getByText('Session 1'));

    // Assert
    expect(onChange).toHaveBeenCalledWith('session-1');
  });
});
