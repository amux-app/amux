import { spawn } from 'node:child_process';
import { app, type WebContents } from 'electron';
import { IPC, IPC_EVENT } from '../../shared/ipc-channels.js';
import type {
  LspAcquireRequest,
  LspAcquireResponse,
  LspReleaseRequest,
  LspSendRequest,
} from '../../shared/ipc-types.js';
import {
  LspServerManager,
  type LspServerEvent,
} from '../lsp/LspServerManager.js';
import {
  assessTypeScriptLspSupport,
  resolveTypeScriptLspBinary,
} from '../lsp/typescriptLspPolicy.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { EditorRuntimeMetrics } from '../services/EditorRuntimeMetrics.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { log } from '../services/Logger.js';
import {
  resolveAuthorizedFileRoot,
  validateFilePath,
} from '../utils/file-root-authorization.js';
import { secureHandle } from './ipc-security.js';

interface Subscription {
  editorSessionId: string;
  rootId: string;
  sender: WebContents;
}

let stopRegisteredLspServers: () => void = () => undefined;

export function stopLspServers(): void {
  stopRegisteredLspServers();
}

export function registerLspHandlers(bridge: MuxBaseBridge): void {
  const subscriptions = new Map<string, Subscription>();
  const subscribersByRoot = new Map<string, Set<WebContents>>();
  const destroyHandlers = new Map<WebContents, () => void>();
  const publish = (event: LspServerEvent): void => {
    if (event.type === 'status') {
      if (event.status === 'started') EditorRuntimeMetrics.getInstance().recordLspStarted(event.rootId);
      if (event.status === 'crashed' || event.status === 'stopped') {
        EditorRuntimeMetrics.getInstance().recordLspStopped(event.rootId);
      }
      if (event.status === 'crashed') {
        log.error('lsp', 'TypeScript language server crashed', {
          detail: event.detail ?? 'No failure detail was provided',
          rootId: event.rootId,
        });
      }
    }
    for (const sender of subscribersByRoot.get(event.rootId) ?? []) {
      if (!sender.isDestroyed()) sender.send(IPC_EVENT.LSP_EVENT, event);
    }
    if (event.type === 'status' && event.status === 'stopped') subscribersByRoot.delete(event.rootId);
  };
  const manager = new LspServerManager({
    canonicalize: async (rootPath) => rootPath,
    onEvent: publish,
    onStderr: (rootId, message) => {
      log.warn('lsp', 'TypeScript language server stderr', { message, rootId });
    },
    spawn: (rootPath) => {
      const executable = resolveTypeScriptLspBinary({
        arch: process.arch,
        isPackaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
      });
      return spawn(executable, ['--lsp', '--stdio'], {
        cwd: rootPath,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  });
  stopRegisteredLspServers = () => {
    manager.dispose();
    for (const [sender, handler] of destroyHandlers) {
      sender.removeListener('destroyed', handler);
    }
    destroyHandlers.clear();
    subscriptions.clear();
    subscribersByRoot.clear();
  };

  const removeSenderFromRootIfUnused = (sender: WebContents, rootId: string): void => {
    const stillSubscribed = [...subscriptions.values()].some(
      (subscription) => subscription.sender === sender && subscription.rootId === rootId,
    );
    if (stillSubscribed) return;
    const subscribers = subscribersByRoot.get(rootId);
    if (!subscribers) return;
    subscribers.delete(sender);
    if (subscribers.size === 0) subscribersByRoot.delete(rootId);
  };

  const releaseSubscription = (editorSessionId: string): void => {
    const subscription = subscriptions.get(editorSessionId);
    if (!subscription) return;
    subscriptions.delete(editorSessionId);
    manager.release(subscription.rootId, editorSessionId);
    removeSenderFromRootIfUnused(subscription.sender, subscription.rootId);
  };

  const releaseSenderSubscriptions = (sender: WebContents): void => {
    for (const [editorSessionId, subscription] of subscriptions) {
      if (subscription.sender === sender) releaseSubscription(editorSessionId);
    }
    destroyHandlers.delete(sender);
  };

  secureHandle(IPC.LSP_ACQUIRE, async (event, request: LspAcquireRequest): Promise<LspAcquireResponse> => {
    if (!ElectronSettingsService.getInstance().get('enableLanguageIntelligence')) {
      return { success: false, code: 'DISABLED', error: 'Language intelligence is disabled in Settings' };
    }
    const rootPath = resolveAuthorizedFileRoot(
      bridge.getProjectRoot(),
      bridge.getPanes(),
      request.rootPath,
    );
    validateFilePath(rootPath, request.relativePath);
    const support = await assessTypeScriptLspSupport(rootPath, request.relativePath, true);
    if (!support.supported) return { success: false, code: support.code, error: support.reason };

    const acquired = await manager.acquire(rootPath, request.editorSessionId);
    if (!acquired.success) return acquired;
    const subscription = {
      editorSessionId: request.editorSessionId,
      rootId: acquired.rootId,
      sender: event.sender,
    };
    subscriptions.set(request.editorSessionId, subscription);
    const rootSubscribers = subscribersByRoot.get(acquired.rootId) ?? new Set<WebContents>();
    rootSubscribers.add(event.sender);
    subscribersByRoot.set(acquired.rootId, rootSubscribers);

    if (!destroyHandlers.has(event.sender)) {
      const destroyHandler = () => releaseSenderSubscriptions(event.sender);
      destroyHandlers.set(event.sender, destroyHandler);
      event.sender.once('destroyed', destroyHandler);
    }
    return acquired;
  });

  secureHandle(IPC.LSP_SEND, (_event, request: LspSendRequest) => ({
    accepted: manager.send(request.rootId, request.editorSessionId, request.message),
  }));

  secureHandle(IPC.LSP_RELEASE, (_event, request: LspReleaseRequest) => {
    releaseSubscription(request.editorSessionId);
    return { success: true };
  });

  app.once('before-quit', stopLspServers);
}
