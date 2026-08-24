import {
  assertClaudeFullscreenSupported,
  generateLocalSlug,
  resolvePaneTerminalProfile,
  SettingsManager,
  type ActionContext,
  type ActionResult,
  type AgentName,
  type AumxPane,
  type DuelMetadata,
} from 'aumx/core';
import { randomUUID } from 'node:crypto';
import type {
  DuelSideConfig,
  PaneCreateResponse,
  PaneDuelCreateResponse,
  PaneDuelResolveResponse,
} from '../../../shared/ipc-types.js';
import { formatError } from '../../utils/formatError.js';
import { log } from '../Logger.js';

export interface DuelRequest {
  claudeRenderer?: 'classic';
  paneName?: string;
  projectRoot?: string;
  prompt: string;
  sides: [DuelSideConfig, DuelSideConfig];
  useWorktree?: boolean;
}

interface DuelPaneLaunchOptions {
  claudeRenderer?: 'classic';
  duel: DuelMetadata;
  effort?: string;
  model?: string;
  projectRoot?: string;
  slugBase: string;
  slugSuffix: string;
  useWorktree?: boolean;
}

interface DuelWorkflowDependencies {
  buildActionContext(): ActionContext;
  closePane(pane: AumxPane, context: ActionContext): Promise<ActionResult>;
  createPane(prompt: string, agent: AgentName, options: DuelPaneLaunchOptions): Promise<PaneCreateResponse>;
  getPane(paneId: string): AumxPane | undefined;
  getPanes(): AumxPane[];
  getProjectRoot(): string;
  hasActiveProjectContext(): boolean;
  reapOrphanedTranscripts(): Promise<void>;
  replacePanesBestEffort(panes: AumxPane[]): void;
  setProgress(action: string, active: boolean): void;
}

function duelSideIdentity(side: DuelSideConfig): string {
  return `${side.agent}|${side.model ?? ''}|${side.effort ?? ''}`;
}

function validateDuelRequest(request: DuelRequest): string | null {
  if (!request.prompt.trim()) return 'A prompt is required to start a duel';
  const [sideA, sideB] = request.sides;
  if (duelSideIdentity(sideA) === duelSideIdentity(sideB)) {
    return 'Duel sides must differ in agent, model, or effort';
  }
  return null;
}

export class DuelWorkflow {
  constructor(private readonly dependencies: DuelWorkflowDependencies) {}

  async create(request: DuelRequest): Promise<PaneDuelCreateResponse> {
    const validationError = validateDuelRequest(request);
    if (validationError) return { success: false, error: validationError };

    if (
      this.dependencies.hasActiveProjectContext()
      && request.sides.some((side) => side.agent === 'claude')
    ) {
      const targetProjectRoot = request.projectRoot?.trim() || this.dependencies.getProjectRoot();
      const settings = SettingsManager.getInstance(targetProjectRoot).getSettings();
      const claudeProfile = resolvePaneTerminalProfile('claude', {
        ...settings,
        ...(request.claudeRenderer === 'classic' ? { claudeFullscreenRendering: false } : {}),
      });
      if (claudeProfile.claudeRenderer === 'fullscreen') {
        try {
          await assertClaudeFullscreenSupported();
        } catch (error) {
          return {
            success: false,
            error: formatError(error),
            claudeFullscreenPreflightFailed: true,
          };
        }
      }
    }

    const [sideA, sideB] = request.sides;
    const prompt = request.prompt.trim();
    const groupId = randomUUID();
    const slugBase = request.paneName?.trim() || generateLocalSlug(prompt);
    const sharedOptions = {
      claudeRenderer: request.claudeRenderer,
      projectRoot: request.projectRoot,
      slugBase,
      useWorktree: request.useWorktree,
    };
    log.info('bridge', 'Creating duel panes', {
      agentA: sideA.agent,
      agentB: sideB.agent,
      groupId,
    });
    this.dependencies.setProgress('Creating duel panes...', true);

    let paneA: AumxPane | undefined;
    try {
      const resultA = await this.dependencies.createPane(prompt, sideA.agent, {
        ...sharedOptions,
        duel: { groupId, prompt, role: 'a' },
        effort: sideA.effort,
        model: sideA.model,
        slugSuffix: 'a',
      });
      if (!resultA.success || !resultA.pane) {
        this.dependencies.setProgress('Creating duel panes...', false);
        return {
          success: false,
          claudeFullscreenPreflightFailed: resultA.claudeFullscreenPreflightFailed,
          error: resultA.error || 'Failed to create pane A',
        };
      }
      paneA = resultA.pane;

      const resultB = await this.dependencies.createPane(prompt, sideB.agent, {
        ...sharedOptions,
        duel: { groupId, prompt, role: 'b', siblingPaneId: paneA.id },
        effort: sideB.effort,
        model: sideB.model,
        slugSuffix: 'b',
      });
      if (!resultB.success || !resultB.pane) {
        this.clearMetadata([paneA.id]);
        this.dependencies.setProgress('Creating duel panes...', false);
        return {
          success: false,
          claudeFullscreenPreflightFailed: resultB.claudeFullscreenPreflightFailed,
          error: resultB.error || 'Failed to create pane B',
          survivorPaneId: paneA.id,
        };
      }

      const linkedPaneA = this.linkSibling(paneA.id, resultB.pane.id) ?? paneA;
      this.dependencies.setProgress('Creating duel panes...', false);
      return { success: true, groupId, paneA: linkedPaneA, paneB: resultB.pane };
    } catch (error) {
      log.error('bridge', 'Duel pane creation failed', error);
      if (paneA) this.clearMetadata([paneA.id]);
      this.dependencies.setProgress('Creating duel panes...', false);
      return {
        success: false,
        error: formatError(error),
        survivorPaneId: paneA?.id,
      };
    }
  }

