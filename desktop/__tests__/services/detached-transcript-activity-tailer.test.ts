import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DetachedTranscriptActivityTailer } from '../../src/main/services/DetachedTranscriptActivityTailer';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('DetachedTranscriptActivityTailer', () => {
  it('starts at EOF and emits only appended transcript bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-detached-tail-'));
    directories.push(directory);
    const path = join(directory, 'pane.ansi');
    writeFileSync(path, 'old Esc to interrupt\n');
    const tailer = new DetachedTranscriptActivityTailer();

    await tailer.sync([{ id: 'pane-1', agent: 'codex', terminalTranscriptPath: path }]);
    expect(await tailer.readNewData()).toEqual([]);

    appendFileSync(path, 'fresh Esc to interrupt\n');
    expect(await tailer.readNewData()).toEqual([{ paneId: 'pane-1', data: 'fresh Esc to interrupt\n' }]);
  });

  it('handles truncation and atomic path replacement without replaying old bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'muxbase-detached-tail-'));
    directories.push(directory);
    const path = join(directory, 'pane.ansi');
    writeFileSync(path, 'initial');
    const tailer = new DetachedTranscriptActivityTailer();

    await tailer.sync([{ id: 'pane-1', agent: 'codex', terminalTranscriptPath: path }]);
    appendFileSync(path, ' before-truncate');
    expect((await tailer.readNewData())[0]?.data).toBe(' before-truncate');

    writeFileSync(path, 'replacement-start');
    appendFileSync(path, ' replacement-live');
    expect((await tailer.readNewData())[0]?.data).toBe('replacement-start replacement-live');

    const rotated = `${path}.rotated`;
    renameSync(path, rotated);
    writeFileSync(path, 'new-file-old-content');
    expect(await tailer.readNewData()).toEqual([]);
    appendFileSync(path, ' new-file-live');
    expect((await tailer.readNewData())[0]?.data).toBe(' new-file-live');
  });
});
