// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ReviewAgentSegments } from '../../src/renderer/components/dashboard/ReviewAgentSegments';

describe('ReviewAgentSegments', () => {
  it('shows enforcement copy for every selectable review agent', () => {
    const agents = ['claude', 'codex', 'opencode'] as const;

    for (const agent of agents) {
      const view = render(
        <ReviewAgentSegments agents={[agent]} selected={agent} onSelect={() => undefined} />,
      );

      expect(screen.getByRole('radio', { name: agent === 'opencode' ? 'OpenCode' : agent[0].toUpperCase() + agent.slice(1) }))
        .toBeTruthy();
      expect(screen.getByText(agent === 'codex'
        ? /OS-enforced read-only sandbox/
        : /runs in plan mode/)).toBeTruthy();
      view.unmount();
    }
  });
});
