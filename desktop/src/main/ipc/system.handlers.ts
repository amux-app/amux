import { app, clipboard, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execAsync, parseTmuxVersion, validateSystemRequirements } from 'muxbase/core';
import { IPC } from '../../shared/ipc-channels.js';
import type { AppInfoResult, ListEditorsResponse, SessionInfoResult, SystemCheckResult } from '../../shared/ipc-types.js';
import { readAppBuildInfo } from '../services/AppBuildInfo.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { detectAvailableEditors, resolveEditorById } from '../services/editorDetection.js';
import { log } from '../services/Logger.js';
import { createSupportBundle, previewSupportBundle, SUPPORT_BUNDLE_FILE_PATTERN } from '../services/SupportBundleService.js';
import { isSafeExternalUrl } from '../utils/externalUrl.js';
import { isPathWithinRoot, resolveAuthorizedFileRoot, validateFilePath } from '../utils/file-root-authorization.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

const UNAUTHORIZED_PATH_ERROR = 'Unauthorized path';

export function registerSystemHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.SYSTEM_APP_INFO, () => {
    return getAppInfo();
  });

  secureHandle(IPC.SESSION_INFO, () => {
    const result: SessionInfoResult = {
      logDir: log.getLogDir(),
      logFile: log.getLogFile(),
      sessionName: bridge.getSessionName(),
      projectName: bridge.getProjectName(),
      projectRoot: bridge.getProjectRoot(),
      homeDir: homedir(),
    };
    log.debug('ipc:system', 'SESSION_INFO', result);
    return result;
  });
  secureHandle(IPC.SYSTEM_CHECK, async () => {
    log.info('ipc:system', 'SYSTEM_CHECK invoked');
    try {
      const result = await runSystemCheck();
      bridge.updateAvailableAgentsCache(result.agents);
      log.info('ipc:system', 'SYSTEM_CHECK result', { tmux: result.tmux, git: result.git, agentCount: result.agents.length });
      return result;
    } catch (error) {
      log.error('ipc:system', 'SYSTEM_CHECK failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.SYSTEM_REVEAL_PATH, async (_event, { path }: { path: string }) => {
    if (!existsSync(path)) return { error: 'Path does not exist' };
    if (!isRevealablePath(bridge, path)) {
      log.warn('ipc:system', 'Blocked reveal of an unauthorized path', { path });
      return { error: UNAUTHORIZED_PATH_ERROR };
    }
    shell.showItemInFolder(path);
    return { success: true };
  }, { mainWindowOnly: true });

  secureHandle(IPC.SYSTEM_OPEN_EXTERNAL, async (_event, { url }: { url: string }) => {
    if (!isSafeExternalUrl(url)) {
      log.warn('ipc:system', 'Blocked unsafe external URL', { url });
      return { error: 'Unsafe URL' };
    }
    await shell.openExternal(url);
    return { success: true };
  }, { mainWindowOnly: true });

  secureHandle(
    IPC.SYSTEM_OPEN_IN_EDITOR,
    async (_event, { path, file, line, editorId }: { path: string; file?: string; line?: number; editorId?: string }) => {
      if (!existsSync(path)) {
        return { error: 'Path does not exist' };
      }

      try {
        const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), path);
        const target = buildEditorTarget(rootPath, file, line);

        // Resolve the executable in main from a trusted allowlist — the renderer
        // only names an editor id, never a raw command, so it can never launch an
        // arbitrary binary. Unknown ids fall back to the "System default" entry.
        const { command } = resolveEditorById(editorId);
        const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
          .map((token) => token.replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        const [bin, ...baseArgs] = tokens.length > 0 ? tokens : ['code'];

        const args = [...baseArgs];
        if (file && line) args.push('--goto');
        args.push(target);

        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn(bin, args, { stdio: 'ignore', detached: true, shell: false });
          child.once('error', rejectPromise);
          child.once('spawn', () => {
            child.unref();
            resolvePromise();
          });
        });
        return { success: true };
      } catch (error) {
        log.error('ipc:system', 'Failed to open in editor', error);
        return { error: formatError(error) };
      }
    },
    { mainWindowOnly: true },
  );

  secureHandle(IPC.SYSTEM_PREVIEW_SUPPORT_BUNDLE, async (_event, { includeTranscripts }: { includeTranscripts: boolean }) => {
    try {
      const systemCheck = await runSystemCheck().catch((error) => ({ error: formatError(error) }));
      return previewSupportBundle(buildSupportBundleOptions(bridge, systemCheck, includeTranscripts));
    } catch (error) {
      log.error('ipc:system', 'Failed to preview support bundle', error);
      return { error: formatError(error) };
    }
  }, { mainWindowOnly: true });

  secureHandle(IPC.SYSTEM_EXPORT_SUPPORT_BUNDLE, async (_event, { includeTranscripts }: { includeTranscripts: boolean }) => {
    try {
      const systemCheck = await runSystemCheck().catch((error) => ({ error: formatError(error) }));
      const result = await createSupportBundle(buildSupportBundleOptions(bridge, systemCheck, includeTranscripts));
      log.info('ipc:system', 'Support bundle exported', {
        includedFileCount: result.includedFiles.length,
        includeTranscripts,
        path: result.path,
      });
      return result;
    } catch (error) {
      log.error('ipc:system', 'Failed to export support bundle', error);
      return { error: formatError(error) };
    }
  }, { mainWindowOnly: true });

  secureHandle(IPC.SYSTEM_LIST_EDITORS, async (): Promise<ListEditorsResponse> => {
    try {
      return { editors: detectAvailableEditors() };
    } catch (error) {
      log.error('ipc:system', 'Failed to list editors', error);
      // Always return at least the system fallback so the UI never breaks.
      return {
        editors: [{
          id: 'system',
          label: 'System default',
          command: process.env.EDITOR?.trim() || 'code',
          source: 'fallback',
        }],
      };
    }
  });

  secureHandle(IPC.SYSTEM_CLIPBOARD_WRITE, async (_event, { text }: { text: string }) => {
    clipboard.writeText(text);
    return { success: true };
  }, { mainWindowOnly: true });

  secureHandle(IPC.SYSTEM_CLIPBOARD_READ, async () => {
    return { text: clipboard.readText() };
  });
}