  async resolve(winnerPaneId: string): Promise<PaneDuelResolveResponse> {
    const winner = this.dependencies.getPane(winnerPaneId);
    if (!winner) return { success: false, error: 'Pane not found' };
    if (!winner.duel) return { success: true };

    const { groupId, role, siblingPaneId } = winner.duel;
    const groupPanes = this.dependencies.getPanes().filter(
      (pane) => pane.duel?.groupId === groupId,
    );
    const linkedSibling = siblingPaneId
      ? groupPanes.find((pane) => pane.id === siblingPaneId && pane.duel?.role !== role)
      : undefined;
    const oppositeSides = groupPanes.filter(
      (pane) => pane.id !== winnerPaneId && pane.duel?.role !== role,
    );
    const loser = linkedSibling ?? (oppositeSides.length === 1 ? oppositeSides[0] : undefined);

    if (loser) {
      const closeError = await this.closeLoser(loser);
      if (closeError) return { success: false, error: closeError };
    }

    const remainingGroupIds = this.dependencies.getPanes()
      .filter((pane) => pane.duel?.groupId === groupId)
      .map((pane) => pane.id);
    this.clearMetadata(remainingGroupIds);
    log.info('bridge', 'Resolved duel', { groupId, loserPaneId: loser?.id, winnerPaneId });
    return loser ? { success: true, loserPaneId: loser.id } : { success: true };
  }

  clearMetadata(paneIds: readonly string[]): void {
    const target = new Set(paneIds);
    const updated = this.dependencies.getPanes().map((pane) => {
      if (!target.has(pane.id) || !pane.duel) return pane;
      const { duel: _duel, ...rest } = pane;
      return rest;
    });
    this.dependencies.replacePanesBestEffort(updated);
  }

  private async closeLoser(loser: AumxPane): Promise<string | null> {
    const context = this.dependencies.buildActionContext();
    const closeResult = await this.dependencies.closePane(loser, context);
    const result = closeResult.type === 'choice' && closeResult.onSelect
      ? await closeResult.onSelect('kill_clean_branch')
      : closeResult;
    if (result.type === 'error') return result.message;
    if (result.type !== 'success') return 'Unable to close the losing Duel pane';
    void this.dependencies.reapOrphanedTranscripts();
    return null;
  }

  private linkSibling(paneId: string, siblingPaneId: string): AumxPane | null {
    const current = this.dependencies.getPanes();
    const index = current.findIndex((pane) => pane.id === paneId);
    if (index < 0 || !current[index].duel) return null;
    const linked: AumxPane = {
      ...current[index],
      duel: { ...current[index].duel, siblingPaneId },
    };
    const updated = current.map((pane, currentIndex) => currentIndex === index ? linked : pane);
    this.dependencies.replacePanesBestEffort(updated);
    return linked;
  }
}
