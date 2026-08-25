import { once } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigWatcher } from '../../src/services/ConfigWatcher.js';
import { atomicWriteJsonSync } from '../../src/utils/atomicWrite.js';

describe('ConfigWatcher', () => {
  let fixtureRoot: string | undefined;
  let watcher: ConfigWatcher | undefined;

  afterEach(async () => {
    await watcher?.stop();
    if (fixtureRoot) rmSync(fixtureRoot, { force: true, recursive: true });
  });

  it('continues emitting after repeated atomic config replacements', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'muxbase-config-watcher-'));
    const configPath = join(fixtureRoot, 'muxbase.config.json');
    writeFileSync(configPath, JSON.stringify({ panes: [] }), 'utf8');
    watcher = new ConfigWatcher(configPath);
    await watcher.start();

    for (let revision = 1; revision <= 12; revision += 1) {
      const changed = once(watcher, 'change');
      atomicWriteJsonSync(configPath, {
        panes: [{
          id: `pane-${revision}`,
          paneId: `%${revision}`,
          prompt: `revision ${revision}`,
          slug: `pane-${revision}`,
        }],
      });
      const [config] = await Promise.race([
        changed,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`config revision ${revision} was not observed`)), 2_000);
        }),
      ]);
      expect(config).toEqual({
        panes: [{
          id: `pane-${revision}`,
          paneId: `%${revision}`,
          prompt: `revision ${revision}`,
          slug: `pane-${revision}`,
        }],
      });
    }
  }, 30_000);

  it('ignores malformed replacements and continues from the last valid config', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'muxbase-config-watcher-'));
    const configPath = join(fixtureRoot, 'muxbase.config.json');
    watcher = new ConfigWatcher(configPath);
    const changes = vi.fn();
    watcher.on('change', changes);
    const handleFileChange = (watcher as unknown as {
      handleFileChange: (path: string) => Promise<void>;
    }).handleFileChange.bind(watcher);

    writeFileSync(configPath, JSON.stringify({ panes: [] }), 'utf8');
    await handleFileChange(configPath);
    expect(changes).toHaveBeenCalledOnce();

    writeFileSync(configPath, JSON.stringify({ panes: [{ id: 'broken' }] }), 'utf8');
    await handleFileChange(configPath);
    expect(changes).toHaveBeenCalledOnce();

    const recovered = {
      panes: [{ id: 'recovered', paneId: '%2', prompt: 'recover', slug: 'recovered' }],
    };
    writeFileSync(configPath, JSON.stringify(recovered), 'utf8');
    await handleFileChange(configPath);
    expect(changes).toHaveBeenLastCalledWith(recovered);
    expect(changes).toHaveBeenCalledTimes(2);
  });
});
