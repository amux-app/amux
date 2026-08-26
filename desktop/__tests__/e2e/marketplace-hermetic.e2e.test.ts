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
import type { MarketplaceUninstallResponse } from '../../src/shared/ipc-types';
import { closeElectronApp, getAppWindow, waitForAppReady } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const SOURCE_URL = 'https://example.invalid/muxbase-hermetic-marketplace.git';
const PLUGIN_ID = 'hermetic-plugin';
const SKILL_NAME = 'hermetic-skill';
const SECOND_SKILL_NAME = 'hermetic-second-skill';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

interface E2EWindow {
  muxbase: {
    invoke: <T>(channel: string, request?: unknown) => Promise<T>;
  };
}

function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    ({ ipcChannel, hasPayload, payload }) => {
      const muxbase = (window as unknown as E2EWindow).muxbase;
      return hasPayload ? muxbase.invoke<T>(ipcChannel, payload) : muxbase.invoke<T>(ipcChannel);
    },
    { ipcChannel: channel, hasPayload: request !== undefined, payload: request },
  );
}

describe.runIf(process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_FAKE_AGENTS === '1')(
  'Hermetic marketplace feature E2E',
  () => {
    let app: ElectronApplication;
    let page: Page;
    let testRoot = '';
    let isolatedHome = '';
    let userData = '';

    beforeAll(async () => {
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
      isolatedHome = realpathSync(process.env.HOME ?? '');
      expect(isolatedHome).toContain('muxbase-home-e2e-');

      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-marketplace-feature-')));
      const sourceClone = join(testRoot, 'source');
      userData = join(isolatedHome, 'user-data');
      const pluginRoot = join(sourceClone, 'plugins', PLUGIN_ID);
      mkdirSync(join(sourceClone, '.claude-plugin'), { recursive: true });
      mkdirSync(join(pluginRoot, 'skills', SKILL_NAME), { recursive: true });
      mkdirSync(join(pluginRoot, 'skills', SECOND_SKILL_NAME), { recursive: true });
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(sourceClone, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'muxbase-hermetic',
        plugins: [{ name: PLUGIN_ID, source: `./plugins/${PLUGIN_ID}`, version: '1.0.0' }],
      }, null, 2));
      writeFileSync(
        join(pluginRoot, 'skills', SKILL_NAME, 'SKILL.md'),
        '# Hermetic marketplace skill\n',
      );
      writeFileSync(
        join(pluginRoot, 'skills', SKILL_NAME, 'REFERENCE.md'),
        '# Shared skill reference\n',
      );
      writeFileSync(
        join(pluginRoot, 'skills', SECOND_SKILL_NAME, 'SKILL.md'),
        '# Hermetic second marketplace skill\n',
      );
      symlinkSync('REFERENCE.md', join(pluginRoot, 'skills', SKILL_NAME, 'REFERENCE-ALIAS.md'));
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

    it('installs all selected skills through the real Marketplace UI without native registration', async () => {
      await page.getByTestId('sidebar-marketplace-tree-toggle').click();
      await page.getByTestId('sidebar-marketplace-tree-item-skills').click();
      await expect.poll(() => page.getByRole('button', { name: /^Install$/ }).isVisible()).toBe(true);
      await page.getByRole('button', { name: /^Install$/ }).click();
      await page.getByRole('button', { name: 'Select all skills' }).click();
      await expect.poll(() => page.getByRole('button', { name: 'Install selected (2)' }).isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Install selected (2)' }).click();

      const destinations = [SKILL_NAME, SECOND_SKILL_NAME].flatMap((skillName) => [
        join(isolatedHome, '.claude', 'skills', skillName, 'SKILL.md'),
        join(isolatedHome, '.codex', 'skills', skillName, 'SKILL.md'),
        join(isolatedHome, '.config', 'opencode', 'skills', skillName, 'SKILL.md'),
      ]);
      await expect.poll(() => {
        try {
          const registry = JSON.parse(readFileSync(join(userData, 'marketplace-registry.json'), 'utf8')) as {
            installed: Array<{ pluginId: string; sourceUrl: string }>;
          };
          return registry.installed.some((installed) => installed.pluginId === PLUGIN_ID && installed.sourceUrl === SOURCE_URL);
        } catch {
          return false;
        }
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => destinations.filter((destination) => !existsSync(destination)), { timeout: 20_000 }).toEqual([]);
      expect(readFileSync(destinations[0], 'utf8')).toBe('# Hermetic marketplace skill\n');
      expect(readFileSync(destinations[3], 'utf8')).toBe('# Hermetic second marketplace skill\n');
      expect(realpathSync(join(isolatedHome, '.claude', 'skills', SKILL_NAME, 'REFERENCE-ALIAS.md')))
        .toBe(join(isolatedHome, '.claude', 'skills', SKILL_NAME, 'REFERENCE-ALIAS.md'));

      const registry = JSON.parse(readFileSync(join(userData, 'marketplace-registry.json'), 'utf8')) as {
        installed: Array<{
          pluginId: string;
          sourceUrl: string;
          selectedArtifacts?: {
            agentNames?: string[];
            mcpServers?: string[];
            skills?: string[];
            usedNativeRegistration?: boolean;
          };
        }>;
      };
      const record = registry.installed.find((installed) => installed.pluginId === PLUGIN_ID && installed.sourceUrl === SOURCE_URL);
      expect(record?.selectedArtifacts).toMatchObject({
        agentNames: [],
        mcpServers: [],
        skills: expect.arrayContaining([SKILL_NAME, SECOND_SKILL_NAME]),
      });
      expect(record?.selectedArtifacts?.skills).toHaveLength(2);
      expect(record?.selectedArtifacts?.usedNativeRegistration).toBe(false);
      expect(existsSync(join(isolatedHome, '.claude', 'plugins', 'marketplaces', 'muxbase-hermetic'))).toBe(false);
    }, 30_000);

    it('uninstalls the selected record, then fully installs through the explicit full action', async () => {
      const installed = await invoke<Array<{ pluginId: string; sourceUrl: string }>>(
        page,
        IPC.MARKETPLACE_INSTALLED_LIST,
      );
      if (!installed.some((entry) => entry.pluginId === PLUGIN_ID && entry.sourceUrl === SOURCE_URL)) {
        const selectedRequest = {
          mode: 'selected' as const,
          pluginId: PLUGIN_ID,
          selectedAgents: [],
          selectedMcpServers: [],
          selectedSkills: [SKILL_NAME, SECOND_SKILL_NAME],
          sourceUrl: SOURCE_URL,
        };
        const preview = await invoke<{ success: boolean; preview?: { digest: string }; error?: string }>(
          page,
          IPC.MARKETPLACE_PREVIEW,
          selectedRequest,
        );
        expect(preview.success, preview.error).toBe(true);
        if (!preview.preview) throw new Error('Selected marketplace preview was not returned');
        const install = await invoke<{ success: boolean; error?: string }>(
          page,
          IPC.MARKETPLACE_INSTALL,
          { ...selectedRequest, previewDigest: preview.preview.digest },
        );
        expect(install.success, install.error).toBe(true);
      }

      const uninstall = await invoke<MarketplaceUninstallResponse>(page, IPC.MARKETPLACE_UNINSTALL, {
        pluginId: PLUGIN_ID,
        sourceUrl: SOURCE_URL,
      });
      expect(uninstall.success, uninstall.error).toBe(true);

      await page.reload();
      await waitForAppReady(page, STARTUP_TIMEOUT_MS);
      await page.getByTestId('sidebar-marketplace-tree-toggle').click();
      await page.getByTestId('sidebar-marketplace-tree-item-skills').click();
      await expect.poll(() => page.getByRole('button', { name: /^Install$/ }).isVisible()).toBe(true);
      await page.getByRole('button', { name: /^Install$/ }).click();
      const dialog = page.waitForEvent('dialog').then((event) => event.accept());
      await page.getByRole('button', { name: 'Install full plugin' }).click();
      await dialog;

      const materializedLink = join(isolatedHome, '.claude', 'plugins', 'marketplaces', 'muxbase-hermetic', 'CLAUDE.md');
      await expect.poll(() => existsSync(materializedLink)).toBe(true);
      expect(readFileSync(materializedLink, 'utf8')).toBe('# Shared marketplace instructions\n');
      expect(realpathSync(materializedLink)).toBe(materializedLink);

      await expect.poll(() => {
        try {
          const registry = JSON.parse(readFileSync(join(userData, 'marketplace-registry.json'), 'utf8')) as {
            installed: Array<{ pluginId: string; sourceUrl: string; selectedArtifacts?: { usedNativeRegistration?: boolean } }>;
          };
          return registry.installed.some((installed) => installed.pluginId === PLUGIN_ID
            && installed.sourceUrl === SOURCE_URL
            && installed.selectedArtifacts?.usedNativeRegistration === true);
        } catch {
          return false;
        }
      }, { timeout: 20_000 }).toBe(true);

      const registry = JSON.parse(readFileSync(join(userData, 'marketplace-registry.json'), 'utf8')) as {
        installed: Array<{ pluginId: string; sourceUrl: string; selectedArtifacts?: { usedNativeRegistration?: boolean } }>;
      };
      const record = registry.installed.find((installed) => installed.pluginId === PLUGIN_ID && installed.sourceUrl === SOURCE_URL);
      expect(record?.selectedArtifacts?.usedNativeRegistration).toBe(true);

      const fullUninstall = await invoke<MarketplaceUninstallResponse>(page, IPC.MARKETPLACE_UNINSTALL, {
        pluginId: PLUGIN_ID,
        sourceUrl: SOURCE_URL,
      });
      expect(fullUninstall.success, fullUninstall.error).toBe(true);
      expect(existsSync(materializedLink)).toBe(false);
    }, 30_000);
  },
);
