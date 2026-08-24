import type { ActionResult, AumxPane } from 'aumx/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  assertClaudeFullscreenSupported: vi.fn(),
  closePane: vi.fn(),
  isAgentRunningInPane: vi.fn(),
  mergePane: vi.fn(),
  readRegisteredSession: vi.fn(),
  renamePane: vi.fn(),
  resumeAgentInPane: vi.fn(),
}));

vi.mock('aumx/core', async () => {
  const actual = await vi.importActual<typeof import('aumx/core')>('aumx/core');
  return {
    ...actual,
    assertClaudeFullscreenSupported: core.assertClaudeFullscreenSupported,
    closePane: core.closePane,
    isAgentRunningInPane: core.isAgentRunningInPane,
    mergePane: core.mergePane,
    readRegisteredSession: core.readRegisteredSession,
    renamePane: core.renamePane,
    resumeAgentInPane: core.resumeAgentInPane,
    SettingsManager: { getInstance: () => ({ getSettings: () => ({}) }) },
  };
});

vi.mock('../../src/main/services/git/gitDiff.js', () => ({
  releaseWorktreeSnapshot: vi.fn(),
}));

import { PaneActionWorkflow } from '../../src/main/services/bridge/PaneActionWorkflow.js';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    claudeRenderer: 'classic',
    id: 'pane',
    paneId: '%1',
    projectRoot: '/project',
    slug: 'feature',
    ...overrides,
  };
}

function makeHarness(initialPanes: AumxPane[] = [makePane()]) {
  let panes = initialPanes;
  const dependencies = {
    addPaneToDone: vi.fn(),
    buildActionContext: vi.fn(() => ({
      panes,
      projectName: 'project',
      savePanes: vi.fn(),
      sessionName: 'aumx-project',
    })),
    clearDuelMetadata: vi.fn(),
    getConfigPath: vi.fn(() => '/project/.amux/aumx.config.json'),
    getPane: vi.fn((paneId: string) => panes.find((pane) => pane.id === paneId)),
    getPaneCurrentCommand: vi.fn(async () => 'zsh'),
    getPanes: vi.fn(() => panes),
    getProjectRoot: vi.fn(() => '/project'),
    paneExists: vi.fn(async () => true),
    persistPanesTransactionally: vi.fn((next: AumxPane[]) => { panes = next; }),
    reapOrphanedTranscripts: vi.fn(async () => undefined),
  };
  return {
    dependencies,
    getPanes: () => panes,
    workflow: new PaneActionWorkflow(dependencies),
  };
}

describe('PaneActionWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.assertClaudeFullscreenSupported.mockResolvedValue(undefined);
    core.isAgentRunningInPane.mockResolvedValue(false);
    core.readRegisteredSession.mockReturnValue({ sessionId: 'session-1' });
    core.resumeAgentInPane.mockResolvedValue(true);
  });

  it('decorates successful close cleanup for worktree and duel state', async () => {
    const pane = makePane({
      duel: { groupId: 'group', prompt: 'compare', role: 'a' },
      worktreePath: '/project/.worktrees/feature',
    });
    const harness = makeHarness([pane, makePane({ id: 'sibling', duel: {
      groupId: 'group', prompt: 'compare', role: 'b',
    } })]);
    core.closePane.mockResolvedValue({ type: 'success', message: 'closed' });

    await expect(harness.workflow.close('pane')).resolves.toEqual({
      type: 'success',
      message: 'closed',
    });
    expect(harness.dependencies.reapOrphanedTranscripts).toHaveBeenCalledOnce();
    expect(harness.dependencies.clearDuelMetadata).toHaveBeenCalledWith(['pane', 'sibling']);
  });

  it('defers close cleanup until an interactive close callback succeeds', async () => {
    const harness = makeHarness();
    core.closePane.mockResolvedValue({
      type: 'choice',
      message: 'choose cleanup',
      onSelect: vi.fn(async (): Promise<ActionResult> => ({ type: 'success', message: 'closed' })),
    });

    const result = await harness.workflow.close('pane');
    expect(harness.dependencies.reapOrphanedTranscripts).not.toHaveBeenCalled();
    await result.onSelect?.('kill_clean_branch');
    expect(harness.dependencies.reapOrphanedTranscripts).toHaveBeenCalledOnce();
  });

  it('adds a pane to done only after the terminal merge result succeeds', async () => {
    const harness = makeHarness();
    core.mergePane.mockResolvedValue({
      type: 'confirm',
      message: 'confirm merge',
      onConfirm: vi.fn(async (): Promise<ActionResult> => ({ type: 'success', message: 'merged' })),
    });

    const result = await harness.workflow.merge('pane');
    expect(harness.dependencies.addPaneToDone).not.toHaveBeenCalled();
    await result.onConfirm?.();
    expect(harness.dependencies.addPaneToDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'pane' }));
  });

  it('decorates nested merge choice and input callbacks until they reach success', async () => {
    const harness = makeHarness();
    core.mergePane.mockResolvedValue({
      type: 'choice',
      message: 'choose merge strategy',
      onSelect: vi.fn(async (): Promise<ActionResult> => ({
        type: 'input',
        message: 'enter merge message',
        onSubmit: vi.fn(async (): Promise<ActionResult> => ({ type: 'success', message: 'merged' })),
      })),
    });

    const choice = await harness.workflow.merge('pane');
    const input = await choice.onSelect?.('squash');
    expect(harness.dependencies.addPaneToDone).not.toHaveBeenCalled();
    await input?.onSubmit?.('merge feature');

    expect(harness.dependencies.addPaneToDone)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'pane' }));
  });

  it('delegates rename with the current action context', async () => {
    const harness = makeHarness();
    core.renamePane.mockResolvedValue({ type: 'success', message: 'renamed' });

    await expect(harness.workflow.rename('pane', 'new-name')).resolves.toEqual({
      type: 'success',
      message: 'renamed',
    });
    expect(core.renamePane).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pane' }),
      expect.anything(),
      'new-name',
    );
  });

  it('persists fullscreen profile before resuming the registered session', async () => {
    const harness = makeHarness();
    core.resumeAgentInPane.mockImplementation(async () => {
      expect(harness.getPanes()[0]).toMatchObject({ claudeRenderer: 'fullscreen' });
      return true;
    });

    const confirmation = await harness.workflow.resumeInFullscreen('pane');
    await expect(confirmation.onConfirm?.()).resolves.toEqual({
      type: 'success',
      message: 'Claude resumed in fullscreen.',
    });
    expect(harness.dependencies.persistPanesTransactionally).toHaveBeenCalledOnce();
  });

  it('keeps the active fullscreen lock when rejecting a duplicate request', async () => {
    const harness = makeHarness();
    const inFlight = new Set(['pane']);
    const workflow = new PaneActionWorkflow(harness.dependencies, inFlight);

    await expect(workflow.resumeInFullscreen('pane')).resolves.toEqual({
      type: 'info',
      message: 'A fullscreen resume is already in progress for this pane.',
    });
    expect(inFlight.has('pane')).toBe(true);
  });
});