function buildSupportBundleOptions(
  bridge: MuxBaseBridge,
  systemCheck: SystemCheckResult | { error: string },
  includeTranscripts: boolean,
) {
  return {
    appInfo: getAppInfo(),
    includeTranscripts,
    logDir: log.getLogDir(),
    logFile: log.getLogFile(),
    outputDir: app.getPath('desktop'),
    panes: bridge.getPanes(),
    projectName: bridge.getProjectName(),
    projectRoot: bridge.getProjectRoot(),
    sessionName: bridge.getSessionName(),
    systemCheck,
  };
}

function getAppInfo(): AppInfoResult {
  const version = app.getVersion();
  const buildInfo = readAppBuildInfo(app.getAppPath(), version);
  return {
    ...buildInfo,
    isPackaged: app.isPackaged,
    version,
  };
}

async function runSystemCheck(): Promise<SystemCheckResult> {
  const validation = await validateSystemRequirements();
  const agents = validation.agents;

  let tmuxVersion: string | undefined;
  let gitVersion: string | undefined;

  try {
    const raw = await execAsync('tmux -V', { silent: true });
    const parsed = parseTmuxVersion(raw);
    tmuxVersion = parsed?.raw.replace(/^tmux\s+/, '');
  } catch {
    // Not available
  }

  try {
    const raw = await execAsync('git --version', { silent: true });
    const match = raw.match(/git version\s+([\d.]+)/);
    gitVersion = match?.[1];
  } catch {
    // Not available
  }

  return {
    agents,
    git: {
      available: validation.canRun && validation.errors.every((e) => !e.includes('git')),
      version: gitVersion,
    },
    tmux: {
      available: validation.canRun && validation.errors.every((e) => !e.includes('tmux')),
      version: tmuxVersion,
    },
  };
}

function buildEditorTarget(rootPath: string, file?: string, line?: number): string {
  if (!file) return rootPath;
  const filePath = validateFilePath(rootPath, file);
  return line ? `${filePath}:${line}` : filePath;
}

/**
 * Support bundles are the only Desktop files this app writes, so revealing is
 * limited to a bundle file sitting directly on the Desktop rather than to the
 * whole directory.
 */
function isSupportBundlePath(path: string): boolean {
  const resolved = resolve(path);
  return dirname(resolved) === app.getPath('desktop')
    && SUPPORT_BUNDLE_FILE_PATTERN.test(basename(resolved));
}

function isRevealablePath(bridge: MuxBaseBridge, path: string): boolean {
  const logDir = log.getLogDir();
  if (logDir !== null && isPathWithinRoot(logDir, path)) return true;
  if (isSupportBundlePath(path)) return true;

  try {
    resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), path);
    return true;
  } catch {
    return false;
  }
}
