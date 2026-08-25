import type { BrowserWindow } from 'electron';
import type { MuxBasePane } from 'muxbase/core';
import type { NormalizedSession, AgentType } from '../../../shared/agent-session-types.js';
import type { AgentSessionSearchResult } from '../../../shared/ipc-types.js';
import { IPC_EVENT } from '../../../shared/ipc-channels.js';
import type { PaneTopics } from '../../../shared/topic-types.js';
import { PaneSessionContext } from './PaneSessionContext.js';
import { SessionSearchIndex, type SessionSearchPane } from './SessionSearchIndex.js';
import { TopicService } from '../topics/TopicService.js';
import { createParser } from '../parsing/AgentLogParser.js';
import { isOpencodeDefaultTitle } from '../parsing/opencode-titles.js';
import { log } from '../Logger.js';
import { agentHasSessionParsing } from '../../../shared/agent-session-types.js';
import { estimateCostUSD } from '../../../shared/model-pricing.js';
import type { ClaudeCodeOtlpReceiver } from './ClaudeCodeOtlpReceiver.js';

const NO_TITLE_SOURCE = '';

/** A genuine title supplied by the running agent integration. */
export interface HarvestedTitle {
  title: string;
}

export class AgentSessionService {
  private contexts = new Map<string, PaneSessionContext>();
  private startingContexts = new Map<string, Promise<void>>();
  private claimedFiles = new Set<string>();
  private window: BrowserWindow | null = null;
  private projectRoot: string;
  private resolvePaneCwd?: (pane: MuxBasePane) => Promise<string | null>;
  private onSessionIdDiscovered?: (paneId: string, sessionId: string) => void;
  private onNativeTitleDiscovered?: (paneId: string, harvested: HarvestedTitle) => void;
  private persistedSessionIds = new Map<string, string>();
  private searchIndex: SessionSearchIndex;
  private paneSlugs = new Map<string, string>();
  private topicService = new TopicService();
  private lastAiTitles = new Map<string, string>();
  private dirtyDeliveryPaneIds = new Set<string>();

  constructor(
    projectRoot: string,
    resolvePaneCwd?: (pane: MuxBasePane) => Promise<string | null>,
    onSessionIdDiscovered?: (paneId: string, sessionId: string) => void,
    onNativeTitleDiscovered?: (paneId: string, harvested: HarvestedTitle) => void,
    private readonly otlpReceiver?: ClaudeCodeOtlpReceiver,
    private readonly topicsEnabled: () => boolean = () => false,
    private readonly onActivityEvidence?: (paneId: string, session: NormalizedSession) => void,
  ) {
    this.projectRoot = projectRoot;
    this.resolvePaneCwd = resolvePaneCwd;
    this.onSessionIdDiscovered = onSessionIdDiscovered;
    this.onNativeTitleDiscovered = onNativeTitleDiscovered;
    this.searchIndex = new SessionSearchIndex({
      getAllPanes: () => this.getSearchPanes(),
      getPane: (paneId) => this.getSearchPane(paneId),
    });
  }

  setWindow(win: BrowserWindow | null): void {
    if (this.window === win) {
      this.syncWindowVisibility();
      return;
    }

    this.dirtyDeliveryPaneIds.clear();
    this.window = win;
    if (!win) return;

    this.syncWindowVisibility();
  }

  syncWindowVisibility(): void {
    if (this.canDeliverToRenderer()) this.flushDirtyDeliveries();
  }

  async onPaneCreated(pane: MuxBasePane): Promise<void> {
    if (!pane.agent) return;
    const agentType = pane.agent as AgentType;
    if (!agentHasSessionParsing(agentType)) {
      log.debug('agent-session', 'Skipping unsupported agent', { paneId: pane.id, agent: pane.agent });
      return;
    }
    return this.startContextOnce(pane, agentType);
  }

  async ensureTracking(pane: MuxBasePane, detectedAgent: AgentType): Promise<void> {
    if (!agentHasSessionParsing(detectedAgent)) return;
    return this.startContextOnce({ ...pane, agent: detectedAgent }, detectedAgent);
  }

  hasContext(paneId: string): boolean {
    return this.contexts.has(paneId);
  }

