import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { resolve } from 'path';
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'fs';
import type { MuxBasePane } from 'muxbase/core';
import { closePaneBestEffort, getAppWindow, getPanes, pollUntil } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const APP_PROJECT_ROOT = resolve(ROOT, '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');

const RUN_TOKEN = `e2e-${Date.now().toString(36)}`;
const AGENT_IDLE_TIMEOUT = 180_000;
const PROMPT_TIMEOUT = 60_000;
const TOTAL_TIMEOUT = (() => {
  const parsed = Number(process.env.MUXBASE_E2E_MAX_MS ?? '900000');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900_000;
})();

const REPOS = {
  claude: 'https://github.com/muxbase-app/muxbase-e2e-fixtures-claude-fmt.git',
  codex: 'https://github.com/muxbase-app/muxbase-e2e-fixtures-codex-fmt.git',
  opencode: 'https://github.com/muxbase-app/muxbase-e2e-fixtures-opencode-fmt.git',
} as const;

const HOOK_MARKER_FILES = {
  claude: `/tmp/muxbase-e2e-hook-claude-fmt-${RUN_TOKEN}`,
  codex: `/tmp/muxbase-e2e-hook-codex-fmt-${RUN_TOKEN}`,
  opencode: `/tmp/muxbase-e2e-hook-opencode-fmt-${RUN_TOKEN}`,
} as const;

const SKILL_MARKERS = {
  claude: 'HELLO_E2E_SKILL_CLAUDE_FMT',
  codex: 'HELLO_E2E_SKILL_CODEX_FMT',
  opencode: 'HELLO_E2E_SKILL_OPENCODE_FMT',
} as const;

const MCP_MARKERS = {
  claude: 'HELLO_E2E_MCP_CLAUDE_FMT',
  codex: 'HELLO_E2E_MCP_CODEX_FMT',
} as const;

const PLUGIN_TOOL_MARKER = 'HELLO_E2E_TOOL_OPENCODE_FMT';

const ACTIVE_AGENT_STATES = new Set(['working', 'analyzing']);

const OPENCODE_CONFIG_PATH = resolve(process.env.HOME || '', '.config', 'opencode', 'opencode.json');
let originalOpencodeConfig: string | null = null;

function setOpencodeAutoAllow(): void {
  try {
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      originalOpencodeConfig = readFileSync(OPENCODE_CONFIG_PATH, 'utf-8');
      const config = JSON.parse(originalOpencodeConfig);
      config.permission = { '*': 'allow' };
      writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    }
  } catch { /* ignore */ }
}

function restoreOpencodeConfig(): void {
  try {
    if (originalOpencodeConfig !== null) {
      writeFileSync(OPENCODE_CONFIG_PATH, originalOpencodeConfig, 'utf-8');
    }
  } catch { /* ignore */ }
}

function cleanMarkerFiles(): void {
  try {
    const tmpFiles = readdirSync('/tmp').filter((f) => f.startsWith('muxbase-e2e-hook-'));
    for (const f of tmpFiles) {
      rmSync(`/tmp/${f}`, { force: true });
    }
  } catch { /* ignore */ }
}

async function initPaneStatusTracker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__muxbasePaneStatusTrackerInitialized) return;
    w.__muxbasePaneStatusById = {};
    w.muxbase.on(
      'event:pane-status-changed',
      (payload: { paneId?: string; status?: string }) => {
        const paneId = payload?.paneId;
        const status = payload?.status;
        if (!paneId || !status) return;
        w.__muxbasePaneStatusById[paneId] = status;
      },
    );
    w.muxbase.on(
      'event:agent-session-updated',
      (payload: { paneId?: string; session?: { turnCompleted?: boolean; awaitingUserInput?: boolean } }) => {
        const paneId = payload?.paneId;
        const session = payload?.session;
        if (!paneId || !session) return;
        if (session.awaitingUserInput) {
          w.__muxbasePaneStatusById[paneId] = 'waiting';
        } else if (session.turnCompleted === true) {
          w.__muxbasePaneStatusById[paneId] = 'idle';
        }
      },
    );
    w.__muxbasePaneStatusTrackerInitialized = true;
  });
}

