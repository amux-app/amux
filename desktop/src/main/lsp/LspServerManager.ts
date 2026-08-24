import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  encodeLspFrame,
  isJsonRpcMessage,
  LspFrameParser,
  type JsonRpcMessage,
} from './LspFrameParser.js';

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const MAX_LIVE_SERVERS = 2;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 10_000;
const MAX_RENDERER_MESSAGE_BYTES = 16 * 1024 * 1024;

interface LspStream {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
}

interface LspWritableStream {
  write(data: Buffer): boolean;
}

export interface LspChildProcess {
  readonly stdin: LspWritableStream;
  readonly stdout: LspStream;
  readonly stderr: LspStream;
  kill(): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
}

export type LspAcquireResult =
  | { success: true; rootId: string }
  | { success: false; code: 'CIRCUIT_OPEN' | 'RESOURCE_LIMIT' | 'START_FAILED'; error: string };

export type LspServerEvent =
  | { type: 'message'; rootId: string; message: string }
  | { type: 'status'; rootId: string; status: 'crashed' | 'restarting' | 'started' | 'stopped'; detail?: string };

interface LspServerManagerOptions {
  canonicalize: (rootPath: string) => Promise<string>;
  idleTimeoutMs?: number;
  onEvent?: (event: LspServerEvent) => void;
  onStderr?: (rootId: string, message: string) => void;
  spawn: (canonicalRoot: string) => LspChildProcess;
}

interface ServerEntry {
  crashTimes: number[];
  generation: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
  parser: LspFrameParser;
  pendingMethods: Map<string, string>;
  process?: LspChildProcess;
  references: Set<string>;
  restartTimer: ReturnType<typeof setTimeout> | null;
  rootId: string;
}

function rpcIdKey(id: JsonRpcMessage['id']): string {
  return `${typeof id}:${String(id)}`;
}

