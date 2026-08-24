import type { AumxPane, DuelMetadata, ReviewMetadata } from 'aumx/core';
import { CLAUDE_TERMINAL_COLS } from 'aumx/pane-terminal-profile';
import type {
  CompactionEvent,
  MessageTokens,
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolCall,
  NormalizedToolResult,
  SessionMetrics,
  SubagentSession,
  TokenAttribution,
} from '../../shared/agent-session-types';
import type {
  AgentSessionRemovedEvent,
  AgentSessionSearchResult,
  AgentSessionUpdatedEvent,
  FileEntry,
  FileListResponse,
  FileMoveErrorCode,
  FileMoveItemResult,
  FileMoveResponse,
  FileMutationResponse,
  FileReadBinaryResponse,
  FileReadResponse,
  FileWriteResponse,
  FormatDocumentResponse,
  ProgressEvent,
  ProjectFileSearchResult,
  ProjectTextSearchResult,
  ToastEvent,
} from '../../shared/ipc-types';
import type { ActivitySnapshot, PaneActivity, PaneActivityChangedEvent } from '../../shared/pane-activity';
import type { ConversationTopic, PaneTopics } from '../../shared/topic-types';
import { rendererLog } from './rendererLog';

const AGENT_NAMES = new Set(['claude', 'codex', 'opencode', 'pi']);
const CLAUDE_RENDERERS = new Set(['classic', 'fullscreen']);
const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'tool_result']);
const MAX_VALIDATED_RESULTS = 50;
const PANE_TYPES = new Set(['worktree', 'shell']);
const TEST_STATUSES = new Set(['running', 'passed', 'failed']);
const TOAST_SEVERITIES = new Set(['success', 'error', 'info', 'warning']);
const PANE_ACTIVITY_STATES = new Set(['unknown', 'starting', 'working', 'waiting', 'idle', 'stopped']);
const ACTIVITY_ORIGINS = new Set(['adapter', 'session-log', 'stream', 'poll', 'liveness', 'none']);
const ADAPTER_HEALTH = new Set(['healthy', 'degraded', 'absent']);
const LIVENESS = new Set(['running', 'stopped', 'unknown']);
const ADAPTER_SUPPORT = new Set(['full', 'partial', 'none']);
const ADAPTER_CAPABILITIES = new Set(['turnIds', 'notifications', 'backgroundSnapshots', 'compaction', 'backgroundEntities']);
const FILE_MOVE_ERROR_CODES = new Set(['DUPLICATE_TARGET', 'EACCES', 'EEXIST', 'ENOENT', 'INVALID', 'UNKNOWN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (isString(value) && value.length > 0);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || isBoolean(value);
}

function isAgentName(value: unknown): boolean {
  return isString(value) && AGENT_NAMES.has(value);
}

function isReviewMetadata(value: unknown): value is ReviewMetadata {
  if (!isRecord(value)) return false;

  return isString(value.sourcePaneId)
    && isString(value.sourceSlug)
    && isOptionalString(value.sourceWorktreePath)
    && isString(value.reviewId)
    && isFiniteNumber(value.changedFiles)
    && isFiniteNumber(value.startedAt)
    && isOptionalFiniteNumber(value.handedOffAt);
}

function isDuelMetadata(value: unknown): value is DuelMetadata {
  if (!isRecord(value)) return false;

  return isString(value.groupId)
    && value.groupId.length > 0
    && (value.role === 'a' || value.role === 'b')
    && isString(value.prompt)
    && value.prompt.trim().length > 0
    && isOptionalNonEmptyString(value.siblingPaneId);
}

function hasValidTerminalProfile(value: Record<string, unknown>): boolean {
  if (value.type === 'shell') {
    return value.agent === undefined
      && value.claudeRenderer === undefined
      && value.terminalFixedCols === undefined;
  }

  const isClaudePane = value.agent === 'claude';
  if (!isClaudePane) {
    return value.claudeRenderer === undefined && value.terminalFixedCols === undefined;
  }

  // Legacy/default Claude panes (created before the renderer field existed, or
  // by an older build) carry no explicit renderer — the valid "neither field"
  // shape of PaneTerminalProfile. Accept them instead of dropping the pane from
  // the UI; they fall back to the default renderer at attach time.
  if (value.claudeRenderer === undefined) {
    return value.terminalFixedCols === undefined;
  }

  if (!isString(value.claudeRenderer) || !CLAUDE_RENDERERS.has(value.claudeRenderer)) {
    return false;
  }
  if (value.claudeRenderer === 'classic') {
    return value.terminalFixedCols === CLAUDE_TERMINAL_COLS;
  }
  return value.terminalFixedCols === undefined;
}

function isAumxPane(value: unknown): value is AumxPane {
  if (!isRecord(value)) return false;

  return isString(value.id)
    && isString(value.slug)
    && isOptionalString(value.title)
    && isOptionalBoolean(value.titleLocked)
    && isString(value.prompt)
    && isString(value.paneId)
    && isOptionalString(value.branchName)
    && isOptionalString(value.terminalTranscriptPath)
    && isOptionalString(value.projectRoot)
    && isOptionalString(value.projectName)
    && (value.type === undefined || (isString(value.type) && PANE_TYPES.has(value.type)))
    && isOptionalString(value.shellType)
    && isOptionalString(value.worktreePath)
    && isOptionalString(value.sourceBacklogId)
    && isOptionalString(value.testWindowId)
    && (value.testStatus === undefined || (isString(value.testStatus) && TEST_STATUSES.has(value.testStatus)))
    && isOptionalString(value.testOutput)
    && isOptionalString(value.devWindowId)
    && (value.devStatus === undefined || value.devStatus === 'running' || value.devStatus === 'stopped')
    && isOptionalString(value.devUrl)
    && (value.agent === undefined || isAgentName(value.agent))
    && hasValidTerminalProfile(value)
    && isOptionalString(value.agentSessionId)
    && isOptionalString(value.model)
    && isOptionalString(value.effort)
    && (value.role === undefined || value.role === 'review')
    && (value.review === undefined || isReviewMetadata(value.review))
    && (value.duel === undefined || isDuelMetadata(value.duel));
}

function isNormalizedToolCall(value: unknown): value is NormalizedToolCall {
  if (!isRecord(value)) return false;

  return isString(value.id)
    && isString(value.name)
    && isRecord(value.input)
    && isOptionalFiniteNumber(value.timestamp);
}

function isNormalizedToolResult(value: unknown): value is NormalizedToolResult {
  if (!isRecord(value)) return false;

  return isString(value.toolCallId)
    && isString(value.content)
    && isBoolean(value.isError)
    && isOptionalFiniteNumber(value.durationMs);
}

function isMessageTokens(value: unknown): value is MessageTokens {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.inputTokens)
    && isFiniteNumber(value.outputTokens)
    && isOptionalFiniteNumber(value.cacheReadTokens)
    && isOptionalFiniteNumber(value.cacheCreationTokens);
}

