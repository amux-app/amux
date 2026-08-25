// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendFixesConfirmDialog } from '../../src/renderer/components/dashboard/SendFixesConfirmDialog';
import { useAgentSessionStore } from '../../src/renderer/stores/agent-session.store';
import { createEmptyMetrics, type NormalizedMessage } from '../../src/shared/agent-session-types';

const sendFixesToAuthor = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({ sendFixesToAuthor }),
}));

const REVIEW_PANE: MuxBasePane = {
  agent: 'claude',
  id: 'review-pane',
  paneId: '%1',
  prompt: 'review the change',
  review: {
    changedFiles: 1,
    reviewId: 'review-1',
    sourcePaneId: 'source-pane',
    sourceSlug: 'feature',
    startedAt: Date.now(),
  },
  role: 'review',
  slug: 'review-feature',
};

function assistantSession(content: string) {
  const message: NormalizedMessage = {
    content,
    id: 'message-1',
    toolCalls: [],
    toolResults: [],
    type: 'assistant',
  };
  return {
    agent: 'claude' as const,
    compactionEvents: [],
    isOngoing: false,
    messages: [message],
    metrics: createEmptyMetrics(),
    sessionId: 'session-1',
    subagents: [],
  };
}

describe('SendFixesConfirmDialog', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    useAgentSessionStore.setState({ sessions: {} });
    sendFixesToAuthor.mockResolvedValue({ success: true, noIssues: true, sourcePaneId: 'source-pane' });
  });

  it('enables acknowledgement for a clean review with an accessible action name', () => {
    useAgentSessionStore.setState({
      sessions: { 'review-pane': assistantSession('NO_ISSUES_FOUND\n\nThe change is sound.') },
    });

    render(<SendFixesConfirmDialog reviewPane={REVIEW_PANE} onClose={vi.fn()} />);

    const action = screen.getByRole('button', { name: 'Acknowledge and return' });
    expect(action.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/The reviewer found no actionable issues/)).toBeTruthy();
    expect(screen.getAllByText(/no actionable issues/i)).toHaveLength(1);
    expect(screen.queryByText(/The author's agent will read these findings/)).toBeNull();
  });

  it('keeps findings reviews on the Send to author action', () => {
    useAgentSessionStore.setState({
      sessions: { 'review-pane': assistantSession('Critical — src/app.ts:10 — bug') },
    });

    render(<SendFixesConfirmDialog reviewPane={REVIEW_PANE} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Send to author' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/The author's agent will read these findings/)).toBeTruthy();
  });

  it('sends clean reviews through the existing handoff action and closes on success', async () => {
    const onClose = vi.fn();
    useAgentSessionStore.setState({
      sessions: { 'review-pane': assistantSession('NO_ISSUES_FOUND') },
    });

    render(<SendFixesConfirmDialog reviewPane={REVIEW_PANE} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge and return' }));

    await vi.waitFor(() => expect(sendFixesToAuthor).toHaveBeenCalledWith('review-pane'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