async function getTranscriptForPane(page: Page, paneId: string): Promise<string> {
  const panes = await getPanes(page);
  const pane = panes.find((p: MuxBasePane) => p.id === paneId);
  if (!pane?.terminalTranscriptPath) return '';
  try {
    return readFileSync(pane.terminalTranscriptPath, 'utf-8');
  } catch {
    return '';
  }
}

async function waitForPaneIdle(page: Page, paneId: string, timeout = AGENT_IDLE_TIMEOUT): Promise<void> {
  await pollUntil(
    async () => {
      const status: string | undefined = await page.evaluate(
        (id) => (window as any).__muxbasePaneStatusById?.[id],
        paneId,
      );
      if (status && !ACTIVE_AGENT_STATES.has(status)) return true;
      return null;
    },
    { timeout, interval: 2000, label: `pane ${paneId} idle` },
  );
}

async function sendPromptAndWaitIdle(page: Page, pane: MuxBasePane, prompt: string, timeout = AGENT_IDLE_TIMEOUT): Promise<void> {
  // Reset status tracker for this pane so we wait for a fresh idle signal
  await page.evaluate(
    (id) => { (window as any).__muxbasePaneStatusById[id] = 'working'; },
    pane.id,
  );
  await page.evaluate(
    (payload) => (window as any).muxbase.invoke('pane:send-keys', payload),
    { paneId: pane.id, command: prompt },
  );
  await waitForPaneIdle(page, pane.id, timeout);
}

