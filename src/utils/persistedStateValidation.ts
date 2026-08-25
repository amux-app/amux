import type { MuxBaseConfig, MuxBasePane, MuxBaseSettings } from '../types.js';
import { isAgentName } from '../agents/agent-contract.js';
import { isGitObjectId } from './git.js';
import { CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY, isSettingKey, validateSettingValue } from './settingsSchema.js';

export { CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY } from './settingsSchema.js';

export type MuxBaseStoredSettings = MuxBaseSettings & {
  [CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY]?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function oneOf(...allowed: readonly string[]): (value: unknown) => boolean {
  const values = new Set(allowed);
  return (value: unknown) => typeof value === 'string' && values.has(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid config.${key}: expected a string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid config.${key}: expected a finite number`);
  }
  return value;
}

function requirePaneString(pane: Record<string, unknown>, index: number, key: string): void {
  if (typeof pane[key] !== 'string' || pane[key].length === 0) {
    throw new Error(`Invalid config.panes[${index}].${key}: expected a non-empty string`);
  }
}

function validateOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    throw new Error(`Invalid ${path}.${key}: expected a string`);
  }
}

function validateOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`Invalid ${path}.${key}: expected a finite number`);
  }
}

function validateReview(value: unknown, index: number): void {
  const path = `config.panes[${index}].review`;
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected an object`);
  for (const key of ['reviewId', 'sourcePaneId', 'sourceSlug']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Invalid ${path}.${key}: expected a non-empty string`);
    }
  }
  validateOptionalString(value, 'sourceWorktreePath', path);
  if (!isNonNegativeInteger(value.changedFiles)) {
    throw new Error(`Invalid ${path}.changedFiles: expected a non-negative integer`);
  }
  validateOptionalFiniteNumber(value, 'startedAt', path);
  if (value.startedAt === undefined) {
    throw new Error(`Invalid ${path}.startedAt: expected a finite number`);
  }
  validateOptionalFiniteNumber(value, 'handedOffAt', path);
  if (value.snapshotSha !== undefined && !isGitObjectId(value.snapshotSha)) {
    throw new Error(`Invalid ${path}.snapshotSha: expected a git object id`);
  }
}

function validateDuel(value: unknown, index: number): void {
  const path = `config.panes[${index}].duel`;
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected an object`);
  if (typeof value.groupId !== 'string' || value.groupId.length === 0) {
    throw new Error(`Invalid ${path}.groupId: expected a non-empty string`);
  }
  if (!oneOf('a', 'b')(value.role)) {
    throw new Error(`Invalid ${path}.role`);
  }
  if (typeof value.prompt !== 'string') {
    throw new Error(`Invalid ${path}.prompt: expected a string`);
  }
  validateOptionalString(value, 'siblingPaneId', path);
}

function validateConflictMerge(value: unknown, index: number): void {
  const path = `config.panes[${index}].conflictMerge`;
  if (!isRecord(value)) throw new Error(`Invalid ${path}: expected an object`);
  for (const key of [
    'transactionId',
    'repoPath',
    'sourcePaneId',
    'conflictPaneId',
    'sourceBranch',
    'targetBranch',
    'sourceCommit',
    'targetCommit',
  ]) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Invalid ${path}.${key}: expected a non-empty string`);
    }
  }
  validateOptionalString(value, 'mainRepoPath', path);
}

function validatePane(value: unknown, index: number): asserts value is MuxBasePane {
  if (!isRecord(value)) throw new Error(`Invalid config.panes[${index}]: expected an object`);
  const path = `config.panes[${index}]`;
  for (const key of ['id', 'paneId', 'slug']) requirePaneString(value, index, key);
  if (typeof value.prompt !== 'string') {
    throw new Error(`Invalid config.panes[${index}].prompt: expected a string`);
  }

  for (const key of [
    'agentSessionId',
    'branchName',
    'devUrl',
    'devWindowId',
    'effort',
    'model',
    'optionsQuestion',
    'projectName',
    'projectRoot',
    'shellType',
    'sourceBacklogId',
    'terminalTranscriptPath',
    'testOutput',
    'testWindowId',
    'title',
    'worktreePath',
  ]) {
    validateOptionalString(value, key, path);
  }

  if (value.agent !== undefined && !isAgentName(value.agent)) {
    throw new Error(`Invalid config.panes[${index}].agent`);
  }
  if (value.agentStatus !== undefined
      && !oneOf('idle', 'analyzing', 'waiting', 'working')(value.agentStatus)) {
    throw new Error(`Invalid config.panes[${index}].agentStatus`);
  }
  if (value.type !== undefined && !oneOf('worktree', 'shell')(value.type)) {
    throw new Error(`Invalid config.panes[${index}].type`);
  }
  if (value.testStatus !== undefined && !oneOf('failed', 'passed', 'running')(value.testStatus)) {
    throw new Error(`Invalid ${path}.testStatus`);
  }
  if (value.devStatus !== undefined && !oneOf('running', 'stopped')(value.devStatus)) {
    throw new Error(`Invalid ${path}.devStatus`);
  }
  if (value.claudeRenderer !== undefined
      && !oneOf('fullscreen', 'classic')(value.claudeRenderer)) {
    throw new Error(`Invalid config.panes[${index}].claudeRenderer`);
  }
  if (value.titleLocked !== undefined && typeof value.titleLocked !== 'boolean') {
    throw new Error(`Invalid config.panes[${index}].titleLocked`);
  }
  if (value.startedWithoutInitialPrompt !== undefined
      && typeof value.startedWithoutInitialPrompt !== 'boolean') {
    throw new Error(`Invalid config.panes[${index}].startedWithoutInitialPrompt`);
  }
  validateOptionalFiniteNumber(value, 'lastAgentCheck', path);
  if (value.lastDeterministicStatus !== undefined
      && !oneOf('ambiguous', 'working')(value.lastDeterministicStatus)) {
    throw new Error(`Invalid ${path}.lastDeterministicStatus`);
  }
  if (value.terminalFixedCols !== undefined
      && (!isNonNegativeInteger(value.terminalFixedCols) || value.terminalFixedCols === 0)) {
    throw new Error(`Invalid config.panes[${index}].terminalFixedCols`);
  }
  if (value.role !== undefined && value.role !== 'review') {
    throw new Error(`Invalid ${path}.role`);
  }
  if (value.review !== undefined) validateReview(value.review, index);
  if (value.conflictMerge !== undefined) validateConflictMerge(value.conflictMerge, index);
  if (value.duel !== undefined) validateDuel(value.duel, index);
}

export function parseMuxBaseStoredSettings(value: unknown): MuxBaseStoredSettings {
  if (!isRecord(value)) throw new Error('Invalid settings: expected a JSON object');

  for (const [key, settingValue] of Object.entries(value)) {
    if (key === CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY) {
      if (!validateSettingValue(key, settingValue)) throw new Error(`Invalid settings.${key}: unexpected value`);
      continue;
    }
    if (!isSettingKey(key)) continue;
    if (!validateSettingValue(key, settingValue)) throw new Error(`Invalid settings.${key}: unexpected value`);
  }

  return { ...value } as MuxBaseStoredSettings;
}

export function parseMuxBaseConfig(value: unknown): MuxBaseConfig {
  if (!isRecord(value)) throw new Error('Invalid config: expected a JSON object');
  if (!Array.isArray(value.panes)) throw new Error('Invalid config.panes: expected an array');
  value.panes.forEach(validatePane);

  const controlPaneId = optionalString(value, 'controlPaneId');
  const controlPaneSize = optionalNumber(value, 'controlPaneSize');
  const welcomePaneId = optionalString(value, 'welcomePaneId');
  if (controlPaneSize !== undefined
      && (!Number.isInteger(controlPaneSize) || controlPaneSize <= 0)) {
    throw new Error('Invalid config.controlPaneSize: expected a positive integer');
  }

  return {
    ...value,
    lastUpdated: optionalString(value, 'lastUpdated') ?? '',
    panes: value.panes,
    projectName: optionalString(value, 'projectName') ?? '',
    projectRoot: optionalString(value, 'projectRoot') ?? '',
    settings: value.settings === undefined ? {} : parseMuxBaseStoredSettings(value.settings),
    ...(controlPaneId === undefined ? {} : { controlPaneId }),
    ...(controlPaneSize === undefined ? {} : { controlPaneSize }),
    ...(welcomePaneId === undefined ? {} : { welcomePaneId }),
  };
}
