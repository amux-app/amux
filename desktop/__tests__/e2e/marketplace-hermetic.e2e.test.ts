import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type {
  MarketplaceBrowseResponse,
  MarketplaceInstallResponse,
  MarketplacePreviewResponse,
  MarketplaceUninstallResponse,
} from '../../src/shared/ipc-types';
import { closeElectronApp, getAppWindow, waitForAppReady } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const SOURCE_URL = 'https://example.invalid/muxbase-hermetic-marketplace.git';
const PLUGIN_ID = 'hermetic-plugin';
const SKILL_NAME = 'hermetic-skill';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

interface E2EWindow {
  muxbase: {
    invoke: <T>(channel: string, request?: unknown) => Promise<T>;
  };
}

function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    ({ ipcChannel, payload }) => (window as unknown as E2EWindow).muxbase.invoke<T>(ipcChannel, payload),
    { ipcChannel: channel, payload: request },
  );
}

describe.runIf(process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_FAKE_AGENTS === '1')(
  'Hermetic marketplace feature E2E',
  () => {
    let app: ElectronApplication;
    let page: Page;
    let testRoot = '';
    let isolatedHome = '';

    beforeAll(async () => {
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
      isolatedHome = realpathSync(process.env.HOME ?? '');
      expect(isolatedHome).toContain('muxbase-home-e2e-');

      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-marketplace-feature-')));
      const sourceClone = join(testRoot, 'source');
      const userData = join(isolatedHome, 'user-data');
      const pluginRoot = join(sourceClone, 'plugins', PLUGIN_ID);
      mkdirSync(join(sourceClone, '.claude-plugin'), { recursive: true });
      mkdirSync(join(pluginRoot, 'skills', SKILL_NAME), { recursive: true });
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(sourceClone, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'muxbase-hermetic',
        plugins: [{ name: PLUGIN_ID, source: `./plugins/${PLUGIN_ID}`, version: '1.0.0' }],
      }, null, 2));
      writeFileSync(
        join(pluginRoot, 'skills', SKILL_NAME, 'SKILL.md'),
        '# Hermetic marketplace skill\n',
      );
      writeFileSync(join(sourceClone, 'AGENTS.md'), '# Shared marketplace instructions\n');
      symlinkSync('AGENTS.md', join(sourceClone, 'CLAUDE.md'));
      execFileSync('git', ['init'], { cwd: sourceClone, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'e2e@muxbase.test'], { cwd: sourceClone });
      execFileSync('git', ['config', 'user.name', 'MuxBase E2E'], { cwd: sourceClone });
      execFileSync('git', ['add', '.'], { cwd: sourceClone });
      execFileSync('git', ['commit', '-m', 'test: hermetic marketplace fixture'], {
        cwd: sourceClone,
        stdio: 'ignore',
      });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceClone,
        encoding: 'utf8',
      }).trim();
      writeFileSync(join(userData, 'marketplace-registry.json'), JSON.stringify({
        version: 1,
        installed: [],
        sources: [{
          clonePath: sourceClone,
          detectedFormat: 'claude-marketplace',
          headSha,
          lastUpdated: new Date(0).toISOString(),
          name: 'muxbase-hermetic',
          url: SOURCE_URL,
        }],
      }, null, 2));

      app = await electron.launch({
        args: [MAIN_ENTRY],
        cwd: testRoot,
        env: {
          ...process.env,
          MUXBASE_DEV: 'true',
          MUXBASE_DISABLE_UPDATE_CHECKS: '1',
          MUXBASE_E2E: '1',
          MUXBASE_E2E_USER_DATA_DIR: userData,
          NODE_ENV: 'test',
        },
      });
      page = await getAppWindow(app);
      await waitForAppReady(page, STARTUP_TIMEOUT_MS);
    }, STARTUP_TIMEOUT_MS);

    afterAll(async () => {
      if (app) await closeElectronApp(app);
      if (testRoot) rmSync(testRoot, { force: true, recursive: true });
    }, SHUTDOWN_TIMEOUT_MS);

    it('installs and uninstalls a marketplace skill through real IPC inside the isolated home', async () => {
      const browse = await invoke<MarketplaceBrowseResponse>(page, IPC.MARKETPLACE_BROWSE, {
        sourceUrl: SOURCE_URL,
      });
      expect(browse.error).toBeUndefined();
      expect(browse.plugins.map((plugin) => plugin.id)).toContain(PLUGIN_ID);

      const selection = {
        mode: 'selected' as const,
        pluginId: PLUGIN_ID,
        selectedAgents: [],
        selectedMcpServers: [],
        selectedSkills: [SKILL_NAME],
        sourceUrl: SOURCE_URL,
      };
      const preview = await invoke<MarketplacePreviewResponse>(page, IPC.MARKETPLACE_PREVIEW, selection);
      expect(preview.success, preview.error).toBe(true);
      expect(preview.preview?.digest).toMatch(/^[a-f0-9]{64}$/);
      if (!preview.preview) throw new Error('Marketplace preview was not returned');

      const install = await invoke<MarketplaceInstallResponse>(page, IPC.MARKETPLACE_INSTALL, {
        ...selection,
        previewDigest: preview.preview.digest,
      });
      expect(install.success, install.error).toBe(true);

      const destinations = [
        join(isolatedHome, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
        join(isolatedHome, '.codex', 'skills', SKILL_NAME, 'SKILL.md'),
        join(isolatedHome, '.config', 'opencode', 'skills', SKILL_NAME, 'SKILL.md'),
      ];
      for (const destination of destinations) {
        expect(realpathSync(destination).startsWith(`${isolatedHome}/`)).toBe(true);
        expect(readFileSync(destination, 'utf8')).toBe('# Hermetic marketplace skill\n');
      }

      const uninstall = await invoke<MarketplaceUninstallResponse>(page, IPC.MARKETPLACE_UNINSTALL, {
        pluginId: PLUGIN_ID,
        sourceUrl: SOURCE_URL,
      });
      expect(uninstall.success, uninstall.error).toBe(true);
      for (const destination of destinations) expect(existsSync(destination)).toBe(false);
    }, 30_000);

    it('fully installs a marketplace containing a safe internal symlink', async () => {
      const request = {
        mode: 'full' as const,
        pluginId: PLUGIN_ID,
        sourceUrl: SOURCE_URL,
      };
      const preview = await invoke<MarketplacePreviewResponse>(page, IPC.MARKETPLACE_PREVIEW, request);
      expect(preview.success, preview.error).toBe(true);
      if (!preview.preview) throw new Error('Marketplace preview was not returned');

      const install = await invoke<MarketplaceInstallResponse>(page, IPC.MARKETPLACE_INSTALL, {
        ...request,
        previewDigest: preview.preview.digest,
      });
      expect(install.success, install.error).toBe(true);

      const materializedLink = join(isolatedHome, '.claude', 'plugins', 'marketplaces', 'muxbase-hermetic', 'CLAUDE.md');
      expect(readFileSync(materializedLink, 'utf8')).toBe('# Shared marketplace instructions\n');
      expect(realpathSync(materializedLink)).toBe(materializedLink);

      const uninstall = await invoke<MarketplaceUninstallResponse>(page, IPC.MARKETPLACE_UNINSTALL, {
        pluginId: PLUGIN_ID,
        sourceUrl: SOURCE_URL,
      });
      expect(uninstall.success, uninstall.error).toBe(true);
      expect(existsSync(materializedLink)).toBe(false);
    }, 30_000);
  },
);
