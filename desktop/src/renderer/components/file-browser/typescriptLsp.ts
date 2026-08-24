import {
  findReferencesKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  LSPClient,
  LSPPlugin,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  Workspace,
} from '@codemirror/lsp-client';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { Extension, Text } from '@codemirror/state';
import { keymap, ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import {
  acquireLsp,
  releaseLsp,
  sendLsp,
  subscribeLspEvents,
} from '../../api/lsp.api';
import { rendererLog } from '../../lib/rendererLog';
import { useFileBrowserStore } from '../../stores/file-browser.store';
import { sanitizeLspHtml } from './lspHtmlSanitizer';
import {
  consumePendingLspNavigation,
  markPendingLspNavigation,
  relativePathFromFileUri,
  toFileUri,
} from './lspNavigation';

const IDLE_CLIENT_EXPIRY_MS = 90_000;
const LSP_LOG_SCOPE = 'typescript-lsp';

export interface TypeScriptLspActivation {
  dispose: () => void;
  extension: Extension;
  status: 'ready';
}

export interface TypeScriptLspUnavailable {
  reason: string;
  status: 'syntax-only' | 'unavailable';
}

interface RootClient {
  client: LSPClient;
  connected: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  initializing: Promise<null>;
  references: Set<string>;
  rootId: string;
  statusListeners: Map<string, (status: TypeScriptLspUnavailable['status'] | 'ready', detail?: string) => void>;
  transport: LspTransport;
  unsubscribe: () => void;
}

interface LspTransport {
  send(message: string): void;
  subscribe(handler: (value: string) => void): void;
  unsubscribe(handler: (value: string) => void): void;
}

const rootClients = new Map<string, RootClient>();
const rootClientPromises = new Map<string, Promise<RootClient>>();

function languageId(path: string): string {
  if (path.endsWith('.tsx')) return 'typescriptreact';
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'typescript';
  if (path.endsWith('.jsx')) return 'javascriptreact';
  return 'javascript';
}

class WorkspaceDocument {
  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
    readonly view: EditorView,
  ) {}

  getView(): EditorView {
    return this.view;
  }
}

class AppWorkspace extends Workspace {
  files: WorkspaceDocument[] = [];
  private readonly versions = new Map<string, number>();

  constructor(client: LSPClient, private readonly rootId: string) {
    super(client);
  }

  syncFiles() {
    const updates = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      const prevDoc = file.doc;
      const changes = plugin.unsyncedChanges;
      file.doc = file.view.state.doc;
      file.version = this.nextVersion(file.uri);
      plugin.clear();
      updates.push({ changes, file, prevDoc });
    }
    return updates;
  }

  openFile(uri: string, fileLanguageId: string, view: EditorView): void {
    if (this.getFile(uri)) return;
    const file = new WorkspaceDocument(uri, fileLanguageId, this.nextVersion(uri), view.state.doc, view);
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string): void {
    const file = this.getFile(uri);
    if (!file) return;
    this.files = this.files.filter((candidate) => candidate !== file);
    this.client.didClose(uri);
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const existing = this.getFile(uri)?.getView();
    if (existing) return existing;
    const relativePath = relativePathFromFileUri(this.rootId, uri);
    if (!relativePath) return null;
    markPendingLspNavigation(uri);
    try {
      await useFileBrowserStore.getState().openFile(this.rootId, relativePath);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const view = this.getFile(uri)?.getView();
        if (view) return view;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    } finally {
      consumePendingLspNavigation(uri);
    }
  }

  private nextVersion(uri: string): number {
    const version = (this.versions.get(uri) ?? -1) + 1;
    this.versions.set(uri, version);
    return version;
  }
}

