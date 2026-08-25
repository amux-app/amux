// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../src/renderer/api/ipc';
import * as paneApi from '../src/renderer/api/pane.api';
import * as settingsApi from '../src/renderer/api/settings.api';
import { CreatePaneDialog } from '../src/renderer/components/create/CreatePaneDialog';
import { useNotificationStore, usePaneStore, useProjectStore } from '../src/renderer/stores';
import { IPC } from '../src/shared/ipc-channels';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, layoutId: _layoutId, ...props }: React.HTMLAttributes<HTMLSpanElement> & { layoutId?: string }) => <span {...props}>{children}</span>,
  },
}));

vi.mock('../src/renderer/api/ipc', () => ({
  invoke: vi.fn(async () => ['claude', 'codex']),
}));

vi.mock('../src/renderer/api/pane.api', () => ({
  createDuelPanes: vi.fn(async () => ({
    paneA: { slug: 'ask-both-a' },
    paneB: { slug: 'ask-both-b' },
    success: true,
  })),
  listPaneSessions: vi.fn(async () => ({ sessions: [] })),
}));

vi.mock('../src/renderer/api/settings.api', () => ({
  getSettings: vi.fn(async () => ({
    permissionMode: 'auto',
    useWorktree: false,
  })),
}));

const createPaneSpy = vi.fn();

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    createPane: createPaneSpy,
  }),
}));

function switchToDuel(): void {
  fireEvent.click(screen.getByRole('tab', { name: /duel/i }));
}

function getPromptTextarea(): HTMLTextAreaElement {
  const textarea = screen.getByPlaceholderText(/ask both agents/i);
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('prompt textarea not found');
  return textarea;
}

function getSubmitButton(name: RegExp): HTMLButtonElement {
  const button = screen.getByRole('button', { name });
  if (!(button instanceof HTMLButtonElement)) throw new Error('submit button not found');
  return button;
}

function selectAgentInGroup(groupIndex: number, name: RegExp): void {
  const group = screen.getAllByRole('radiogroup')[groupIndex];
  fireEvent.click(within(group).getByRole('radio', { name }));
}

