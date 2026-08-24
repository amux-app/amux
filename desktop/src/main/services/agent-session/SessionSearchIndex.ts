import MiniSearch from 'minisearch';
import type { SearchResult } from 'minisearch';
import type { NormalizedMessage, NormalizedSession } from '../../../shared/agent-session-types.js';
import type { AgentSessionSearchResult } from '../../../shared/ipc-types.js';
import { log } from '../Logger.js';

interface IndexedMessage {
  id: string;
  paneId: string;
  paneSlug: string;
  messageId: string;
  messageType: string;
  content: string;
  toolSummary: string;
  filePath: string;
  timestamp?: number;
}

interface ChunkProgress {
  processedMessages: number;
}

export interface SessionSearchPane {
  paneId: string;
  paneSlug: string;
  session: NormalizedSession;
}

export interface SessionSearchSource {
  getAllPanes(): SessionSearchPane[];
  getPane(paneId: string): SessionSearchPane | null;
}

export interface SessionSearchIndexOptions {
  chunkSize?: number;
  inactivityMs?: number;
}

type SearchHit = SearchResult & IndexedMessage;

const DEFAULT_CHUNK_SIZE = 250;
const DEFAULT_INACTIVITY_MS = 2 * 60_000;
const SNIPPET_CONTEXT_CHARS = 40;
const MAX_RESULTS = 50;
const MAX_OCCURRENCES_PER_MESSAGE = 5;
const MAX_RECONCILIATION_ROUNDS = 4;
const TOKEN_SEPARATOR = /[\s/\\,.;:!?()[\]{}<>"'`~@#$%^&*+=|]+/;

export class SessionSearchIndex {
  private index: MiniSearch<IndexedMessage> | null = null;
  private paneDocIds = new Map<string, Set<string>>();
  private dirtyPaneIds = new Set<string>();
  private removedPaneIds = new Set<string>();
  private initialBuild: Promise<void> | null = null;
  private reconciliation: Promise<void> | null = null;
  private evictionTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private disposed = false;
  private readonly chunkSize: number;
  private readonly inactivityMs: number;

  constructor(
    private readonly source: SessionSearchSource,
    options: SessionSearchIndexOptions = {},
  ) {
    this.chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    this.inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  }

  markPaneDirty(paneId: string): void {
    if (this.disposed) return;
    if (!this.index && !this.initialBuild) return;
    this.removedPaneIds.delete(paneId);
    this.dirtyPaneIds.add(paneId);
  }

  removePane(paneId: string): void {
    if (this.disposed) return;
    if (!this.index && !this.initialBuild) return;

    this.removedPaneIds.add(paneId);
    this.dirtyPaneIds.add(paneId);
  }

  async search(query: string): Promise<AgentSessionSearchResult[]> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || this.disposed) return [];

    this.clearEvictionTimer();
    const index = await this.getReadyIndex();
    if (!index) return [];
    const results = createSearchResults(index.search(normalizedQuery), normalizedQuery);
    this.refreshEvictionTimer();
    return results;
  }

  clear(): void {
    this.resetIndex();
  }

  dispose(): void {
    this.disposed = true;
    this.resetIndex();
  }

  private resetIndex(): void {
    this.generation += 1;
    this.clearEvictionTimer();
    this.index = null;
    this.initialBuild = null;
    this.reconciliation = null;
    this.paneDocIds.clear();
    this.dirtyPaneIds.clear();
    this.removedPaneIds.clear();
  }

  get documentCount(): number {
    return this.index?.documentCount ?? 0;
  }

  private async getReadyIndex(): Promise<MiniSearch<IndexedMessage> | null> {
    while (!this.disposed) {
      if (!this.index) await (this.initialBuild ?? this.startInitialBuild());
      if (this.disposed) return null;

      const index = this.index;
      if (!index) continue;
      const generation = this.generation;
      await this.reconcileDirtyPanes(index, generation);
      if (index === this.index && generation === this.generation) return index;
    }

    return null;
  }

  private startInitialBuild(): Promise<void> {
    const generation = this.generation;
    const build = this.buildInitialIndex(generation);
    this.initialBuild = build;
    void build.then(
      () => this.releaseInitialBuild(build),
      () => this.releaseInitialBuild(build),
    );
    return build;
  }

  private releaseInitialBuild(build: Promise<void>): void {
    if (this.initialBuild === build) this.initialBuild = null;
  }

  private async buildInitialIndex(generation: number): Promise<void> {
    const panes = this.source.getAllPanes();
    const documents: IndexedMessage[] = [];
    const paneDocIds = new Map<string, Set<string>>();
    const progress: ChunkProgress = { processedMessages: 0 };

    for (const pane of panes) {
      const paneDocuments = await this.buildPaneDocumentsChunked(
        pane,
        generation,
        null,
        progress,
      );
      if (!paneDocuments) return;
      for (const document of paneDocuments) documents.push(document);
      paneDocIds.set(pane.paneId, new Set(paneDocuments.map((record) => record.id)));
    }

    const index = createMiniSearch();
    await index.addAllAsync(documents, { chunkSize: this.chunkSize });
    if (generation !== this.generation) return;

    this.index = index;
    this.paneDocIds = paneDocIds;
    await this.reconcileDirtyPanes(index, generation);
  }

  private async reconcileDirtyPanes(
    index: MiniSearch<IndexedMessage>,
    generation: number,
  ): Promise<void> {
    for (let round = 0; round < MAX_RECONCILIATION_ROUNDS; round += 1) {
      if (
        generation !== this.generation
        || index !== this.index
      ) return;

      if (this.reconciliation) {
        await this.reconciliation;
        continue;
      }
      if (this.dirtyPaneIds.size === 0) return;

      const reconciliation = this.runReconciliation(index, generation);
      this.reconciliation = reconciliation;
      try {
        await reconciliation;
      } finally {
        if (this.reconciliation === reconciliation) this.reconciliation = null;
      }
    }
  }

  private async runReconciliation(
    index: MiniSearch<IndexedMessage>,
    generation: number,
  ): Promise<void> {
    let requiresVacuum = false;

    const paneIds = [...this.dirtyPaneIds];
    this.dirtyPaneIds.clear();

    for (const paneId of paneIds) {
      if (generation !== this.generation || index !== this.index) return;
      const pane = this.removedPaneIds.has(paneId) ? null : this.source.getPane(paneId);
      if (!pane) {
        const discarded = await this.discardPane(index, paneId, generation);
        if (generation !== this.generation || index !== this.index) return;
        requiresVacuum = discarded || requiresVacuum;
        this.removedPaneIds.delete(paneId);
        continue;
      }

      requiresVacuum = await this.reconcilePane(index, pane, generation) || requiresVacuum;
    }

    if (requiresVacuum && generation === this.generation && index === this.index) {
      await index.vacuum();
    }
  }

  private async reconcilePane(
    index: MiniSearch<IndexedMessage>,
    pane: SessionSearchPane,
    generation: number,
  ): Promise<boolean> {
    const documents = await this.buildPaneDocumentsChunked(pane, generation, index);
    if (!documents) return false;
    const nextIds = new Set(documents.map((record) => record.id));
    const previousIds = this.paneDocIds.get(pane.paneId);
    let changed = false;

    for (let indexPosition = 0; indexPosition < documents.length; indexPosition += 1) {
      const record = documents[indexPosition];
      const stored = index.getStoredFields(record.id);
      if (!stored) {
        index.add(record);
      } else if (!storedFieldsEqual(stored, record)) {
        index.replace(record);
        changed = true;
      }
      if ((indexPosition + 1) % this.chunkSize === 0) {
        await yieldToEventLoop();
        if (generation !== this.generation || index !== this.index) return false;
      }
    }

    if (previousIds) {
      let processedIds = 0;
      for (const documentId of previousIds) {
        if (nextIds.has(documentId)) continue;
        index.discard(documentId);
        changed = true;
        processedIds += 1;
        if (processedIds % this.chunkSize === 0) {
          await yieldToEventLoop();
          if (generation !== this.generation || index !== this.index) return false;
        }
      }
    }

    this.paneDocIds.set(pane.paneId, nextIds);
    this.removedPaneIds.delete(pane.paneId);
    log.debug('search-index', 'Pane reconciled', {
      paneId: pane.paneId,
      documentCount: nextIds.size,
    });
    return changed;
  }

  private async buildPaneDocumentsChunked(
    pane: SessionSearchPane,
    generation: number,
    expectedIndex: MiniSearch<IndexedMessage> | null,
    progress: ChunkProgress = { processedMessages: 0 },
  ): Promise<IndexedMessage[] | null> {
    const documents: IndexedMessage[] = [];
    for (let indexPosition = 0; indexPosition < pane.session.messages.length; indexPosition += 1) {
      const document = buildMessageDocument(pane, pane.session.messages[indexPosition]);
      if (document) documents.push(document);
      progress.processedMessages += 1;
      if (progress.processedMessages % this.chunkSize === 0) {
        await yieldToEventLoop();
        if (
          generation !== this.generation
          || (expectedIndex !== null && expectedIndex !== this.index)
        ) return null;
      }
    }
    return documents;
  }

  private async discardPane(
    index: MiniSearch<IndexedMessage>,
    paneId: string,
    generation: number,
  ): Promise<boolean> {
    const documentIds = this.paneDocIds.get(paneId);
    if (!documentIds) return false;

    let processedIds = 0;
    for (const documentId of documentIds) {
      if (index.getStoredFields(documentId)) index.discard(documentId);
      processedIds += 1;
      if (processedIds % this.chunkSize === 0) {
        await yieldToEventLoop();
        if (generation !== this.generation || index !== this.index) return false;
      }
    }
    this.paneDocIds.delete(paneId);
    return documentIds.size > 0;
  }

  private refreshEvictionTimer(): void {
    if (!this.index || this.disposed) return;
    this.clearEvictionTimer();
    this.evictionTimer = setTimeout(() => this.clear(), this.inactivityMs);
    this.evictionTimer.unref();
  }

  private clearEvictionTimer(): void {
    if (!this.evictionTimer) return;
    clearTimeout(this.evictionTimer);
    this.evictionTimer = null;
  }
}