class PullDiagnosticsController {
  private activeParams: object | null = null;
  private destroyed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly view: EditorView,
    private readonly getClient: () => LSPClient,
    private readonly rootId: string,
  ) {
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    if (this.activeParams) this.getClient().cancelRequest(this.activeParams);
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    if (this.activeParams) this.getClient().cancelRequest(this.activeParams);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const generation = ++this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pull(generation);
    }, 500);
  }

  private async pull(generation: number): Promise<void> {
    const plugin = LSPPlugin.get(this.view);
    if (!plugin || this.destroyed) return;
    const client = this.getClient();
    client.sync();
    const mapping = client.workspaceMapping();
    const params = { textDocument: { uri: plugin.uri } };
    this.activeParams = params;
    try {
      const report = await client.request<typeof params, unknown>('textDocument/diagnostic', params);
      if (this.destroyed || generation !== this.generation) return;
      const items = typeof report === 'object' && report !== null
        && Array.isArray((report as { items?: unknown[] }).items)
        ? (report as { items: unknown[] }).items.slice(0, 1_000)
        : [];
      let droppedDiagnostics = 0;
      const diagnostics = items.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const diagnostic = item as {
          message?: unknown;
          range?: { end?: unknown; start?: unknown };
          severity?: unknown;
        };
        const start = diagnostic.range?.start;
        const end = diagnostic.range?.end;
        if (
          typeof diagnostic.message !== 'string'
          || typeof start !== 'object'
          || start === null
          || typeof end !== 'object'
          || end === null
        ) return [];
        try {
          const severity: Diagnostic['severity'] = diagnostic.severity === 2
            ? 'warning'
            : diagnostic.severity === 3
              ? 'info'
              : diagnostic.severity === 4
                ? 'hint'
                : 'error';
          return [{
            from: mapping.mapPosition(plugin.uri, start as { character: number; line: number }),
            message: diagnostic.message,
            severity,
            to: mapping.mapPosition(plugin.uri, end as { character: number; line: number }),
          }];
        } catch {
          droppedDiagnostics += 1;
          return [];
        }
      });
      if (droppedDiagnostics > 0) {
        rendererLog.debug(LSP_LOG_SCOPE, 'Dropped diagnostics with invalid positions', {
          count: droppedDiagnostics,
          rootId: this.rootId,
        });
      }
      this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        rendererLog.debug(LSP_LOG_SCOPE, 'TypeScript diagnostics request did not complete', {
          error,
          rootId: this.rootId,
        });
      }
    } finally {
      mapping.destroy();
      if (this.activeParams === params) this.activeParams = null;
    }
  }
}

function createPullDiagnosticsExtension(getClient: () => LSPClient, rootId: string): Extension {
  return ViewPlugin.define((view) => new PullDiagnosticsController(view, getClient, rootId));
}

