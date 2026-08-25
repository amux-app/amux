import type { ActionResult, AgentName, MuxBasePane } from 'muxbase/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  assertClaudeFullscreenSupported: vi.fn(),
}));

vi.mock('muxbase/core', async () => {
  const actual = await vi.importActual<typeof import('muxbase/core')>('muxbase/core');
  return {
    ...actual,
    assertClaudeFullscreenSupported: core.assertClaudeFullscreenSupported,
  };
});

import { DuelWorkflow } from '../../src/main/services/bridge/DuelWorkflow';

function pane(id: string, overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'claude',
    id,
    paneId: `%${id}`,
    prompt: 'compare solutions',
    slug: id,
    ...overrides,
  };
}

function makeHarness() {
  let panes: MuxBasePane[] = [];
  const closePane = vi.fn(async (target: MuxBasePane): Promise<ActionResult> => {
    panes = panes.filter((candidate) => candidate.id !== target.id);
    return { message: 'closed', type: 'success' };
  });
  const createPane = vi.fn(async (prompt: string, agent: AgentName, options: { duel: NonNullable<MuxBasePane['duel']> }) => {
    const created = pane(`pane-${options.duel.role}`, {
      agent,
      duel: options.duel,
      prompt,
    });
    panes = [...panes, created];
    return { pane: created, success: true };
  });
  const dependencies = {
    buildActionContext: vi.fn(() => ({} as never)),
    closePane,
    createPane,
    getPane: (paneId: string) => panes.find((candidate) => candidate.id === paneId),
    getPanes: () => panes,
    getProjectRoot: () => '/project',
    hasActiveProjectContext: () => true,
    reapOrphanedTranscripts: vi.fn().mockResolvedValue(undefined),
    replacePanesBestEffort: vi.fn((nextPanes: MuxBasePane[]) => { panes = nextPanes; }),
    setProgress: vi.fn(),
  };
  return {
    dependencies,
    getPanes: () => panes,
    setPanes: (nextPanes: MuxBasePane[]) => { panes = nextPanes; },
    workflow: new DuelWorkflow(dependencies),
  };
}

describe('DuelWorkflow', () => {
  beforeEach(() => {
    core.assertClaudeFullscreenSupported.mockReset().mockResolvedValue(undefined);
  });

  it('rejects identical sides before creating panes', async () => {
    const harness = makeHarness();

    const result = await harness.workflow.create({
      prompt: 'compare',
      sides: [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'opus' }],
    });

    expect(result).toEqual({ success: false, error: 'Duel sides must differ in agent, model, or effort' });
    expect(harness.dependencies.createPane).not.toHaveBeenCalled();
  });

  it('links both successful panes through persisted duel metadata', async () => {
    const harness = makeHarness();

    const result = await harness.workflow.create({
      prompt: 'compare',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
    });

    expect(result.success).toBe(true);
    expect(result.paneA?.duel?.siblingPaneId).toBe('pane-b');
    expect(result.paneB?.duel?.siblingPaneId).toBe('pane-a');
    expect(harness.getPanes().map((candidate) => candidate.duel?.siblingPaneId)).toEqual(['pane-b', 'pane-a']);
  });

  it('clears survivor metadata when the second pane fails', async () => {
    const harness = makeHarness();
    harness.dependencies.createPane
      .mockImplementationOnce(async (prompt, agent, options) => {
        const created = pane('pane-a', { agent, duel: options.duel, prompt });
        harness.setPanes([created]);
        return { pane: created, success: true };
      })
      .mockResolvedValueOnce({ error: 'launch failed', success: false });

    const result = await harness.workflow.create({
      prompt: 'compare',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
    });

    expect(result).toMatchObject({ success: false, survivorPaneId: 'pane-a' });
    expect(harness.getPanes()[0]?.duel).toBeUndefined();
  });

  it('resolves the linked loser and clears winner metadata', async () => {
    const harness = makeHarness();
    harness.setPanes([
      pane('winner', { duel: { groupId: 'group', prompt: 'compare', role: 'a', siblingPaneId: 'loser' } }),
      pane('loser', { duel: { groupId: 'group', prompt: 'compare', role: 'b', siblingPaneId: 'winner' } }),
    ]);

    const result = await harness.workflow.resolve('winner');

    expect(result).toEqual({ success: true, loserPaneId: 'loser' });
    expect(harness.getPanes()).toHaveLength(1);
    expect(harness.getPanes()[0]?.duel).toBeUndefined();
    expect(harness.dependencies.reapOrphanedTranscripts).toHaveBeenCalledOnce();
  });

  it('keeps both panes unchanged when loser close fails', async () => {
    const harness = makeHarness();
    harness.setPanes([
      pane('winner', { duel: { groupId: 'group', prompt: 'compare', role: 'a', siblingPaneId: 'loser' } }),
      pane('loser', { duel: { groupId: 'group', prompt: 'compare', role: 'b', siblingPaneId: 'winner' } }),
    ]);
    harness.dependencies.closePane.mockResolvedValue({ message: 'cannot close', type: 'error' });

    await expect(harness.workflow.resolve('winner')).resolves.toEqual({ success: false, error: 'cannot close' });
    expect(harness.getPanes()).toHaveLength(2);
    expect(harness.getPanes()[0]?.duel).toBeDefined();
  });
});