function createMiniSearch(): MiniSearch<IndexedMessage> {
  return new MiniSearch<IndexedMessage>({
    fields: ['content', 'toolSummary'],
    storeFields: [
      'paneId',
      'paneSlug',
      'messageId',
      'messageType',
      'content',
      'toolSummary',
      'filePath',
      'timestamp',
    ],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { content: 2, toolSummary: 1 },
    },
    tokenize: (text) => text.toLowerCase().split(TOKEN_SEPARATOR).filter(Boolean),
  });
}

function buildMessageDocument(
  pane: SessionSearchPane,
  message: NormalizedMessage,
): IndexedMessage | null {
  const content = (message.content ?? '').trim();
  const toolData = buildToolIndexData(message);
  if (!content && !toolData.summary) return null;

  return {
    id: `${pane.paneId}::${message.id}`,
    paneId: pane.paneId,
    paneSlug: pane.paneSlug,
    messageId: message.id,
    messageType: message.type,
    content,
    toolSummary: toolData.summary,
    filePath: toolData.filePath,
    timestamp: message.timestamp,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function storedFieldsEqual(stored: Record<string, unknown>, record: IndexedMessage): boolean {
  return stored.paneId === record.paneId
    && stored.paneSlug === record.paneSlug
    && stored.messageId === record.messageId
    && stored.messageType === record.messageType
    && stored.content === record.content
    && stored.toolSummary === record.toolSummary
    && stored.filePath === record.filePath
    && stored.timestamp === record.timestamp;
}

interface ToolIndexData {
  summary: string;
  filePath: string;
}

function buildToolIndexData(message: NormalizedMessage): ToolIndexData {
  const parts: string[] = [];
  let filePath = '';

  for (const toolCall of message.toolCalls) {
    parts.push(toolCall.name);
    const path = toolCall.input.file_path ?? toolCall.input.path;
    if (typeof path === 'string') {
      parts.push(path);
      if (!filePath) filePath = path;
    }
    const command = toolCall.input.command;
    if (typeof command === 'string') parts.push(command.slice(0, 200));
    const pattern = toolCall.input.pattern ?? toolCall.input.query;
    if (typeof pattern === 'string') parts.push(pattern);
  }

  for (const toolResult of message.toolResults) {
    if (toolResult.content) parts.push(toolResult.content.slice(0, 500));
  }

  return { summary: parts.join(' '), filePath };
}

function createSearchResults(hits: SearchResult[], query: string): AgentSessionSearchResult[] {
  const results: AgentSessionSearchResult[] = [];

  for (const hit of hits) {
    if (results.length >= MAX_RESULTS) break;

    const stored = hit as SearchHit;
    const snippetSource = stored.content || stored.toolSummary;
    const base = {
      paneId: stored.paneId,
      paneSlug: stored.paneSlug,
      messageId: stored.messageId,
      messageType: stored.messageType,
      filePath: stored.filePath || undefined,
      timestamp: stored.timestamp,
    };
    const occurrences = findAllOccurrences(snippetSource, query);

    if (occurrences.length === 0) {
      results.push({ ...base, snippet: snippetSource.slice(0, SNIPPET_CONTEXT_CHARS * 2) });
      continue;
    }

    const limit = Math.min(occurrences.length, MAX_OCCURRENCES_PER_MESSAGE);
    for (let i = 0; i < limit && results.length < MAX_RESULTS; i++) {
      results.push({ ...base, snippet: extractSnippetAt(snippetSource, occurrences[i], query.length) });
    }
  }

  return results;
}

function findAllOccurrences(content: string, query: string): number[] {
  if (!content || !query) return [];
  const lower = content.toLowerCase();
  const queryLower = query.toLowerCase();
  const indices: number[] = [];
  let position = 0;

  while (position < lower.length) {
    const index = lower.indexOf(queryLower, position);
    if (index === -1) break;
    indices.push(index);
    position = index + 1;
  }
  return indices;
}

function extractSnippetAt(content: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(content.length, index + queryLength + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return prefix + content.slice(start, end) + suffix;
}
