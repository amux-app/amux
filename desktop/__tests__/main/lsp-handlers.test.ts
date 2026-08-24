import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLspFrame } from '../../src/main/lsp/LspFrameParser';
import { registerLspHandlers, stopLspServers } from '../../src/main/ipc/lsp.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const secureHandleMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { isPackaged: false, once: vi.fn() },
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: { getInstance: () => ({ get: () => true }) },
}));

vi.mock('../../src/main/services/EditorRuntimeMetrics.js', () => ({
  EditorRuntimeMetrics: { getInstance: () => ({ recordLspStarted: vi.fn(), recordLspStopped: vi.fn() }) },
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/main/utils/file-root-authorization.js', () => ({
  resolveAuthorizedFileRoot: (_active: string, _panes: unknown[], requested: string) => requested,
  validateFilePath: vi.fn(),
}));

vi.mock('../../src/main/lsp/typescriptLspPolicy.js', () => ({
  assessTypeScriptLspSupport: vi.fn(async () => ({ supported: true })),
  resolveTypeScriptLspBinary: vi.fn(() => '/usr/bin/node'),
}));

class FakeWebContents extends EventEmitter {
  sent: unknown[] = [];
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(...args: unknown[]): void {
    this.sent.push(args);
  }
}

class FakeProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin = { write: vi.fn() };
  readonly stdout = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

function register(): void {
  spawnMock.mockImplementation(() => new FakeProcess());
  registerLspHandlers({
    getPanes: () => [],
    getProjectRoot: () => '/project',
  } as never);
}

function acquire(sender: FakeWebContents, editorSessionId: string): Promise<unknown> {
  return getHandler(IPC.LSP_ACQUIRE)({ sender }, {
    editorSessionId,
    relativePath: 'src/index.ts',
    rootPath: '/project',
  });
}

describe('LSP IPC lifecycle', () => {
  beforeEach(() => {
    stopLspServers();
    secureHandleMock.mockClear();
    spawnMock.mockClear();
  });

  it('keeps one renderer-destroyed listener across repeated acquire and release cycles', async () => {
    const sender = new FakeWebContents();
    register();

    await acquire(sender, 'session-1');
    getHandler(IPC.LSP_RELEASE)(undefined, { editorSessionId: 'session-1', rootId: '/project' });
    await acquire(sender, 'session-2');

    expect(sender.listenerCount('destroyed')).toBe(1);
  });

  it('retains root event delivery until the sender releases its last session', async () => {
    const sender = new FakeWebContents();
    register();

    await acquire(sender, 'session-1');
    await acquire(sender, 'session-2');
    getHandler(IPC.LSP_RELEASE)(undefined, { editorSessionId: 'session-1', rootId: '/project' });

    const process = spawnMock.mock.results[0]?.value as FakeProcess;
    process.stdout.emit('data', encodeLspFrame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {} }));
    expect(sender.sent).toHaveLength(1);

    getHandler(IPC.LSP_RELEASE)(undefined, { editorSessionId: 'session-2', rootId: '/project' });
    process.stdout.emit('data', encodeLspFrame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {} }));
    expect(sender.sent).toHaveLength(1);
  });

  it('releases every session owned by a destroyed renderer and removes its listener on global stop', async () => {
    const sender = new FakeWebContents();
    register();

    await acquire(sender, 'session-1');
    await acquire(sender, 'session-2');
    sender.destroyed = true;
    sender.emit('destroyed');

    expect(sender.listenerCount('destroyed')).toBe(0);
    stopLspServers();
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
});