function isTokenAttribution(value: unknown): value is TokenAttribution {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.systemPrompt)
    && isFiniteNumber(value.conversationHistory)
    && isFiniteNumber(value.toolResults)
    && isFiniteNumber(value.cacheRead);
}

function isNormalizedMessage(value: unknown): value is NormalizedMessage {
  if (!isRecord(value)) return false;

  return isString(value.id)
    && isString(value.type)
    && MESSAGE_TYPES.has(value.type)
    && isString(value.content)
    && isOptionalString(value.thinkingContent)
    && (value.tokens === undefined || isMessageTokens(value.tokens))
    && (value.attribution === undefined || isTokenAttribution(value.attribution))
    && isOptionalFiniteNumber(value.timestamp)
    && Array.isArray(value.toolCalls)
    && value.toolCalls.every(isNormalizedToolCall)
    && Array.isArray(value.toolResults)
    && value.toolResults.every(isNormalizedToolResult);
}

function isSessionMetrics(value: unknown): value is SessionMetrics {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.totalTokens)
    && isFiniteNumber(value.inputTokens)
    && isFiniteNumber(value.outputTokens)
    && isFiniteNumber(value.cacheReadTokens)
    && isFiniteNumber(value.cacheCreationTokens)
    && isFiniteNumber(value.messageCount)
    && isFiniteNumber(value.toolCallCount);
}

function isCompactionEvent(value: unknown): value is CompactionEvent {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.turnIndex)
    && isFiniteNumber(value.tokensBefore)
    && isFiniteNumber(value.tokensAfter)
    && isOptionalFiniteNumber(value.timestamp);
}

