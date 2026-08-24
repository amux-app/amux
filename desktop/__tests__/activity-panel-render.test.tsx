// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActivityPanel } from '../src/renderer/components/agent-devtools/AgentActivityPanel';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { useActivitySubTabStore } from '../src/renderer/stores/activity-subtab.store';
import { createEmptySession, type NormalizedSession } from '../src/shared/agent-session-types';

vi.mock('../src/renderer/api/system.api', () => ({ clipboardWrite: vi.fn() }));
vi.mock('../src/renderer/api/recap.api', () => ({ generateRecap: vi.fn().mockResolvedValue({ summary: '' }) }));

const PANE_ID = 'pane-activity';

function seedSession(): NormalizedSession {
  const session = createEmptySession('claude', 'session-activity');
  session.title = 'Refactor auth flow';
  session.isOngoing = true;
  session.startTime = 1_000;
  session.lastUpdateTime = 190_000;
  session.metrics = {
    ...session.metrics,
    totalTokens: 84_500,
    toolCallCount: 2,
    costUSD: 0.42,
    costSource: 'otlp',
  };
  session.messages = [
    { id: 'u1', type: 'user', content: 'Add a logout button', timestamp: 2_000, toolCalls: [], toolResults: [] },
    {
      id: 'a1',
      type: 'assistant',
      content: 'Working on it',
      timestamp: 5_000,
      tokens: { inputTokens: 40_000, outputTokens: 2_000, cacheReadTokens: 10_000 },
      toolCalls: [
        { id: 'tc1', name: 'Read', input: { file_path: 'a.ts' }, timestamp: 6_000 },
        { id: 'tc2', name: 'Bash', input: { command: 'ls' }, timestamp: 8_000 },
      ],
      toolResults: [
        { toolCallId: 'tc1', content: 'ok', isError: false, durationMs: 120 },
        { toolCallId: 'tc2', content: 'ok', isError: false, durationMs: 800 },
      ],
    },
  ];
  return session;
}

describe('AgentActivityPanel (redesigned)', () => {
  beforeEach(() => {
    useAgentSessionStore.setState({ sessions: { [PANE_ID]: seedSession() } });
    useActivitySubTabStore.setState({ byPane: {} });
  });

  afterEach(() => {
    cleanup();
    useAgentSessionStore.setState({ sessions: {} });
  });

  it('renders identity, metric chips, context meter and sub-tabs', () => {
    // Act
    render(<AgentActivityPanel paneId={PANE_ID} />);

    // Assert — header identity + metric chips ("Prompts" also appears as a tab, so allow >=1)
    expect(screen.getByText('Refactor auth flow')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getAllByText('Prompts').length).toBeGreaterThan(0);
    expect(screen.getByText('Tools')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('Cost')).toBeTruthy();
    expect(screen.getByText('Context')).toBeTruthy();
    // Assert — sub-tabs present as tablist
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(expect.arrayContaining(['Conversation', 'Prompts', 'Recaps', 'Timeline']));
  });

  it('switches to the Timeline sub-tab and renders tool rows with a summary', () => {
    // Arrange
    render(<AgentActivityPanel paneId={PANE_ID} />);

    // Act
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));

    // Assert — summary chips + tool names appear
    expect(screen.getByText('Duration')).toBeTruthy();
    expect(screen.getByText('Calls')).toBeTruthy();
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bash').length).toBeGreaterThan(0);
  });

  it('shows the empty state when the session has no messages', () => {
    // Arrange
    useAgentSessionStore.setState({ sessions: { [PANE_ID]: createEmptySession('claude', 'empty') } });

    // Act
    render(<AgentActivityPanel paneId={PANE_ID} />);

    // Assert
    expect(screen.getByText('No Activity Yet')).toBeTruthy();
  });
});
