import { appendFile, appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneActivityJournalReader, type JournalRead } from '../../src/main/services/PaneActivityJournalReader';

const directories: string[] = [];
const readers: PaneActivityJournalReader[] = [];
const eventsFrom = (read: JournalRead) => read.batches.flatMap((batch) => batch.events);
const createReader = () => {
  const reader = new PaneActivityJournalReader();
  readers.push(reader);
  return reader;
};

afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.dispose()));
  for (const directory of directories.splice(0)) {
    // Vitest owns this temporary directory; it contains no project data.
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('PaneActivityJournalReader', () => {
  it('reads complete bounded records once and marks the first read as replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    writeFileSync(path, `${JSON.stringify({
      eventId: 'event-1', kind: 'turn_started', origin: 'adapter', paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1', sessionId: 'session-1', turnId: 'turn-1', emittedAt: 1,
    })}\nnot-json\n`);
    const reader = createReader();

    const first = await reader.read(path, 100);
    const second = await reader.read(path, 200);

    expect(first.batches).toEqual([{
      events: [expect.objectContaining({ eventId: 'event-1', receivedAt: 100 })],
      replay: true,
    }]);
    expect(second).toEqual({ batches: [] });
  });

  it('waits for an incomplete trailing record so concurrent writers cannot produce a partial event', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    writeFileSync(path, '{"eventId":"partial"');
    const reader = createReader();

    expect(eventsFrom(await reader.read(path, 100))).toEqual([]);
  });

  it('treats a journal created after an absent-path check as live evidence, not restart replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const reader = createReader();
    await reader.read(path, 100);
    writeFileSync(path, `${JSON.stringify({
      eventId: 'event-1', kind: 'turn_started', origin: 'adapter', paneId: 'pane-1', paneIncarnationId: 'incarnation-1',
    })}\n`);

    const read = await reader.read(path, 200);

    expect(read.batches).toEqual([{ events: [expect.objectContaining({ eventId: 'event-1' })], replay: false }]);
  });

  it('marks a pre-existing fresh-pane journal as live when registration races the first read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    writeFileSync(path, `${JSON.stringify({
      eventId: 'event-1', kind: 'turn_started', origin: 'adapter', paneId: 'pane-1', paneIncarnationId: 'incarnation-1',
    })}\n`);
    const reader = createReader();
    reader.markLive(path);

    expect((await reader.read(path, 100)).batches[0]?.replay).toBe(false);
  });

  it('drains concurrent bounded writers across rotation without loss, duplication, or interleaving', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-stress-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const reader = createReader();
    await reader.read(path, 0);

    const records = Array.from({ length: 1_000 }, (_, index) => `${JSON.stringify({
      eventId: `event-${index}`,
      kind: 'turn_started',
      origin: 'adapter',
      paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1',
      sessionId: 'session-1',
      turnId: `turn-${index}`,
    })}\n`);
    const chunks = Array.from({ length: 4 }, (_, writer) => records.filter((_, index) => index % 4 === writer).join(''));
    await Promise.all(chunks.map((chunk) => new Promise<void>((resolve, reject) => {
      appendFile(path, chunk, (error) => error ? reject(error) : resolve());
    })));

    const first = await reader.read(path, 100);
    const firstEvents = eventsFrom(first);
    expect(firstEvents).toHaveLength(1_000);
    expect(new Set(firstEvents.map((event) => event.eventId)).size).toBe(1_000);

    renameSync(path, `${path}.rotated`);
    appendFileSync(path, `${JSON.stringify({
      eventId: 'event-after-rotation',
      kind: 'turn_started',
      origin: 'adapter',
      paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1',
      sessionId: 'session-1',
      turnId: 'turn-after-rotation',
    })}\n`);
    const second = await reader.read(path, 200);
    expect(eventsFrom(second).map((event) => event.eventId)).toEqual(['event-after-rotation']);
    expect(eventsFrom(await reader.read(path, 300))).toEqual([]);
  });

  it('finishes a bounded old inode before switching to its rotated replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-rotation-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const reader = createReader();
    await reader.read(path, 0);
    const record = (index: number) => `${JSON.stringify({
      eventId: `event-${index}`, kind: 'turn_started', origin: 'adapter', paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1', sessionId: 'session-1', turnId: `turn-${index}`,
    })}\n`;
    writeFileSync(path, Array.from({ length: 5_000 }, (_unused, index) => record(index)).join(''));

    const collected = eventsFrom(await reader.read(path, 100));
    renameSync(path, `${path}.rotated`);
    writeFileSync(path, record(9_999));
    for (let pass = 0; pass < 8 && !collected.some((event) => event.eventId === 'event-9999'); pass += 1) {
      collected.push(...eventsFrom(await reader.read(path, 200 + pass)));
    }
    expect(collected).toHaveLength(5_001);
    expect(new Set(collected.map((event) => event.eventId)).size).toBe(5_001);
    expect(collected.at(-1)?.eventId).toBe('event-9999');
  });

  it('rejects malformed and oversized records while preserving the next valid line', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-invalid-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const reader = createReader();
    const valid = JSON.stringify({
      eventId: 'valid', kind: 'turn_started', origin: 'adapter', paneId: 'pane-1', paneIncarnationId: 'incarnation-1',
    });
    writeFileSync(path, `${'x'.repeat(8_000)}\nnot-json\n${valid}\n`);

    const result = await reader.read(path, 100);
    expect(eventsFrom(result).map((event) => event.eventId)).toEqual(['valid']);
  });
});

describe('PaneActivityJournalReader — replay watermark', () => {
  it('keeps a journal larger than one bounded read in replay until its history is drained', async () => {
    // Arrange — a pre-existing journal well past the per-read byte cap
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const record = (index: number) => `${JSON.stringify({
      eventId: `event-${index}`, kind: 'turn_started', origin: 'adapter', paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1', sessionId: 'session-1', turnId: 'turn-1', emittedAt: index,
    })}\n`;
    writeFileSync(path, Array.from({ length: 3_000 }, (_unused, index) => record(index)).join(''));
    const reader = createReader();

    // Act — drain the history, then append one genuinely new record
    const passes: Array<{ events: number; replay: boolean }> = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const read = await reader.read(path, 100 + pass);
      passes.push(...read.batches.map((batch) => ({ events: batch.events.length, replay: batch.replay })));
      if (eventsFrom(read).length === 0) break;
    }
    appendFileSync(path, record(9_999));
    const live = await reader.read(path, 500);
    // Assert — every historical byte is replay; only what arrived after is live
    expect(passes.length).toBeGreaterThan(2);
    expect(passes.filter((pass) => pass.events > 0).every((pass) => pass.replay)).toBe(true);
    expect(live.batches).toEqual([{ events: [expect.objectContaining({ eventId: 'event-9999' })], replay: false }]);
  });

  it('keeps a record appended during replay live when the next read crosses the watermark', async () => {
    // Arrange — leave enough history for a second bounded read.
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-activity-journal-'));
    directories.push(directory);
    const path = join(directory, 'activity.ndjson');
    const record = (index: number) => `${JSON.stringify({
      eventId: `event-${index}`, kind: 'turn_started', origin: 'adapter', paneId: 'pane-1',
      paneIncarnationId: 'incarnation-1', sessionId: 'session-1', turnId: 'turn-1', emittedAt: index,
    })}\n`;
    writeFileSync(path, Array.from({ length: 2_000 }, (_unused, index) => record(index)).join(''));
    const reader = createReader();
    await reader.read(path, 100);

    // Act — append live evidence before the historical tail has drained.
    appendFileSync(path, record(9_999));
    const crossingRead = await reader.read(path, 200);
    // Assert — one read can carry both provenances without conflating them.
    const replayBatch = crossingRead.batches.find((batch) => batch.replay);
    const liveBatch = crossingRead.batches.find((batch) => !batch.replay);
    expect(replayBatch?.events.some((event) => event.eventId === 'event-9999')).toBe(false);
    expect(liveBatch?.events.map((event) => event.eventId)).toEqual(['event-9999']);
  });
});