function isSubagentSession(value: unknown): value is SubagentSession {
  if (!isRecord(value)) return false;

  return isString(value.parentToolCallId)
    && isString(value.description)
    && Array.isArray(value.messages)
    && value.messages.every(isNormalizedMessage)
    && isSessionMetrics(value.metrics);
}

function isNormalizedSession(value: unknown): value is NormalizedSession {
  if (!isRecord(value)) return false;

  return isAgentName(value.agent)
    && isString(value.sessionId)
    && isOptionalString(value.aiTitle)
    && Array.isArray(value.messages)
    && value.messages.every(isNormalizedMessage)
    && isSessionMetrics(value.metrics)
    && Array.isArray(value.compactionEvents)
    && value.compactionEvents.every(isCompactionEvent)
    && Array.isArray(value.subagents)
    && value.subagents.every(isSubagentSession)
    && isBoolean(value.isOngoing)
    && isOptionalBoolean(value.turnCompleted)
    && isOptionalBoolean(value.awaitingUserInput)
    && isOptionalString(value.pendingUserQuestion)
    && isOptionalFiniteNumber(value.startTime)
    && isOptionalFiniteNumber(value.lastUpdateTime)
    && isOptionalString(value.providerId)
    && isOptionalString(value.modelId);
}

function isFileEntry(value: unknown): value is FileEntry {
  if (!isRecord(value)) return false;

  return isString(value.name)
    && isString(value.path)
    && isBoolean(value.isDirectory);
}

function isToastEvent(value: unknown): value is ToastEvent {
  if (!isRecord(value)) return false;

  return isString(value.message)
    && isString(value.severity)
    && TOAST_SEVERITIES.has(value.severity);
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  if (!isRecord(value)) return false;

  return isString(value.action) && isBoolean(value.active);
}

function isAgentSessionUpdatedEvent(value: unknown): value is AgentSessionUpdatedEvent {
  if (!isRecord(value)) return false;

  return isString(value.paneId) && isNormalizedSession(value.session);
}

function isAgentSessionRemovedEvent(value: unknown): value is AgentSessionRemovedEvent {
  if (!isRecord(value)) return false;

  return isString(value.paneId);
}

function isConversationTopic(value: unknown): value is ConversationTopic {
  if (!isRecord(value)) return false;

  const start = value.messageStartIndex;
  const end = value.messageEndIndex;
  const count = value.messageCount;

  return isString(value.id)
    && isString(value.label)
    && isBoolean(value.refined)
    && isNonNegativeInteger(start)
    && isNonNegativeInteger(end)
    && end >= start
    && isPositiveInteger(count)
    && isOptionalFiniteNumber(value.startTime)
    && isOptionalFiniteNumber(value.endTime);
}

function isPaneTopics(value: unknown): value is PaneTopics {
  if (!isRecord(value)) return false;

  return isString(value.paneId)
    && isString(value.sessionId)
    && isAgentName(value.agent)
    && Array.isArray(value.topics)
    && value.topics.every(isConversationTopic)
    && isFiniteNumber(value.updatedAt);
}

function isPaneTopicsUpdatedEvent(value: unknown): value is { paneId: string; topics: PaneTopics } {
  if (!isRecord(value) || !isString(value.paneId)) return false;

  const topics = value.topics;
  return isPaneTopics(topics) && topics.paneId === value.paneId;
}

function isAgentSessionSearchResult(value: unknown): value is AgentSessionSearchResult {
  if (!isRecord(value)) return false;

  return isString(value.paneId)
    && isString(value.paneSlug)
    && isString(value.messageId)
    && isString(value.messageType)
    && isString(value.snippet)
    && isOptionalString(value.filePath)
    && isOptionalFiniteNumber(value.timestamp);
}

function isProjectFileSearchResult(value: unknown): value is ProjectFileSearchResult {
  if (!isRecord(value)) return false;

  return isString(value.rootPath)
    && isString(value.path)
    && isString(value.filename);
}

function isProjectTextSearchResult(value: unknown): value is ProjectTextSearchResult {
  if (!isRecord(value)) return false;

  return isString(value.rootPath)
    && isString(value.path)
    && isString(value.filename)
    && isFiniteNumber(value.lineNumber)
    && isString(value.lineContent);
}

export function sanitizePaneList(value: unknown): AumxPane[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(isAumxPane);
}