async function createRootClient(rootId: string, editorSessionId: string): Promise<RootClient> {
  const handlers = new Set<(message: string) => void>();
  let clientEntry: RootClient;
  const references = new Set([editorSessionId]);
  const subscribeToEvents = () => subscribeLspEvents((event) => {
    if (event.rootId !== rootId) return;
    if (event.type === 'message') {
      for (const handler of handlers) handler(event.message);
      return;
    }
    if (event.status === 'crashed' || event.status === 'restarting') {
      if (clientEntry.connected) clientEntry.client.disconnect();
      clientEntry.connected = false;
      for (const listener of clientEntry.statusListeners.values()) {
        listener('unavailable', event.detail ?? 'TypeScript language server is restarting');
      }
    } else if (event.status === 'started' && !clientEntry.connected) {
      clientEntry.initializing = clientEntry.client.connect(clientEntry.transport).initializing;
      void clientEntry.initializing.then(() => {
        for (const listener of clientEntry.statusListeners.values()) listener('ready');
      }, (error: unknown) => {
        clientEntry.connected = false;
        clientEntry.client.disconnect();
        rendererLog.warn(LSP_LOG_SCOPE, 'Language server restart initialization failed', { error, rootId });
      });
      clientEntry.connected = true;
    } else if (event.status === 'stopped') {
      for (const listener of clientEntry.statusListeners.values()) {
        listener('syntax-only', 'TypeScript language intelligence stopped');
      }
      disposeRootClient(clientEntry);
    }
  });
  const transport: LspTransport = {
    send(message) {
      const activeSessionId = references.values().next().value ?? editorSessionId;
      void sendLsp({ editorSessionId: activeSessionId, message, rootId }).then(({ accepted }) => {
        if (!accepted) rendererLog.warn(LSP_LOG_SCOPE, 'Language server rejected a renderer message', { rootId });
      }).catch((error: unknown) => {
        rendererLog.warn(LSP_LOG_SCOPE, 'Language server send failed', { error, rootId });
      });
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
  };
  let client: LSPClient;
  const pullDiagnostics = {
    clientCapabilities: {
      textDocument: {
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
      },
    },
    editorExtension: createPullDiagnosticsExtension(() => client, rootId),
  };
  client = new LSPClient({
    extensions: [
      serverCompletion(),
      hoverTooltips(),
      signatureHelp(),
      serverDiagnostics(),
      pullDiagnostics,
      keymap.of([...jumpToDefinitionKeymap, ...findReferencesKeymap]),
    ],
    rootUri: toFileUri(rootId),
    sanitizeHTML: sanitizeLspHtml,
    timeout: 10_000,
    workspace: (workspaceClient) => new AppWorkspace(workspaceClient, rootId),
  });
  clientEntry = {
    client,
    connected: true,
    idleTimer: null,
    initializing: Promise.resolve(null),
    references,
    rootId,
    statusListeners: new Map(),
    transport,
    unsubscribe: () => undefined,
  };
  clientEntry.unsubscribe = subscribeToEvents();
  clientEntry.initializing = client.connect(transport).initializing;
  try {
    await clientEntry.initializing;
  } catch (error) {
    clientEntry.connected = false;
    client.disconnect();
    clientEntry.unsubscribe();
    throw error;
  }
  return clientEntry;
}

function disposeRootClient(client: RootClient): void {
  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = null;
  if (client.connected) client.client.disconnect();
  client.connected = false;
  client.statusListeners.clear();
  client.unsubscribe();
  rootClients.delete(client.rootId);
}

export async function activateTypeScriptLsp(options: {
  editorSessionId: string;
  onStatus?: (status: TypeScriptLspUnavailable['status'] | 'ready', detail?: string) => void;
  relativePath: string;
  rootPath: string;
}): Promise<TypeScriptLspActivation | TypeScriptLspUnavailable> {
  const acquired = await acquireLsp({
    editorSessionId: options.editorSessionId,
    relativePath: options.relativePath,
    rootPath: options.rootPath,
  });
  if (!acquired.success) {
    const syntaxOnly = acquired.code === 'CLASSIC_PLUGIN'
      || acquired.code === 'CLASSIC_TYPESCRIPT'
      || acquired.code === 'DISABLED'
      || acquired.code === 'UNSUPPORTED_LANGUAGE'
      || acquired.code === 'UNTRUSTED';
    return { reason: acquired.error, status: syntaxOnly ? 'syntax-only' : 'unavailable' };
  }

  let rootClient = rootClients.get(acquired.rootId);
  if (!rootClient) {
    let pending = rootClientPromises.get(acquired.rootId);
    if (!pending) {
      pending = createRootClient(acquired.rootId, options.editorSessionId).then((created) => {
        rootClients.set(acquired.rootId, created);
        return created;
      }).finally(() => rootClientPromises.delete(acquired.rootId));
      rootClientPromises.set(acquired.rootId, pending);
    }
    try {
      rootClient = await pending;
    } catch (error) {
      await releaseLsp({ editorSessionId: options.editorSessionId, rootId: acquired.rootId });
      throw error;
    }
  }
  if (rootClient.idleTimer) clearTimeout(rootClient.idleTimer);
  rootClient.idleTimer = null;
  rootClient.references.add(options.editorSessionId);
  if (options.onStatus) rootClient.statusListeners.set(options.editorSessionId, options.onStatus);
  try {
    if (!rootClient.connected) {
      rootClient.initializing = rootClient.client.connect(rootClient.transport).initializing;
      rootClient.connected = true;
    }
    await rootClient.initializing;
  } catch (error) {
    rendererLog.warn(LSP_LOG_SCOPE, 'Language server initialization failed', { error, rootId: acquired.rootId });
    rootClient.connected = false;
    rootClient.client.disconnect();
    await releaseLsp({ editorSessionId: options.editorSessionId, rootId: acquired.rootId });
    rootClient.references.delete(options.editorSessionId);
    rootClient.statusListeners.delete(options.editorSessionId);
    return { reason: 'TypeScript language server failed to initialize', status: 'unavailable' };
  }

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rootClient.references.delete(options.editorSessionId);
      rootClient.statusListeners.delete(options.editorSessionId);
      void releaseLsp({ editorSessionId: options.editorSessionId, rootId: acquired.rootId });
      if (rootClient.references.size > 0) return;
      rootClient.idleTimer = setTimeout(() => disposeRootClient(rootClient), IDLE_CLIENT_EXPIRY_MS);
    },
    extension: rootClient.client.plugin(
      toFileUri(acquired.rootId, options.relativePath),
      languageId(options.relativePath),
    ),
    status: 'ready',
  };
}