  private startContextOnce(pane: MuxBasePane, agentType: AgentType): Promise<void> {
    if (this.contexts.has(pane.id)) return Promise.resolve();
    const inflight = this.startingContexts.get(pane.id);
    if (inflight) return inflight;

    const promise = this.startContext(pane, agentType)
      .finally(() => this.startingContexts.delete(pane.id));
    this.startingContexts.set(pane.id, promise);
    return promise;
  }

  private async startContext(pane: MuxBasePane, agentType: AgentType): Promise<void> {
    let context: PaneSessionContext | null = null;
    try {
      this.paneSlugs.set(pane.id, pane.slug);
      const parser = createParser(agentType);
      const paneCwd = await this.resolveDiscoveryRoot(pane);
      if (!this.startingContexts.has(pane.id)) {
        this.paneSlugs.delete(pane.id);
        return;
      }
      const source = pane.worktreePath ? 'worktree' : pane.projectRoot ? 'projectRoot' : 'fallback';
      log.info('agent-session', 'Discovery root resolved', { paneId: pane.id, paneCwd, source });
      context = new PaneSessionContext(
        pane,
        parser,
        paneCwd,
        (paneId, session) => {
          this.emitUpdate(paneId, session);
        },
        async () => this.resolveDiscoveryRoot(pane),
        this.claimedFiles,
      );
      this.contexts.set(pane.id, context);
      await context.start();
      log.info('agent-session', 'Session context started', { paneId: pane.id, agent: pane.agent });
    } catch (err) {
      this.discardFailedContext(pane.id, context);
      this.paneSlugs.delete(pane.id);
      log.error('agent-session', 'Failed to create session context', {
        paneId: pane.id,
        agent: agentType,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
    }
  }

  // A registered-but-unstarted context would make startContextOnce a permanent
  // no-op, so the pane could never be watched again. Drop it and let a later
  // onPaneCreated/ensureTracking retry from scratch.
  private discardFailedContext(paneId: string, context: PaneSessionContext | null): void {
    if (!context) return;
    context.stop();
    if (this.contexts.get(paneId) !== context) return;
    this.contexts.delete(paneId);
  }

  onPaneDestroyed(paneId: string): void {
    this.startingContexts.delete(paneId);
    this.dirtyDeliveryPaneIds.delete(paneId);
    const context = this.contexts.get(paneId);
    if (context) {
      context.stop();
      this.contexts.delete(paneId);
      this.persistedSessionIds.delete(paneId);
      this.paneSlugs.delete(paneId);
      this.lastAiTitles.delete(paneId);
      this.searchIndex.removePane(paneId);
      this.emitRemoval(paneId);
      log.info('agent-session', 'Session context stopped', { paneId });
    }
  }

  getSession(paneId: string): NormalizedSession | null {
    return this.contexts.get(paneId)?.getSession() ?? null;
  }

  async searchSessions(query: string): Promise<AgentSessionSearchResult[]> {
    const results = await this.searchIndex.search(query);
    log.info('agent-session', 'Search', { query, indexDocs: this.searchIndex.documentCount, results: results.length });
    return results;
  }

  private emitUpdate(paneId: string, session: NormalizedSession): void {
    this.enrichWithCost(session);

    // Must run before the canDeliverToRenderer gate below: activity evidence
    // has to stay correct even while the window is hidden/minimized.
    this.onActivityEvidence?.(paneId, session);

    log.infoThrottled('agent-session', 'Session update', {
      paneId,
      sessionId: session.sessionId,
      awaitingUserInput: session.awaitingUserInput === true,
      turnCompleted: session.turnCompleted === true,
      lastUpdateTime: session.lastUpdateTime,
      messageCount: session.messages.length,
      toolCallCount: session.metrics.toolCallCount,
    });

    this.searchIndex.markPaneDirty(paneId);

    if (session.sessionId && this.persistedSessionIds.get(paneId) !== session.sessionId) {
      this.persistedSessionIds.set(paneId, session.sessionId);
      this.onSessionIdDiscovered?.(paneId, session.sessionId);
    }

    if (this.canDeliverToRenderer()) {
      this.sendSessionUpdate(paneId, session);
      this.publishTopics(paneId, session);
    } else {
      this.dirtyDeliveryPaneIds.add(paneId);
    }

    this.harvestTitle(paneId, session);
  }

  private enrichWithCost(session: NormalizedSession): void {
    // Prefer Claude Code's own OTLP telemetry — that's the exact number the upstream
    // API (Anthropic, HAI, Bedrock, …) reported. Fall back to a local list-price
    // estimate when no telemetry is available for this session yet.
    const otlp = session.sessionId ? this.otlpReceiver?.getSessionCost(session.sessionId) : null;

    if (otlp && otlp.costUSD > 0) {
      // Spread session-total cost across messages proportionally to total tokens,
      // purely for per-turn chart tooltips. Session total is the source of truth.
      let totalTokenWeight = 0;
      for (const m of session.messages) {
        if (!m.tokens) continue;
        totalTokenWeight += m.tokens.inputTokens
          + m.tokens.outputTokens
          + (m.tokens.cacheReadTokens ?? 0)
          + (m.tokens.cacheCreationTokens ?? 0);
      }
      for (const m of session.messages) {
        if (!m.tokens) continue;
        const weight = m.tokens.inputTokens
          + m.tokens.outputTokens
          + (m.tokens.cacheReadTokens ?? 0)
          + (m.tokens.cacheCreationTokens ?? 0);
        m.tokens.costUSD = totalTokenWeight > 0
          ? (weight / totalTokenWeight) * otlp.costUSD
          : 0;
        m.tokens.costSource = 'otlp';
      }
      session.metrics.costUSD = otlp.costUSD;
      session.metrics.costSource = 'otlp';
      return;
    }

    // Estimate fallback — per-message accurate.
    let totalCost = 0;
    let hasAny = false;
    for (const message of session.messages) {
      if (!message.tokens) continue;
      message.tokens.costUSD = estimateCostUSD(message.tokens, message.model);
      message.tokens.costSource = 'estimate';
      totalCost += message.tokens.costUSD ?? 0;
      hasAny = true;
    }
    session.metrics.costUSD = totalCost;
    session.metrics.costSource = hasAny ? 'estimate' : 'none';
  }

  private getSearchPanes(): SessionSearchPane[] {
    const panes: SessionSearchPane[] = [];
    for (const paneId of this.contexts.keys()) {
      const pane = this.getSearchPane(paneId);
      if (pane) panes.push(pane);
    }
    return panes;
  }

  private getSearchPane(paneId: string): SessionSearchPane | null {
    const session = this.contexts.get(paneId)?.getSession();
    if (!session) return null;
    return {
      paneId,
      paneSlug: this.paneSlugs.get(paneId) ?? paneId,
      session,
    };
  }

  private canDeliverToRenderer(): boolean {
    return this.window !== null
      && !this.window.isDestroyed()
      && this.window.isVisible()
      && !this.window.isMinimized();
  }

  private sendSessionUpdate(paneId: string, session: NormalizedSession): void {
    this.window?.webContents.send(IPC_EVENT.AGENT_SESSION_UPDATED, { paneId, session });
  }

  private flushDirtyDeliveries(): void {
    const paneIds = [...this.dirtyDeliveryPaneIds];
    this.dirtyDeliveryPaneIds.clear();

    for (const paneId of paneIds) {
      if (!this.canDeliverToRenderer()) {
        this.dirtyDeliveryPaneIds.add(paneId);
        continue;
      }

      const session = this.getSession(paneId);
      if (!session) continue;
      this.sendSessionUpdate(paneId, session);
      this.publishTopics(paneId, session);
    }
  }

  private emitRemoval(paneId: string): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.AGENT_SESSION_REMOVED, { paneId });
      this.window.webContents.send(IPC_EVENT.TOPICS_REMOVED, { paneId });
    }
  }

  private harvestTitle(paneId: string, session: NormalizedSession): void {
    const harvested = this.resolveHarvestedTitle(session);
    if (!harvested) {
      this.logMissingTitleSource(paneId, session);
      return;
    }
    if (this.lastAiTitles.get(paneId) === harvested.title) return;
    this.lastAiTitles.set(paneId, harvested.title);
    this.onNativeTitleDiscovered?.(paneId, harvested);
  }

  /** Logged on outcome change only — every session update runs this path. */
  private logMissingTitleSource(paneId: string, session: NormalizedSession): void {
    if (this.lastAiTitles.get(paneId) === NO_TITLE_SOURCE) return;
    this.lastAiTitles.set(paneId, NO_TITLE_SOURCE);
    log.debug('agent-session', 'No usable pane title yet', {
      paneId,
      agent: session.agent,
      messageCount: session.messages.length,
      placeholderTitle: session.agent === 'opencode' && isOpencodeDefaultTitle(session.title),
    });
  }

  private resolveHarvestedTitle(session: NormalizedSession): HarvestedTitle | null {
    let candidate: string | undefined;
    if (session.agent === 'claude') {
      candidate = session.aiTitle;
    } else if (session.agent === 'opencode') {
      candidate = isOpencodeDefaultTitle(session.title) ? undefined : session.title;
    } else if (session.agent === 'pi') {
      candidate = session.title;
    } else {
      // The current Codex rollout parser exposes no live native title. Reserve
      // aiTitle for a future supported integration; never reuse its first-prompt title.
      candidate = session.aiTitle;
    }

    const title = candidate?.trim();
    return title ? { title } : null;
  }

  private publishTopics(paneId: string, session: NormalizedSession): void {
    if (!this.topicsEnabled()) return;
    this.emitTopics(paneId, session);
  }

  private emitTopics(paneId: string, session: NormalizedSession): void {
    const paneTopics = this.createPaneTopics(paneId, session);
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.TOPICS_UPDATED, { paneId, topics: paneTopics });
    }
  }

  private createPaneTopics(paneId: string, session: NormalizedSession): PaneTopics {
    return {
      paneId,
      sessionId: session.sessionId,
      agent: session.agent,
      topics: this.topicService.computeTopics(session),
      updatedAt: Date.now(),
    };
  }

  getAllTopics(): PaneTopics[] {
    const topics: PaneTopics[] = [];
    for (const [paneId, context] of this.contexts) {
      const session = context.getSession();
      if (session) topics.push(this.createPaneTopics(paneId, session));
    }
    return topics;
  }

  private async resolveDiscoveryRoot(pane: MuxBasePane): Promise<string> {
    if (pane.worktreePath) {
      return this.resolveWorktreeDiscoveryRoot(pane);
    }

    const paneRoot = pane.projectRoot;

    try {
      const paneCwd = await this.resolvePaneCwd?.(pane);
      if (paneCwd) {
        if (!paneRoot) return paneCwd;
        if (this.arePathsRelated(paneCwd, paneRoot)) return paneCwd;

        log.info('agent-session', 'Ignoring live pane cwd outside pane root', {
          paneId: pane.id,
          paneCwd,
          paneRoot,
        });
      }
    } catch (err) {
      log.debug('agent-session', 'Failed to resolve live pane cwd for session discovery', {
        paneId: pane.id,
        error: String(err),
      });
    }

    return paneRoot || this.projectRoot;
  }

  private async resolveWorktreeDiscoveryRoot(pane: MuxBasePane): Promise<string> {
    const worktreeRoot = pane.worktreePath;
    if (!worktreeRoot) return this.projectRoot;

    try {
      const paneCwd = await this.resolvePaneCwd?.(pane);
      if (paneCwd && this.arePathsRelated(paneCwd, worktreeRoot)) {
        return paneCwd;
      }
    } catch (err) {
      log.debug('agent-session', 'Failed to resolve live worktree cwd for session discovery', {
        paneId: pane.id,
        error: String(err),
      });
    }

    return worktreeRoot;
  }

  private arePathsRelated(a: string, b: string): boolean {
    const left = this.normalizePath(a);
    const right = this.normalizePath(b);
    if (!left || !right) return false;
    if (left === right) return true;
    return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  shutdown(): void {
    for (const context of this.contexts.values()) {
      context.stop();
    }
    this.contexts.clear();
    this.startingContexts.clear();
    this.claimedFiles.clear();
    this.persistedSessionIds.clear();
    this.paneSlugs.clear();
    this.lastAiTitles.clear();
    this.dirtyDeliveryPaneIds.clear();
    this.window = null;
    this.searchIndex.dispose();
    log.info('agent-session', 'All session contexts stopped');
  }
}