export function sanitizePaneActivitySnapshot(value: unknown): ActivitySnapshot | null {
  if (!isRecord(value) || !isString(value.epochId) || !isNonNegativeInteger(value.revision) || !isRecord(value.panes)) return null;
  const panes: Record<string, PaneActivity> = {};
  for (const [paneId, activity] of Object.entries(value.panes)) {
    if (!isPaneActivity(activity)) return null;
    panes[paneId] = activity;
  }
  return { epochId: value.epochId, panes, revision: value.revision };
}

export function sanitizePaneActivityChangedEvent(value: unknown): PaneActivityChangedEvent | null {
  if (!isRecord(value) || !isString(value.epochId) || !isNonNegativeInteger(value.revision) || !Array.isArray(value.changes)) return null;
  const changes = [];
  for (const change of value.changes) {
    if (!isRecord(change) || !isString(change.paneId) || !isPaneActivity(change.activity)) return null;
    changes.push({ paneId: change.paneId, activity: change.activity });
  }
  if (value.removedPaneIds !== undefined) {
    if (!Array.isArray(value.removedPaneIds) || !value.removedPaneIds.every(isString)) return null;
    return { changes, epochId: value.epochId, removedPaneIds: value.removedPaneIds, revision: value.revision };
  }
  return { epochId: value.epochId, revision: value.revision, changes };
}

function isPaneActivity(value: unknown): value is PaneActivity {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.activityRevision)
    || !isString(value.state) || !PANE_ACTIVITY_STATES.has(value.state)
    || (value.certainty !== 'confirmed' && value.certainty !== 'provisional')
    || !isString(value.origin) || !ACTIVITY_ORIGINS.has(value.origin)
    || !isString(value.liveness) || !LIVENESS.has(value.liveness)
    || !isString(value.adapterHealth) || !ADAPTER_HEALTH.has(value.adapterHealth)
    || !isString(value.paneIncarnationId)
    || !isFiniteNumber(value.sinceWallMs)
    || !Array.isArray(value.openBackgroundWork)) return false;
  if (value.adapterSupport !== undefined && (!isString(value.adapterSupport) || !ADAPTER_SUPPORT.has(value.adapterSupport))) return false;
  if (value.adapterVersion !== undefined && !isString(value.adapterVersion)) return false;
  if (value.adapterCapabilities !== undefined
    && (!Array.isArray(value.adapterCapabilities) || !value.adapterCapabilities.every((capability) => isString(capability) && ADAPTER_CAPABILITIES.has(capability)))) return false;
  if (!isOptionalString(value.sessionId) || !isOptionalString(value.turnId)) return false;
  if (value.waitReason !== undefined && value.waitReason !== 'permission' && value.waitReason !== 'question' && value.waitReason !== 'elicitation') return false;
  return value.openBackgroundWork.every((entity) => isRecord(entity)
    && isString(entity.entityId)
    && (entity.kind === 'subagent' || entity.kind === 'task' || entity.kind === 'cron' || entity.kind === 'shell' || entity.kind === 'mcp' || entity.kind === 'unknown')
    && (entity.mutating === true || entity.mutating === false || entity.mutating === 'unknown')
    && isFiniteNumber(entity.sinceWallMs));
}

export function sanitizeToastEvent(value: unknown): ToastEvent | null {
  return isToastEvent(value) ? value : null;
}

export function sanitizeProgressEvent(value: unknown): ProgressEvent | null {
  return isProgressEvent(value) ? value : null;
}

export function sanitizeAgentSessionUpdatedEvent(value: unknown): AgentSessionUpdatedEvent | null {
  return isAgentSessionUpdatedEvent(value) ? value : null;
}

export function sanitizeAgentSessionRemovedEvent(value: unknown): AgentSessionRemovedEvent | null {
  return isAgentSessionRemovedEvent(value) ? value : null;
}

export function sanitizePaneTopicsList(value: unknown): PaneTopics[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(isPaneTopics);
}

export function sanitizePaneTopicsUpdatedEvent(value: unknown): { paneId: string; topics: PaneTopics } | null {
  return isPaneTopicsUpdatedEvent(value) ? value : null;
}

export function sanitizeNormalizedSession(value: unknown): NormalizedSession | null {
  return isNormalizedSession(value) ? value : null;
}

export function sanitizeAgentSessionSearchResults(value: unknown): AgentSessionSearchResult[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(isAgentSessionSearchResult).slice(0, MAX_VALIDATED_RESULTS);
}