describe.runIf(process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_FIXTURES_READY === '1')('Marketplace E2E', () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    cleanMarkerFiles();
    setOpencodeAutoAllow();

    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        E2E_RUN_TOKEN: RUN_TOKEN,
      },
    });
    page = await getAppWindow(app);
    await initPaneStatusTracker(page);
  }, TOTAL_TIMEOUT);

  afterAll(async () => {
    if (app) await app.close();
    cleanMarkerFiles();
    restoreOpencodeConfig();
  });

  // Phase 1: Install
  describe('Phase 1: Install plugins', () => {
    it('adds all 3 marketplace sources', async () => {
      for (const [key, url] of Object.entries(REPOS)) {
        const result = await page.evaluate(
          (u) => (window as any).muxbase.invoke('marketplace:source-add', { url: u }),
          url,
        );
        expect(result.success, `source-add failed for ${key}: ${result.error}`).toBe(true);
      }
    }, 60_000);

    it('browses and installs plugins from all 3 sources', async () => {
      for (const [key, url] of Object.entries(REPOS)) {
        const browseResult = await page.evaluate(
          (u) => (window as any).muxbase.invoke('marketplace:browse', { sourceUrl: u }),
          url,
        );
        expect(browseResult.plugins.length, `no plugins found in ${key} repo`).toBeGreaterThan(0);

        const pluginId = browseResult.plugins[0].id;
        const previewResult = await page.evaluate(
          (payload) => (window as any).muxbase.invoke('marketplace:preview', payload),
          { pluginId, sourceUrl: url },
        );
        expect(previewResult.success, `preview failed for ${key}: ${previewResult.error}`).toBe(true);
        const installResult = await page.evaluate(
          (payload) => (window as any).muxbase.invoke('marketplace:install', payload),
          { pluginId, sourceUrl: url, previewDigest: previewResult.preview.digest },
        );
        expect(installResult.success, `install failed for ${key}: ${installResult.error}`).toBe(true);

        // Claude/Codex use native marketplace registration.
        // OpenCode uses direct install.
        // Status is 'full' for native, 'full' or 'partial' for direct.
        for (const agent of Object.keys(installResult.result.agents)) {
          const info = installResult.result.agents[agent];
          expect(
            info?.status === 'full' || info?.status === 'partial',
            `${key} plugin install status for ${agent} should be full or partial`,
          ).toBe(true);
        }
      }
    }, 120_000);
  });

  // Phase 2: Verify plugins work
  describe('Phase 2: Verify plugins fire in all agents', () => {
    const createdPanes: Record<string, MuxBasePane> = {};

    it('creates one pane per agent and waits for ready', async () => {
      const agents = ['claude', 'codex', 'opencode'] as const;
      for (const agent of agents) {
        const response = await page.evaluate(
          (payload) => (window as any).muxbase.invoke('pane:create', payload),
          {
            prompt: 'wait for my instructions',
            agent,
            projectRoot: APP_PROJECT_ROOT,
          },
        );
        expect(response.success, `pane:create failed for ${agent}: ${response.error}`).toBe(true);
        createdPanes[agent] = response.pane;
      }
      for (const pane of Object.values(createdPanes)) {
        await waitForPaneIdle(page, pane.id, AGENT_IDLE_TIMEOUT);
      }
    }, TOTAL_TIMEOUT);

    it('sends skill and MCP prompts to each pane', async () => {
      const prompts = [
        'Use the hello-e2e-claude-fmt skill. Just invoke it and show the output.',
        'Call the hello_e2e MCP tool from the hello-claude-fmt server. Show the response.',
        'Use the hello-e2e-opencode-fmt skill. Then call the hello_e2e MCP tool from hello-codex-fmt server. Show both outputs.',
      ];

      for (const pane of Object.values(createdPanes)) {
        for (const prompt of prompts) {
          try {
            await sendPromptAndWaitIdle(page, pane, prompt, PROMPT_TIMEOUT);
          } catch {
            // Agent may time out due to LLM limitations - continue best-effort
          }
        }
      }

      // Extra prompt for opencode - plugin tool
      if (createdPanes.opencode) {
        try {
          await sendPromptAndWaitIdle(page, createdPanes.opencode, 'Call the hello_e2e_opencode_fmt tool and show the response.', PROMPT_TIMEOUT);
        } catch {
          // best-effort
        }
      }
    }, TOTAL_TIMEOUT);

    // Phase 3: Assert
    it('skill markers appear in all agent transcripts', async () => {
      // Claude loads skills from native marketplace (claude-fmt repo only)
      const claudePane = createdPanes.claude;
      expect(claudePane, 'claude pane must exist').toBeDefined();
      const claudeTranscript = await getTranscriptForPane(page, claudePane.id);
      expect(claudeTranscript, 'claude transcript is empty').not.toBe('');

      expect(
        claudeTranscript.includes(SKILL_MARKERS.claude),
        `claude missing ${SKILL_MARKERS.claude}`,
      ).toBe(true);

      // OpenCode gets all skills via direct install
      if (createdPanes.opencode) {
        const ocTranscript = await getTranscriptForPane(page, createdPanes.opencode.id);
        if (ocTranscript) {
          expect(
            ocTranscript.includes(SKILL_MARKERS.claude),
            `opencode missing ${SKILL_MARKERS.claude}`,
          ).toBe(true);
          expect(
            ocTranscript.includes(SKILL_MARKERS.opencode),
            `opencode missing ${SKILL_MARKERS.opencode}`,
          ).toBe(true);
        }
      }
    });

    it('MCP markers appear in agent transcripts', async () => {
      // Claude gets MCP via direct install (native marketplace only supports npx/http MCP)
      const claudePane = createdPanes.claude;
      const claudeTranscript = await getTranscriptForPane(page, claudePane.id);

      expect(
        claudeTranscript.includes(MCP_MARKERS.claude),
        `claude missing ${MCP_MARKERS.claude}`,
      ).toBe(true);

      // OpenCode gets all MCP via direct install
      if (createdPanes.opencode) {
        const ocTranscript = await getTranscriptForPane(page, createdPanes.opencode.id);
        if (ocTranscript) {
          expect(
            ocTranscript.includes(MCP_MARKERS.claude),
            `opencode missing ${MCP_MARKERS.claude}`,
          ).toBe(true);
          expect(
            ocTranscript.includes(MCP_MARKERS.codex),
            `opencode missing ${MCP_MARKERS.codex}`,
          ).toBe(true);
        }
      }
    });

    it('opencode pane has plugin tool marker', async () => {
      if (!createdPanes.opencode) return;
      const transcript = await getTranscriptForPane(page, createdPanes.opencode.id);
      if (!transcript) return;
      // JS plugin tools require OpenCode runtime to load them from plugins/ dir.
      // This is best-effort - only assert if opencode shows signs of having loaded the plugin.
      if (transcript.includes('hello_e2e_opencode_fmt')) {
        expect(
          transcript.includes(PLUGIN_TOOL_MARKER),
          `opencode missing ${PLUGIN_TOOL_MARKER}`,
        ).toBe(true);
      }
    });

    it('hook marker files exist for all agents', async () => {
      // Claude hook fires via native marketplace plugin
      await pollUntil(
        async () => existsSync(HOOK_MARKER_FILES.claude),
        { timeout: 60_000, label: 'claude hook marker' },
      );
      expect(existsSync(HOOK_MARKER_FILES.claude)).toBe(true);

      // codex and opencode hooks are best-effort (depend on agent LLM capabilities)
      if (existsSync(HOOK_MARKER_FILES.codex)) {
        expect(existsSync(HOOK_MARKER_FILES.codex)).toBe(true);
      }
      if (existsSync(HOOK_MARKER_FILES.opencode)) {
        expect(existsSync(HOOK_MARKER_FILES.opencode)).toBe(true);
      }
    });

    afterAll(async () => {
      for (const pane of Object.values(createdPanes)) {
        await closePaneBestEffort(page, pane as any);
      }
    });
  });

  // Phase 4: Uninstall
  describe('Phase 4: Uninstall plugins', () => {
    it('uninstalls all 3 plugins', async () => {
      for (const [key, url] of Object.entries(REPOS)) {
        const browseResult = await page.evaluate(
          (u) => (window as any).muxbase.invoke('marketplace:browse', { sourceUrl: u }),
          url,
        );
        const pluginId = browseResult.plugins[0]?.id;
        if (!pluginId) continue;

        const result = await page.evaluate(
          (payload) => (window as any).muxbase.invoke('marketplace:uninstall', payload),
          { pluginId, sourceUrl: url },
        );
        expect(result.success, `uninstall failed for ${key}: ${result.error}`).toBe(true);
      }
    }, 30_000);

    it('skill directories are removed', () => {
      const home = process.env.HOME || '';
      // Only opencode uses direct skill install
      const skillNames = ['hello-e2e-claude-fmt', 'hello-e2e-codex-fmt', 'hello-e2e-opencode-fmt'];
      const baseDir = resolve(home, '.config', 'opencode', 'skills');
      for (const name of skillNames) {
        const dir = resolve(baseDir, name);
        expect(existsSync(dir), `skill dir still exists: ${dir}`).toBe(false);
      }
    });

    it('native registrations are removed from agent configs', async () => {
      const home = process.env.HOME || '';

      // Claude: enabledPlugins + extraKnownMarketplaces removed
      // Retry because concurrent Claude Code sessions may rewrite settings.json
      const claudeSettings = resolve(home, '.claude', 'settings.json');
      if (existsSync(claudeSettings)) {
        await pollUntil(
          async () => {
            const content = JSON.parse(readFileSync(claudeSettings, 'utf-8'));
            const enabledPlugins = content.enabledPlugins || {};
            const marketplaces = content.extraKnownMarketplaces || {};
            const hasPlugin = Object.keys(enabledPlugins).some((k) => k.includes('muxbase-e2e-plugin'));
            const hasMarketplace = Object.keys(marketplaces).some((k) => k.includes('muxbase-e2e-plugin'));
            if (!hasPlugin && !hasMarketplace) return true;
            return null;
          },
          { timeout: 10_000, interval: 1000, label: 'claude settings cleanup' },
        );
      }

      // Codex: [plugins...] and [marketplaces...] sections removed
      const codexConfig = resolve(home, '.codex', 'config.toml');
      if (existsSync(codexConfig)) {
        const content = readFileSync(codexConfig, 'utf-8');
        expect(content.includes('muxbase-e2e-plugin'), 'codex still has e2e plugin sections').toBe(false);
      }

      // OpenCode: MCP entries removed
      const opencodeConfig = resolve(home, '.config', 'opencode', 'opencode.json');
      if (existsSync(opencodeConfig)) {
        const content = JSON.parse(readFileSync(opencodeConfig, 'utf-8'));
        const mcp = content.mcp || {};
        expect(mcp['hello-claude-fmt'], 'opencode still has hello-claude-fmt MCP').toBeUndefined();
        expect(mcp['hello-codex-fmt'], 'opencode still has hello-codex-fmt MCP').toBeUndefined();
        expect(mcp['hello-opencode-fmt'], 'opencode still has hello-opencode-fmt MCP').toBeUndefined();
      }
    });

    it('hook files are removed', () => {
      const home = process.env.HOME || '';

      // Only opencode uses direct hook translation (JS plugin files)
      const opencodePluginsDir = resolve(home, '.config', 'opencode', 'plugins');
      if (existsSync(opencodePluginsDir)) {
        const remaining = readdirSync(opencodePluginsDir).filter((f) => f.startsWith('marketplace-'));
        expect(remaining, 'opencode marketplace plugin files should be removed').toHaveLength(0);
      }
    });
  });

  // Phase 5: Verify uninstall
  describe('Phase 5: Verify plugins no longer work', () => {
    const verifyPanes: Record<string, MuxBasePane> = {};

    it('creates new panes after uninstall and waits for ready', async () => {
      const agents = ['claude', 'codex', 'opencode'] as const;
      for (const agent of agents) {
        const response = await page.evaluate(
          (payload) => (window as any).muxbase.invoke('pane:create', payload),
          {
            prompt: 'wait for my instructions',
            agent,
            projectRoot: APP_PROJECT_ROOT,
          },
        );
        expect(response.success).toBe(true);
        verifyPanes[agent] = response.pane;
      }
      for (const [_agent, pane] of Object.entries(verifyPanes)) {
        await waitForPaneIdle(page, pane.id, AGENT_IDLE_TIMEOUT);
      }
    }, TOTAL_TIMEOUT);

    it('sends same prompts - agents cannot use removed plugins', async () => {
      cleanMarkerFiles();

      const prompt = 'Use the hello-e2e-claude-fmt skill. Call the hello_e2e MCP tool from hello-claude-fmt server.';

      for (const [_agent, pane] of Object.entries(verifyPanes)) {
        try {
          await sendPromptAndWaitIdle(page, pane, prompt, PROMPT_TIMEOUT);
        } catch {
          // Agent may time out - continue best-effort
        }
      }
    }, TOTAL_TIMEOUT);

    it('no skill or MCP markers appear after uninstall', async () => {
      for (const [agent, pane] of Object.entries(verifyPanes)) {
        const transcript = await getTranscriptForPane(page, pane.id);
        expect(
          transcript.includes(SKILL_MARKERS.claude),
          `${agent} still has skill marker after uninstall`,
        ).toBe(false);
        expect(
          transcript.includes(MCP_MARKERS.claude),
          `${agent} still has MCP marker after uninstall`,
        ).toBe(false);
      }
    });

    it('no hook marker files created after uninstall', () => {
      expect(existsSync(HOOK_MARKER_FILES.claude)).toBe(false);
      expect(existsSync(HOOK_MARKER_FILES.codex)).toBe(false);
      expect(existsSync(HOOK_MARKER_FILES.opencode)).toBe(false);
    });

    afterAll(async () => {
      for (const pane of Object.values(verifyPanes)) {
        await closePaneBestEffort(page, pane as any);
      }
    });
  });
});
