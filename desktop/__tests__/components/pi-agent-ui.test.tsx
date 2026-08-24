// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgentSelector } from '../../src/renderer/components/create/AgentSelector';
import { AgentTuning } from '../../src/renderer/components/create/AgentTuning';
import { ConfigurationDisclosure } from '../../src/renderer/components/create/ConfigurationDisclosure';
import { QuickSettings } from '../../src/renderer/components/create/QuickSettings';

describe('Pi New Pane UI', () => {
  it('renders the four-agent Prism grid with authentic Pi selection tint', () => {
    function Harness() {
      const [selected, setSelected] = useState<'claude' | 'codex' | 'opencode' | 'pi'>('claude');
      return (
        <AgentSelector
          agents={['claude', 'codex', 'opencode', 'pi']}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }

    render(<Harness />);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    const pi = screen.getByRole('radio', { name: /Pi/ });
    expect(pi.getAttribute('style')).toContain('--agent-brand: #7c83ff');
    fireEvent.click(pi);
    expect(pi.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('NEW')).toBeTruthy();
  });

  it('shows honest Pi default-model and thinking controls', () => {
    render(
      <AgentTuning
        agent="pi"
        model={undefined}
        effort={undefined}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Use Pi default')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  it('uses amber information copy for Pi standard tools', () => {
    render(
      <QuickSettings
        agent="pi"
        onUseWorktreeChange={vi.fn()}
        permissionMode="auto"
        useWorktree={false}
      />,
    );

    expect(screen.getByText('Pi Standard Tools')).toBeTruthy();
    expect(screen.getByText('Read, write, edit, and bash are enabled.')).toBeTruthy();
    expect(screen.getByText('Recommended isolation')).toBeTruthy();
  });

  it('keeps configuration collapsed until explicitly expanded', () => {
    render(
      <ConfigurationDisclosure agent="pi" summary="All defaults · Off worktree">
        <div>Advanced Pi controls</div>
      </ConfigurationDisclosure>,
    );

    const trigger = screen.getByRole('button', { name: /Configuration/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Advanced Pi controls')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Advanced Pi controls')).toBeTruthy();
  });
});