export function sanitizeProjectFileSearchResults(value: unknown): ProjectFileSearchResult[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(isProjectFileSearchResult).slice(0, MAX_VALIDATED_RESULTS);
}

export function sanitizeProjectTextSearchResults(value: unknown): ProjectTextSearchResult[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(isProjectTextSearchResult).slice(0, MAX_VALIDATED_RESULTS);
}

export function sanitizeFileListResponse(value: unknown): FileListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }

  return {
    entries: value.entries.filter(isFileEntry),
    error: isString(value.error) ? value.error : undefined,
  };
}

export function sanitizeFileReadResponse(value: unknown): FileReadResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.kind) {
    case 'editable-text':
      if (
        !isString(value.content)
        || !isString(value.contentVersion)
        || value.encoding !== 'utf8'
        || !isBoolean(value.hasBom)
        || (value.eol !== 'lf' && value.eol !== 'crlf' && value.eol !== 'cr')
      ) return null;
      return {
        kind: value.kind,
        content: value.content,
        contentVersion: value.contentVersion,
        encoding: value.encoding,
        hasBom: value.hasBom,
        eol: value.eol,
      };
    case 'readonly-text':
      if (
        (value.reason !== 'truncated' && value.reason !== 'mixed-eol')
        || !isString(value.content)
        || value.encoding !== 'utf8'
        || !isBoolean(value.hasBom)
        || !isNonNegativeInteger(value.sizeBytes)
      ) return null;
      return {
        kind: value.kind,
        reason: value.reason,
        content: value.content,
        encoding: value.encoding,
        hasBom: value.hasBom,
        sizeBytes: value.sizeBytes,
      };
    case 'unsupported':
      if (
        (value.reason !== 'binary' && value.reason !== 'invalid-utf8')
        || !isNonNegativeInteger(value.sizeBytes)
      ) return null;
      return { kind: value.kind, reason: value.reason, sizeBytes: value.sizeBytes };
    case 'error':
      if (
        (value.code !== 'NOT_FOUND' && value.code !== 'NOT_AUTHORIZED' && value.code !== 'IO_ERROR')
        || !isString(value.message)
      ) return null;
      return { kind: value.kind, code: value.code, message: value.message };
    default:
      return null;
  }
}

export function sanitizeFileWriteResponse(value: unknown): FileWriteResponse | null {
  if (
    !isRecord(value)
    || !isBoolean(value.success)
    || !isString(value.editorSessionId)
    || !isNonNegativeInteger(value.saveSequence)
    || !isNonNegativeInteger(value.documentVersion)
  ) return null;

  const identity = {
    documentVersion: value.documentVersion,
    editorSessionId: value.editorSessionId,
    saveSequence: value.saveSequence,
  };
  if (value.success) {
    if (!isString(value.contentVersion)) return null;
    return { ...identity, success: true, contentVersion: value.contentVersion };
  }
  if (!isString(value.error)) return null;
  return {
    ...identity,
    success: false,
    conflict: isBoolean(value.conflict) ? value.conflict : undefined,
    conflictType: value.conflictType === 'deleted' || value.conflictType === 'modified'
      ? value.conflictType
      : undefined,
    currentContentVersion: isString(value.currentContentVersion)
      ? value.currentContentVersion
      : undefined,
    error: value.error,
  };
}

export function sanitizeFormatDocumentResponse(value: unknown): FormatDocumentResponse | null {
  if (
    !isRecord(value)
    || !isBoolean(value.success)
    || !isNonNegativeInteger(value.documentVersion)
    || !isString(value.editorSessionId)
    || !isString(value.fileKey)
    || !isString(value.requestId)
  ) return null;
  const identity = {
    documentVersion: value.documentVersion,
    editorSessionId: value.editorSessionId,
    fileKey: value.fileKey,
    requestId: value.requestId,
  };
  if (!value.success) {
    const codes = new Set(['CANCELLED', 'SUPERSEDED', 'TIMEOUT', 'CRASHED', 'INVALID_RESPONSE', 'FORMAT_ERROR']);
    if (!isString(value.code) || !codes.has(value.code) || !isString(value.error)) return null;
    return {
      ...identity,
      success: false,
      code: value.code as Extract<FormatDocumentResponse, { success: false }>['code'],
      error: value.error,
    };
  }
  if (
    (value.status !== 'formatted' && value.status !== 'ignored' && value.status !== 'unchanged')
    || !Array.isArray(value.changes)
    || value.changes.length > 10_000
  ) return null;
  let previousTo = 0;
  const changes = [];
  for (const candidate of value.changes) {
    if (
      !isRecord(candidate)
      || !isNonNegativeInteger(candidate.from)
      || !isNonNegativeInteger(candidate.to)
      || candidate.from < previousTo
      || candidate.to < candidate.from
      || !isString(candidate.insert)
    ) return null;
    changes.push({ from: candidate.from, to: candidate.to, insert: candidate.insert });
    previousTo = candidate.to;
  }
  return { ...identity, success: true, status: value.status, changes };
}