describe('CreatePaneDialog duel flow', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(['claude', 'codex']);
    useNotificationStore.setState({ toasts: [] });
    usePaneStore.setState({
      createMode: 'single',
      isCreating: true,
      loaded: true,
      panes: [],
      pendingPane: null,
      selectedPaneId: null,
    });
    useProjectStore.setState({
      activeProject: {
        configPath: '/Users/me/projects/app/.muxbase/muxbase.config.json',
        name: 'app',
        paneCount: 0,
        root: '/Users/me/projects/app',
        sessionName: 'muxbase-app',
      },
      projectSwitching: false,
      projects: [],
      sessionName: 'muxbase-app',
      sessionProjectName: 'app',
      sessionProjectRoot: '/Users/me/projects/app',
    });
  });

  it('opens directly in duel mode when the store requests it', async () => {
    // Arrange
    usePaneStore.setState({ createMode: 'duel', isCreating: false });

    // Act
    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true, 'duel');

    // Assert: duel layout without touching the mode tabs
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    expect(getPromptTextarea()).toBeTruthy();
    expect(getSubmitButton(/start duel/i)).toBeTruthy();
  });

  it('falls back to single mode when no agents are installed', async () => {
    // Arrange
    vi.mocked(invoke).mockResolvedValue([]);
    usePaneStore.setState({ createMode: 'duel', isCreating: false });

    // Act
    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true, 'duel');
    await screen.findByRole('dialog');

    // Assert
    await waitFor(() => expect(getSubmitButton(/launch pane/i)).toBeTruthy());
    expect(screen.queryByPlaceholderText(/ask both agents/i)).toBeNull();
  });

  it('shows the prompt below the agent cards in duel mode', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });

    // Act
    switchToDuel();

    // Assert: both side cards and the prompt are visible immediately
    await waitFor(() => {
      expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
    });
    expect(screen.getByRole('radiogroup', { name: 'Select agent for Side A' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Select agent for Side B' })).toBeTruthy();
    expect(screen.getByText('Side A')).toBeTruthy();
    expect(screen.getByText('Side B')).toBeTruthy();
    expect(getPromptTextarea()).toBeTruthy();
  });

  it('paints cached agents first and refreshes agents installed after startup', async () => {
    vi.mocked(invoke).mockImplementation(async (channel) => (
      channel === IPC.AGENT_LIST ? ['claude'] : ['claude', 'codex']
    ));

    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });
    switchToDuel();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC.AGENT_LIST, { capability: 'duel' });
      expect(invoke).toHaveBeenCalledWith(IPC.AGENT_REFRESH, { capability: 'duel' });
      expect(screen.getAllByRole('radio', { name: /codex/i })).toHaveLength(2);
    });
  });

  it('orders Side A as Claude-first and Side B as Codex-first, Claude-last', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });

    // Act
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));

    // Assert
    const sideA = screen.getByRole('radiogroup', { name: 'Select agent for Side A' });
    const sideARadios = within(sideA).getAllByRole('radio');
    expect(sideARadios[0].textContent).toMatch(/claude/i);

    const sideB = screen.getByRole('radiogroup', { name: 'Select agent for Side B' });
    const sideBRadios = within(sideB).getAllByRole('radio');
    expect(sideBRadios[0].textContent).toMatch(/codex/i);
    expect(sideBRadios[sideBRadios.length - 1].textContent).toMatch(/claude/i);
  });

  it('disables the duel submit with an empty prompt and shows the reason', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));

    // Act: leave prompt empty, make sides differ so only the prompt blocks submit
    selectAgentInGroup(1, /codex/i);

    // Assert
    await waitFor(() => {
      expect(getSubmitButton(/start duel/i).disabled).toBe(true);
    });
    expect(screen.getByText('Enter a prompt for both agents')).toBeTruthy();
  });

  it('blocks identical side tuples but allows same agent with a different model', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    fireEvent.change(getPromptTextarea(), { target: { value: 'ask both' } });

    // Side B defaults to codex; force it back to claude so both sides share the
    // same agent with no model → identical tuple.
    selectAgentInGroup(1, /claude/i);
    await waitFor(() => {
      expect(screen.getByText('Sides must differ in agent, model, or effort')).toBeTruthy();
      expect(getSubmitButton(/start duel/i).disabled).toBe(true);
    });

    // Act: pick a model on Side B only → tuples now differ though both stay claude.
    // Two Model dropdowns render (Side A, then Side B); target the second.
    const modelButtons = screen
      .getAllByText('Model')
      .map((label) => label.closest('button[aria-haspopup="listbox"]'))
      .filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);
    fireEvent.click(modelButtons[1]);
    const sonnetOption = screen.getAllByRole('option').find((el) => /sonnet/i.test(el.textContent ?? ''));
    fireEvent.click(sonnetOption as HTMLElement);

    // Assert
    await waitFor(() => {
      expect(getSubmitButton(/start duel/i).disabled).toBe(false);
    });
  });

  it('defaults side B to a differing agent so the duel is submittable without changing it', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));

    // Act: add a prompt only — do NOT touch side B.
    fireEvent.change(getPromptTextarea(), { target: { value: 'ask both' } });

    // Assert: side A (claude) vs side B (codex, its default) differ → submittable.
    const sideB = screen.getByRole('radiogroup', { name: 'Select agent for Side B' });
    await waitFor(() => {
      expect(within(sideB).getByRole('radio', { name: /codex/i }).getAttribute('aria-checked')).toBe('true');
      expect(getSubmitButton(/start duel/i).disabled).toBe(false);
    });
  });

  it('preserves an in-progress worktree choice when the selected agent changes', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('radio', { name: /claude/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /configuration/i }));
    const toggle = await screen.findByRole('switch', { name: 'Use Git Worktree' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // Act
    const agentGroup = screen.getByRole('radiogroup', { name: 'Select agent' });
    fireEvent.click(within(agentGroup).getByRole('radio', { name: /codex/i }));

    // Assert
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Use Git Worktree' }).getAttribute('aria-checked')).toBe('true'));
    expect(settingsApi.getSettings).toHaveBeenCalledTimes(1);
  });

  it('submits the exact duel payload with trimmed prompt and per-side model/effort', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    selectAgentInGroup(1, /codex/i);
    fireEvent.change(getPromptTextarea(), { target: { value: '  compare answers  ' } });

    // Act
    await waitFor(() => expect(getSubmitButton(/start duel/i).disabled).toBe(false));
    fireEvent.click(getSubmitButton(/start duel/i));

    // Assert
    await waitFor(() => {
      expect(paneApi.createDuelPanes).toHaveBeenCalledWith({
        prompt: 'compare answers',
        sides: [
          { agent: 'claude', model: undefined, effort: undefined },
          { agent: 'codex', model: undefined, effort: undefined },
        ],
        useWorktree: false,
        projectRoot: undefined,
        paneName: undefined,
      });
    });
  });

  it('surfaces a warning toast when only one side survived', async () => {
    // Arrange
    vi.mocked(paneApi.createDuelPanes).mockResolvedValueOnce({
      paneA: { slug: 'ask-both-a' },
      error: 'Side B failed to launch',
      success: false,
      survivorPaneId: 'pane-a',
    } as Awaited<ReturnType<typeof paneApi.createDuelPanes>>);
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    selectAgentInGroup(1, /codex/i);
    fireEvent.change(getPromptTextarea(), { target: { value: 'compare answers' } });

    // Act
    await waitFor(() => expect(getSubmitButton(/start duel/i).disabled).toBe(false));
    fireEvent.click(getSubmitButton(/start duel/i));

    // Assert
    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts.some((t) => t.severity === 'warning')).toBe(true);
      expect(toasts.some((t) => t.severity === 'error')).toBe(false);
    });
  });

  it('keeps the dialog open after a total Duel launch failure so it can be retried', async () => {
    vi.mocked(paneApi.createDuelPanes).mockResolvedValueOnce({
      error: 'No tmux server',
      success: false,
    });
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    selectAgentInGroup(1, /codex/i);
    fireEvent.change(getPromptTextarea(), { target: { value: 'compare answers' } });

    fireEvent.click(getSubmitButton(/start duel/i));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(getPromptTextarea().value).toBe('compare answers');
      expect(useNotificationStore.getState().toasts.some((toast) => toast.severity === 'error')).toBe(true);
    });
  });

  it('allows a one-agent duel when the model or effort can distinguish the sides', async () => {
    // Arrange
    vi.mocked(invoke).mockResolvedValueOnce(['claude']);
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    await screen.findByRole('radio', { name: /claude/i });

    // Act
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));

    // Assert
    expect(getPromptTextarea()).toBeTruthy();
  });

  it('requires a modifier to submit a duel from the keyboard', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    selectAgentInGroup(1, /codex/i);
    fireEvent.change(getPromptTextarea(), { target: { value: 'compare answers' } });
    await waitFor(() => expect(getSubmitButton(/start duel/i).disabled).toBe(false));
    const nameInput = screen.getByPlaceholderText(/name \(optional\)/i);

    // Act + Assert: plain Enter must not launch while editing dialog controls.
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    expect(paneApi.createDuelPanes).not.toHaveBeenCalled();

    // Act + Assert: Cmd/Ctrl+Enter is the documented Duel shortcut.
    fireEvent.keyDown(nameInput, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(paneApi.createDuelPanes).toHaveBeenCalledTimes(1));
  });

  it('leaves single mode on the createPane path with no prompt requirement', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');

    // Assert: no duel prompt in single mode, submit enabled immediately
    expect(screen.queryByPlaceholderText(/ask both agents/i)).toBeNull();
    const launchButton = getSubmitButton(/launch pane/i);
    await waitFor(() => expect(launchButton.disabled).toBe(false));

    // Act
    fireEvent.click(launchButton);

    // Assert
    await waitFor(() => {
      expect(createPaneSpy).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }));
    });
    expect(paneApi.createDuelPanes).not.toHaveBeenCalled();
  });

  it('offers explicit update and classic choices when fullscreen preflight fails', async () => {
    createPaneSpy
      .mockResolvedValueOnce({
        success: false,
        error: 'Claude update required',
        claudeFullscreenPreflightFailed: true,
      })
      .mockResolvedValueOnce({ success: true, pane: { id: 'pane-1', slug: 'classic' } });
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /claude/i })).toBeTruthy());

    const launchButton = getSubmitButton(/launch pane/i);
    await waitFor(() => expect(launchButton.disabled).toBe(false));
    fireEvent.click(launchButton);

    const preflightDialog = await screen.findByRole('dialog', { name: 'Claude update required' });
    const updateClaude = within(preflightDialog).getByRole('button', { name: 'Update Claude' });
    await waitFor(() => expect(document.activeElement).toBe(updateClaude));
    const useClassic = within(preflightDialog).getByRole('button', {
      name: 'Use classic compatibility mode',
    });
    await waitFor(() => expect(useClassic.hasAttribute('disabled')).toBe(false));
    fireEvent.click(useClassic);

    await waitFor(() => expect(createPaneSpy).toHaveBeenCalledTimes(2));
    expect(createPaneSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      agent: 'claude',
      claudeRenderer: 'classic',
    }));
  });

  it('retries a preflight-blocked Duel with explicit classic compatibility', async () => {
    vi.mocked(paneApi.createDuelPanes)
      .mockResolvedValueOnce({
        success: false,
        error: 'Claude update required',
        claudeFullscreenPreflightFailed: true,
      } as Awaited<ReturnType<typeof paneApi.createDuelPanes>>)
      .mockResolvedValueOnce({
        success: true,
        paneA: { id: 'pane-a', slug: 'classic-a' },
        paneB: { id: 'pane-b', slug: 'codex-b' },
      } as Awaited<ReturnType<typeof paneApi.createDuelPanes>>);
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));
    fireEvent.change(getPromptTextarea(), { target: { value: 'compare answers' } });
    fireEvent.click(getSubmitButton(/start duel/i));

    const preflightDialog = await screen.findByRole('dialog', { name: 'Claude update required' });
    fireEvent.click(within(preflightDialog).getByRole('button', {
      name: 'Use classic compatibility mode',
    }));

    await waitFor(() => expect(paneApi.createDuelPanes).toHaveBeenCalledTimes(2));
    expect(paneApi.createDuelPanes).toHaveBeenLastCalledWith(expect.objectContaining({
      claudeRenderer: 'classic',
      sides: [
        { agent: 'claude', effort: undefined, model: undefined },
        { agent: 'codex', effort: undefined, model: undefined },
      ],
    }));
  });

  it('keeps the create dialog open when the update prompt is dismissed with Escape', async () => {
    createPaneSpy.mockResolvedValue({
      success: false,
      error: 'Claude update required',
      claudeFullscreenPreflightFailed: true,
    });
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await waitFor(() => expect(getSubmitButton(/launch pane/i).disabled).toBe(false));
    fireEvent.click(getSubmitButton(/launch pane/i));
    await screen.findByRole('dialog', { name: 'Claude update required' });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Claude update required' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'New Pane' })).toBeTruthy();
  });

  it('renders both duel side pickers as usable compact radiogroups', async () => {
    // Arrange
    render(<CreatePaneDialog />);
    await screen.findByRole('dialog');
    switchToDuel();
    await waitFor(() => expect(screen.getAllByRole('radiogroup')).toHaveLength(2));

    // Act
    selectAgentInGroup(0, /codex/i);
    selectAgentInGroup(1, /codex/i);

    // Assert: Side A codex selected, Side B codex selected (same agent allowed)
    const [groupA, groupB] = screen.getAllByRole('radiogroup');
    expect(within(groupA).getByRole('radio', { name: /codex/i }).getAttribute('aria-checked')).toBe('true');
    expect(within(groupB).getByRole('radio', { name: /codex/i }).getAttribute('aria-checked')).toBe('true');
  });
});