function boundServerMessage(entry: ServerEntry, message: JsonRpcMessage): JsonRpcMessage {
  if (message.method === 'textDocument/publishDiagnostics') {
    const params = message.params as { diagnostics?: unknown[] } | undefined;
    if (Array.isArray(params?.diagnostics) && params.diagnostics.length > 1_000) {
      return { ...message, params: { ...params, diagnostics: params.diagnostics.slice(0, 1_000) } };
    }
    return message;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return message;
  const method = entry.pendingMethods.get(rpcIdKey(message.id));
  entry.pendingMethods.delete(rpcIdKey(message.id));
  if (!method || !Object.prototype.hasOwnProperty.call(message, 'result')) return message;
  const limits: Record<string, number> = {
    'textDocument/completion': 500,
    'textDocument/definition': 100,
    'textDocument/diagnostic': 1_000,
    'textDocument/references': 1_000,
  };
  const limit = limits[method];
  if (!limit) return message;
  if (Array.isArray(message.result)) return { ...message, result: message.result.slice(0, limit) };
  if (
    method === 'textDocument/diagnostic'
    && typeof message.result === 'object'
    && message.result !== null
    && Array.isArray((message.result as { items?: unknown[] }).items)
  ) {
    const result = message.result as { items: unknown[] } & Record<string, unknown>;
    return { ...message, result: { ...result, items: result.items.slice(0, limit) } };
  }
  if (
    method === 'textDocument/completion'
    && typeof message.result === 'object'
    && message.result !== null
    && Array.isArray((message.result as { items?: unknown[] }).items)
  ) {
    const result = message.result as { items: unknown[] } & Record<string, unknown>;
    return { ...message, result: { ...result, items: result.items.slice(0, limit) } };
  }
  return message;
}

function requestResult(message: JsonRpcMessage, rootId: string): unknown {
  switch (message.method) {
    case 'workspace/configuration': {
      const items = (message.params as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    }
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return null;
    case 'window/showMessageRequest':
      return null;
    case 'workspace/workspaceFolders':
      return [{ name: basename(rootId), uri: pathToFileURL(rootId).href }];
    case 'workspace/applyEdit':
      return { applied: false, failureReason: 'Multi-file language-server edits are not enabled' };
    default:
      return undefined;
  }
}

export class LspServerManager {
  private readonly canonicalize: LspServerManagerOptions['canonicalize'];
  private readonly idleTimeoutMs: number;
  private readonly onEvent?: LspServerManagerOptions['onEvent'];
  private readonly onStderr?: LspServerManagerOptions['onStderr'];
  private readonly spawn: LspServerManagerOptions['spawn'];
  private readonly servers = new Map<string, ServerEntry>();
  private readonly sessionRoots = new Map<string, string>();

  constructor(options: LspServerManagerOptions) {
    this.canonicalize = options.canonicalize;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.onStderr = options.onStderr;
    this.spawn = options.spawn;
  }

  async acquire(rootPath: string, editorSessionId: string): Promise<LspAcquireResult> {
    const rootId = await this.canonicalize(rootPath);
    const previousRoot = this.sessionRoots.get(editorSessionId);
    if (previousRoot && previousRoot !== rootId) {
      return { success: false, code: 'START_FAILED', error: 'An editor session cannot switch files or roots' };
    }

    let entry = this.servers.get(rootId);
    if (!entry) {
      if (this.servers.size >= MAX_LIVE_SERVERS) {
        const idle = [...this.servers.values()]
          .filter((candidate) => candidate.references.size === 0)
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (!idle) {
          return {
            success: false,
            code: 'RESOURCE_LIMIT',
            error: 'Language intelligence is active in two other worktrees',
          };
        }
        this.disposeEntry(idle, 'stopped');
      }
      entry = this.createEntry(rootId);
      this.servers.set(rootId, entry);
      if (!this.start(entry)) {
        this.servers.delete(rootId);
        return { success: false, code: 'START_FAILED', error: 'TypeScript language server failed to start' };
      }
    } else if (!entry.process && !entry.restartTimer) {
      const recentCrashes = this.recentCrashes(entry);
      if (recentCrashes.length >= MAX_CRASHES_IN_WINDOW) {
        return { success: false, code: 'CIRCUIT_OPEN', error: 'Language server restart limit reached' };
      }
      if (!this.start(entry)) {
        return { success: false, code: 'START_FAILED', error: 'TypeScript language server failed to start' };
      }
    }

    this.cancelIdleTimer(entry);
    entry.references.add(editorSessionId);
    entry.lastUsedAt = Date.now();
    this.sessionRoots.set(editorSessionId, rootId);
    return { success: true, rootId };
  }

  release(rootId: string, editorSessionId: string): void {
    const entry = this.servers.get(rootId);
    if (!entry || this.sessionRoots.get(editorSessionId) !== rootId) return;
    entry.references.delete(editorSessionId);
    this.sessionRoots.delete(editorSessionId);
    entry.lastUsedAt = Date.now();
    if (entry.references.size > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.references.size === 0 && this.servers.get(rootId) === entry) {
        this.disposeEntry(entry, 'stopped');
      }
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  send(rootId: string, editorSessionId: string, serializedMessage: string): boolean {
    const entry = this.servers.get(rootId);
    if (!entry?.process || this.sessionRoots.get(editorSessionId) !== rootId) return false;
    if (Buffer.byteLength(serializedMessage, 'utf8') > MAX_RENDERER_MESSAGE_BYTES) return false;
    let message: unknown;
    try {
      message = JSON.parse(serializedMessage);
    } catch {
      return false;
    }
    if (!isJsonRpcMessage(message)) return false;
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      entry.pendingMethods.set(rpcIdKey(message.id), message.method);
    }
    entry.process.stdin.write(encodeLspFrame(message));
    entry.lastUsedAt = Date.now();
    return true;
  }

  dispose(): void {
    for (const entry of [...this.servers.values()]) this.disposeEntry(entry, 'stopped');
  }

  private createEntry(rootId: string): ServerEntry {
    return {
      crashTimes: [],
      generation: 0,
      idleTimer: null,
      lastUsedAt: Date.now(),
      parser: new LspFrameParser(),
      pendingMethods: new Map(),
      references: new Set(),
      restartTimer: null,
      rootId,
    };
  }

  private start(entry: ServerEntry): boolean {
    try {
      const process = this.spawn(entry.rootId);
      const generation = ++entry.generation;
      entry.parser = new LspFrameParser();
      entry.process = process;
      this.onEvent?.({ rootId: entry.rootId, status: 'started', type: 'status' });
      process.stdout.on('data', (chunk) => {
        if (entry.process !== process || entry.generation !== generation) return;
        try {
          for (const message of entry.parser.push(chunk)) this.handleServerMessage(entry, message);
        } catch (error) {
          this.handleFailure(entry, process, `Invalid LSP stream: ${String(error)}`);
        }
      });
      process.stdout.on('end', () => {
        if (entry.process === process) this.handleFailure(entry, process, 'Language server closed stdout');
      });
      process.stderr.on('data', (chunk) => {
        this.onStderr?.(entry.rootId, chunk.toString('utf8').slice(0, 4_096));
      });
      process.stderr.on('end', () => undefined);
      process.on('error', (error) => {
        if (entry.process !== process) return;
        this.handleFailure(entry, process, `Language server process error: ${String(error)}`);
      });
      process.on('exit', (code, signal) => {
        if (entry.process !== process) return;
        this.handleFailure(entry, process, `Language server exited (${code ?? signal ?? 'unknown'})`);
      });
      return true;
    } catch (error) {
      this.handleStartFailure(entry, `Language server failed to start: ${String(error)}`);
      return false;
    }
  }

  private handleServerMessage(entry: ServerEntry, message: JsonRpcMessage): void {
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const result = requestResult(message, entry.rootId);
      const response: JsonRpcMessage = result === undefined
        ? {
            error: { code: -32601, message: `Unsupported server request: ${message.method}` },
            id: message.id ?? null,
            jsonrpc: '2.0',
          }
        : { id: message.id ?? null, jsonrpc: '2.0', result };
      entry.process?.stdin.write(encodeLspFrame(response));
      return;
    }
    this.onEvent?.({
      message: JSON.stringify(boundServerMessage(entry, message)),
      rootId: entry.rootId,
      type: 'message',
    });
  }

  private handleFailure(entry: ServerEntry, process: LspChildProcess, detail: string): void {
    if (entry.process !== process) return;
    entry.process = undefined;
    entry.parser = new LspFrameParser();
    entry.pendingMethods.clear();
    try {
      process.kill();
    } catch {
      // The process may already be gone.
    }
    this.handleStartFailure(entry, detail);
  }

  private handleStartFailure(entry: ServerEntry, detail: string): void {
    const now = Date.now();
    entry.crashTimes = this.recentCrashes(entry, now);
    entry.crashTimes.push(now);
    this.onEvent?.({ detail, rootId: entry.rootId, status: 'crashed', type: 'status' });
    if (entry.references.size === 0) return;
    if (entry.crashTimes.length >= MAX_CRASHES_IN_WINDOW) return;

    const delay = Math.min(
      INITIAL_RESTART_DELAY_MS * (2 ** (entry.crashTimes.length - 1)),
      MAX_RESTART_DELAY_MS,
    );
    this.onEvent?.({ detail, rootId: entry.rootId, status: 'restarting', type: 'status' });
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (entry.references.size > 0 && this.servers.get(entry.rootId) === entry) this.start(entry);
    }, delay);
    entry.restartTimer.unref?.();
  }

  private recentCrashes(entry: ServerEntry, now = Date.now()): number[] {
    return entry.crashTimes.filter((crashedAt) => now - crashedAt <= CRASH_WINDOW_MS);
  }

  private cancelIdleTimer(entry: ServerEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private disposeEntry(entry: ServerEntry, status: 'stopped'): void {
    this.cancelIdleTimer(entry);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
    const process = entry.process;
    entry.process = undefined;
    try {
      process?.kill();
    } catch {
      // The process may already be gone.
    }
    for (const sessionId of entry.references) this.sessionRoots.delete(sessionId);
    entry.references.clear();
    this.servers.delete(entry.rootId);
    this.onEvent?.({ rootId: entry.rootId, status, type: 'status' });
  }
}
