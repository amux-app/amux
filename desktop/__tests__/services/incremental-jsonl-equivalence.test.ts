import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_SETTLED_FIXTURE_LINES,
  CODEX_SETTLED_FIXTURE_LINES,
  CODEX_UNSETTLED_FIXTURE_LINES,
  boundaryClassOffsets,
  claudeScenario,
  codexScenario,
  midRecordOffsets,
  newlineOffsets,
  randomOffsets,
  type IncrementalScenario,
} from './incremental-jsonl-harness';

const BOUNDARY_WALK_STRIDE = 8;
const BOUNDARY_WALK_TIMEOUT_MS = 30_000;
const RANDOM_SCHEDULES = 12;
const RANDOM_SPLITS_PER_SCHEDULE = 9;
const tempDirs: string[] = [];

function createTempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, 'session.jsonl');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const scenarios: IncrementalScenario[] = [
  claudeScenario(),
  claudeScenario(CLAUDE_SETTLED_FIXTURE_LINES, 'claude settled turn'),
  codexScenario(),
  codexScenario(CODEX_SETTLED_FIXTURE_LINES, 'codex settled turn'),
  codexScenario(CODEX_UNSETTLED_FIXTURE_LINES, 'codex unsettled turn'),
];

describe('incremental parse at every boundary class', () => {
  it.each(scenarios)(
    '$name matches a full parse when split at every decision offset',
    async (scenario) => {
      // Arrange
      const incrementalPath = createTempFile('muxbase-incr-boundary-');
      const fullPath = createTempFile('muxbase-full-boundary-');
      const offsets = boundaryClassOffsets(scenario.content, BOUNDARY_WALK_STRIDE);

      // Act
      const incremental = await scenario.feed(incrementalPath, offsets);
      const full = await scenario.parseFull(fullPath);

      // Assert
      expect(incremental).toEqual(full);
    },
    BOUNDARY_WALK_TIMEOUT_MS,
  );
});

describe('incremental parse equivalence', () => {
  it.each(scenarios)(
    '$name matches a full parse across newline and mid-record splits',
    async (scenario) => {
      // Arrange
      const fullPath = createTempFile('muxbase-full-split-');
      const full = await scenario.parseFull(fullPath);
      const schedules = [newlineOffsets(scenario.content), midRecordOffsets(scenario.content)];

      // Act + Assert
      for (const [index, offsets] of schedules.entries()) {
        const incrementalPath = createTempFile(`muxbase-incr-split-${index}-`);
        expect(await scenario.feed(incrementalPath, offsets), `schedule ${index}`).toEqual(full);
      }
    },
  );

  it.each(scenarios)(
    '$name matches a full parse for every randomized split schedule',
    async (scenario) => {
      // Arrange
      const fullPath = createTempFile('muxbase-full-random-');
      const full = await scenario.parseFull(fullPath);

      // Act + Assert
      for (let seed = 1; seed <= RANDOM_SCHEDULES; seed++) {
        const offsets = randomOffsets(scenario.content, seed, RANDOM_SPLITS_PER_SCHEDULE);
        const incrementalPath = createTempFile(`muxbase-incr-random-${seed}-`);
        expect(await scenario.feed(incrementalPath, offsets), `seed ${seed}`).toEqual(full);
      }
    },
  );
});

describe('claude incremental parse content', () => {
  it('carries every cross-line accumulator into the session', async () => {
    // Arrange
    const scenario = claudeScenario();
    const filePath = createTempFile('muxbase-incr-content-');

    // Act
    const session = await scenario.feed(filePath, midRecordOffsets(scenario.content));

    // Assert
    expect(session.messages.map((message) => message.id)).toEqual([
      'claude-0', 'claude-1', 'claude-2', 'claude-3', 'claude-4', 'claude-5', 'claude-6',
    ]);
    expect(session.metrics.totalTokens).toBe(53_949);
    expect(session.metrics.toolCallCount).toBe(2);
    expect(session.subagents[0]?.messages).toHaveLength(2);
    expect(session.subagents[0]?.description).toBe('inspect the parsers');
    expect(session.compactionEvents).toHaveLength(1);
    expect(session.title).toBe('✳ Incremental  Parser Work');
    expect(session.aiTitle).toBe('Incremental Parser Work');
    expect(session.modelId).toBe('claude-opus-4-7');
    expect(session.awaitingUserInput).toBe(true);
    expect(session.pendingUserQuestion).toBe('Which approach?');
    expect(session.turnCompleted).toBe(false);
  });
});

describe('turn completion carried across chunks', () => {
  it('keeps a settled turn settled when only trailing non-message records arrive', async () => {
    // Arrange
    const claude = claudeScenario(CLAUDE_SETTLED_FIXTURE_LINES);
    const codex = codexScenario(CODEX_SETTLED_FIXTURE_LINES);

    // Act
    const claudeSession = await claude.feed(createTempFile('muxbase-settled-claude-'), newlineOffsets(claude.content));
    const codexSession = await codex.feed(createTempFile('muxbase-settled-codex-'), newlineOffsets(codex.content));

    // Assert
    expect(claudeSession.turnCompleted).toBe(true);
    expect(codexSession.turnCompleted).toBe(true);
  });

  it('keeps a turn unsettled when a message followed the completion event', async () => {
    // Arrange
    const codex = codexScenario(CODEX_UNSETTLED_FIXTURE_LINES);

    // Act
    const session = await codex.feed(createTempFile('muxbase-unsettled-codex-'), newlineOffsets(codex.content));

    // Assert
    expect(session.turnCompleted).toBe(false);
    expect(session.isOngoing).toBe(true);
  });
});

describe('codex incremental parse content', () => {
  it('carries every cross-line accumulator into the session', async () => {
    // Arrange
    const scenario = codexScenario();
    const filePath = createTempFile('muxbase-incr-codex-content-');

    // Act
    const session = await scenario.feed(filePath, midRecordOffsets(scenario.content));

    // Assert
    expect(session.sessionId).toBe('codex-session-42');
    expect(session.messages.map((message) => message.id)).toEqual([
      'codex-0', 'codex-2', 'codex-3', 'codex-4', 'codex-5', 'codex-6',
    ]);
    expect(session.metrics.totalTokens).toBe(5_010);
    expect(session.metrics.inputTokens).toBe(4_207);
    expect(session.metrics.toolCallCount).toBe(2);
    expect(session.modelId).toBe('gpt-5-codex');
    expect(session.awaitingUserInput).toBe(true);
    expect(session.pendingUserQuestion).toBe('Which model?');
    expect(session.turnCompleted).toBe(false);
  });
});