export function sanitizeFileReadBinaryResponse(value: unknown): FileReadBinaryResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isString(value.data) || !isString(value.mimeType)) {
    return null;
  }

  return {
    data: value.data,
    mimeType: value.mimeType,
    error: isString(value.error) ? value.error : undefined,
  };
}

export function sanitizeFileMutationResponse(value: unknown): FileMutationResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isBoolean(value.success)) {
    return null;
  }

  return {
    success: value.success,
    conflict: isBoolean(value.conflict) ? value.conflict : undefined,
    conflictType: value.conflictType === 'deleted' || value.conflictType === 'modified'
      ? value.conflictType
      : undefined,
    currentMtimeMs: isFiniteNumber(value.currentMtimeMs) ? value.currentMtimeMs : undefined,
    error: isString(value.error) ? value.error : undefined,
    mtimeMs: isFiniteNumber(value.mtimeMs) ? value.mtimeMs : undefined,
  };
}

function isFileMoveErrorCode(value: unknown): value is FileMoveErrorCode {
  return isString(value) && FILE_MOVE_ERROR_CODES.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function validateFileMoveItem(value: unknown): FileMoveItemResult | null {
  if (!isRecord(value) || !isNonEmptyString(value.sourcePath)) {
    return null;
  }

  const sourcePath = value.sourcePath;
  const described = isFileMoveErrorCode(value.code) && isNonEmptyString(value.error)
    ? { code: value.code, error: value.error }
    : null;

  if (value.status === 'succeeded' && isNonEmptyString(value.finalPath)) {
    return { finalPath: value.finalPath, sourcePath, status: 'succeeded' };
  }
  if (value.status === 'partial' && isNonEmptyString(value.finalPath) && described) {
    return { ...described, finalPath: value.finalPath, sourcePath, status: 'partial' };
  }
  if (value.status === 'failed' && described) {
    return { ...described, sourcePath, status: 'failed' };
  }
  return null;
}

/**
 * Unlike every read validator here, a move response is never sanitized item-by-item: the filesystem
 * has already changed by the time it arrives, so dropping a malformed entry would silently skip the
 * remap for a file that really did move. The whole set is accepted or rejected.
 *
 * The two shapes are mutually exclusive, and mixing them is rejected rather than reconciled: a
 * response carrying both results and a top-level error would report a filesystem that did change
 * while `applyMoveResponse` declined to remap anything for it.
 */
export function validateFileMoveResponse(
  value: unknown,
  expectedSourcePaths: readonly string[],
): FileMoveResponse | null {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return null;
  }

  // Rejected: nothing was applied, and it says why.
  if (value.code !== undefined || value.error !== undefined) {
    const code = isFileMoveErrorCode(value.code) ? value.code : undefined;
    const error = isNonEmptyString(value.error) ? value.error : undefined;
    return code && error && value.results.length === 0 ? { code, error, results: [] } : null;
  }

  // Applied: exactly one well-formed result per expected source, and no top-level verdict.
  const results: FileMoveItemResult[] = [];
  const seen = new Set<string>();
  for (const item of value.results) {
    const result = validateFileMoveItem(item);
    if (!result || seen.has(result.sourcePath)) {
      return null;
    }
    seen.add(result.sourcePath);
    results.push(result);
  }

  if (seen.size !== expectedSourcePaths.length || expectedSourcePaths.some((path) => !seen.has(path))) {
    return null;
  }

  return { results };
}

export function warnInvalidPayload(scope: string, payload: unknown): void {
  rendererLog.warn(`renderer:${scope}`, 'Invalid payload', { payload });
}

export function warnDroppedItems(scope: string, received: number, kept: number): void {
  rendererLog.warn(`renderer:${scope}`, 'Dropped invalid items', { kept, received });
}
