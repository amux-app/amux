// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddBacklogDialog } from '../src/renderer/components/kanban/AddBacklogDialog';
import { useProjectStore } from '../src/renderer/stores/project.store';
import { useTaskDefaultsStore } from '../src/renderer/stores/task-defaults.store';

const listAgentsMock = vi.hoisted(() => vi.fn());
const getSettingsMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/agent.api', () => ({
  listAgents: listAgentsMock,
}));
vi.mock('../src/renderer/api/settings.api', () => ({
  getSettings: getSettingsMock,
}));
vi.mock('../src/renderer/components/shared/ProjectPicker', () => ({
  ProjectPicker: ({ onChange, value }: { onChange: (value: string | undefined) => void; value?: string }) => (
    <button data-testid="project-picker" onClick={() => onChange('/selected/project')}>
      {value ?? 'No project'}
    </button>
  ),
}));
vi.mock('../src/renderer/components/shared/ToggleSwitch', () => ({
  ToggleSwitch: ({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) => (
    <button aria-label="toggle worktree" data-checked={checked} onClick={() => onChange(!checked)} />
  ),
}));

describe('AddBacklogDialog', () => {
  beforeEach(() => {
    listAgentsMock.mockResolvedValue(['codex']);
    getSettingsMock.mockResolvedValue({
      initGitIfMissing: true,
      useWorktree: false,
    });
    useProjectStore.setState({
      activeProject: {
        name: 'Active',
        root: '/active/project',
        sessionName: 'session',
        configPath: '',
        paneCount: 0,
      },
      sessionProjectRoot: '/session/project',
    });
    useTaskDefaultsStore.setState({ lastTaskProjectRoot: undefined });
  });

  afterEach(() => cleanup());

  function fillForm(title = '  Task title  ', prompt = '  Task prompt  ') {
    fireEvent.change(screen.getByPlaceholderText('e.g. Fix auth bug'), {
      target: { value: title },
    });
    fireEvent.change(screen.getByPlaceholderText('Describe what the agent should do...'), {
      target: { value: prompt },
    });
  }

  it('requires both title and prompt before submission', () => {
    const onSubmit = vi.fn();
    render(<AddBacklogDialog isOpen onClose={vi.fn()} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: 'Add to Backlog' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('e.g. Fix auth bug'), {
      target: { value: 'Title' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims the form and submits the exact selected agent and project shape', async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<AddBacklogDialog isOpen onClose={onClose} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Codex' }).disabled).toBe(false));
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Backlog' }));
    expect(onSubmit).toHaveBeenCalledWith({
      agent: 'codex',
      complexity: 'M',
      projectRoot: undefined,
      prompt: 'Task prompt',
      title: 'Task title',
      useWorktree: false,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('initializes and submits edit mode values without changing them implicitly', async () => {
    const onSubmit = vi.fn();
    const editItem = {
      agent: 'codex' as const,
      complexity: 'L' as const,
      id: 'item-1',
      projectRoot: '/old',
      prompt: 'Existing prompt',
      title: 'Existing title',
      useWorktree: true,
    };
    render(<AddBacklogDialog editItem={editItem} isOpen onClose={vi.fn()} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByDisplayValue('Existing title')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSubmit).toHaveBeenCalledWith({
      agent: 'codex',
      complexity: 'L',
      projectRoot: '/old',
      prompt: 'Existing prompt',
      title: 'Existing title',
      useWorktree: true,
    });
  });

  it('persists only the last selected task project root', () => {
    render(<AddBacklogDialog isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByTestId('project-picker'));
    expect(useTaskDefaultsStore.getState().lastTaskProjectRoot).toBe('/selected/project');
  });

  it('uses project settings for worktree defaults and disables unavailable agents', async () => {
    getSettingsMock.mockResolvedValue({
      initGitIfMissing: false,
      useWorktree: true,
    });
    listAgentsMock.mockResolvedValue(['codex']);
    render(<AddBacklogDialog isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('toggle worktree').getAttribute('data-checked')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Claude Code' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'OpenCode' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Pi' }).disabled).toBe(true);
  });

  it('closes without submission through Escape, backdrop, and Cancel', () => {
    const onClose = vi.fn();
    render(<AddBacklogDialog isOpen onClose={onClose} onSubmit={vi.fn()} />);
    fireEvent.keyDown(screen.getByPlaceholderText('e.g. Fix auth bug'), {
      key: 'Escape',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const backdrop = document.querySelector('[class*="bg-black"]');
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
