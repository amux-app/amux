// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalOverlays } from '../../src/renderer/components/pane-detail/interactive-terminal/TerminalOverlays';

const palette = {
  accent: '#3366ff',
  background: '#000000',
  foreground: '#ffffff',
  muted: '#999999',
  track: '#222222',
};

describe('TerminalOverlays', () => {
  it('announces active boot progress and hides completed progress from accessibility APIs', () => {
    const view = render(
      <TerminalOverlays
        agent="claude"
        agentLabel="Claude"
        bootPhase={2}
        branchName="feature"
        failure={null}
        onReconnect={vi.fn()}
        overlayPalette={palette}
        showBootOverlay
        showEmptyState={false}
      />,
    );

    const active = screen.getByTestId('terminal-boot-overlay');
    expect(active.getAttribute('role')).toBe('status');
    expect(active.getAttribute('aria-live')).toBe('polite');
    expect(active.getAttribute('aria-hidden')).toBe('false');
    expect(active.textContent).toContain('Loading MCP servers...');

    view.rerender(
      <TerminalOverlays
        agent="claude"
        agentLabel="Claude"
        bootPhase={2}
        branchName="feature"
        failure={null}
        onReconnect={vi.fn()}
        overlayPalette={palette}
        showBootOverlay={false}
        showEmptyState={false}
      />,
    );

    const hidden = screen.getByTestId('terminal-boot-overlay');
    expect(hidden.hasAttribute('role')).toBe(false);
    expect(hidden.hasAttribute('aria-live')).toBe(false);
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the fullscreen empty state independently from boot progress', () => {
    render(
      <TerminalOverlays
        agent="claude"
        agentLabel="Claude"
        bootPhase={0}
        branchName="feature/terminal-split"
        failure={null}
        onReconnect={vi.fn()}
        overlayPalette={palette}
        showBootOverlay={false}
        showEmptyState
      />,
    );

    expect(screen.getByTestId('terminal-empty-state').textContent)
      .toContain('feature/terminal-split');
    expect(screen.getByTestId('terminal-empty-state').textContent)
      .toContain('Send your first prompt to get started');
  });

  it('renders reconnecting as passive status and terminal failure as an actionable alert', () => {
    const onReconnect = vi.fn();
    const view = render(
      <TerminalOverlays
        agent="opencode"
        agentLabel="OpenCode"
        bootPhase={0}
        failure={{ kind: 'reconnecting', message: 'Retrying automatically...' }}
        onReconnect={onReconnect}
        overlayPalette={palette}
        showBootOverlay={false}
        showEmptyState={false}
      />,
    );

    const reconnecting = screen.getByTestId('terminal-failure-card');
    expect(reconnecting.getAttribute('role')).toBe('status');
    expect(reconnecting.className).toContain('pointer-events-none');
    expect(screen.queryByRole('button', { name: 'Reconnect terminal' })).toBeNull();

    view.rerender(
      <TerminalOverlays
        agent="opencode"
        agentLabel="OpenCode"
        bootPhase={0}
        failure={{ kind: 'attach', message: 'Disconnected' }}
        onReconnect={onReconnect}
        overlayPalette={palette}
        showBootOverlay={false}
        showEmptyState={false}
      />,
    );

    const failureCard = screen.getByTestId('terminal-failure-card');
    const reconnectButton = screen.getByRole('button', { name: 'Reconnect terminal' });
    const renderedClasses = Array.from(failureCard.querySelectorAll('[class]'))
      .map((element) => element.getAttribute('class') ?? '');
    expect(failureCard.getAttribute('role')).toBe('alert');
    expect(reconnectButton.className).toContain('text-[var(--accent-contrast)]');
    expect(renderedClasses.some((className) => (
      className.includes('text-[var(--text-secondary)]')
    ))).toBe(true);
    fireEvent.click(reconnectButton);
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
