import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { encodeLspFrame } from '../../src/main/lsp/LspFrameParser';
import {
  LspServerManager,
  type LspChildProcess,
} from '../../src/main/lsp/LspServerManager';

class FakeStream extends EventEmitter {
  writes: Buffer[] = [];

  write(data: Buffer): boolean {
    this.writes.push(data);
    return true;
  }
}

class FakeProcess extends EventEmitter implements LspChildProcess {
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('LspServerManager', () => {
  it('reuses canonical roots, evicts only idle roots, and caps active roots at two', async () => {
    const processes: FakeProcess[] = [];
    const manager = new LspServerManager({
      canonicalize: async (root) => root.replace(/\/$/, ''),
      spawn: () => {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      },
    });

    expect(await manager.acquire('/one/', 'session-1')).toMatchObject({ success: true, rootId: '/one' });
    expect(await manager.acquire('/one', 'session-2')).toMatchObject({ success: true, rootId: '/one' });
    expect(await manager.acquire('/two', 'session-3')).toMatchObject({ success: true });
    expect(processes).toHaveLength(2);
    expect(await manager.acquire('/three', 'session-4')).toMatchObject({
      success: false,
      code: 'RESOURCE_LIMIT',
    });

    manager.release('/one', 'session-1');
    manager.release('/one', 'session-2');
    expect(await manager.acquire('/three', 'session-4')).toMatchObject({ success: true });
    expect(processes[0]?.killed).toBe(true);
    expect(processes).toHaveLength(3);
  });

  it('answers server-to-client requests so initialization cannot stall', async () => {
    const process = new FakeProcess();
    const manager = new LspServerManager({ canonicalize: async (root) => root, spawn: () => process });
    await manager.acquire('/project', 'session-1');

    process.stdout.emit('data', encodeLspFrame({
      id: 7,
      jsonrpc: '2.0',
      method: 'workspace/configuration',
      params: { items: [{ section: 'typescript' }, { section: 'javascript' }] },
    }));

    const reply = Buffer.concat(process.stdin.writes).toString('utf8');
    expect(reply).toContain('Content-Length:');
    expect(reply).toContain('"id":7');
    expect(reply).toContain('"result":[null,null]');
  });

  it('tears down and schedules restart after a framing violation', async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const manager = new LspServerManager({
        canonicalize: async (root) => root,
        spawn: () => {
          const process = new FakeProcess();
          processes.push(process);
          return process;
        },
      });
      await manager.acquire('/project', 'session-1');

      processes[0]?.stdout.emit('data', Buffer.from('Broken: yes\r\n\r\n{}'));
      expect(processes[0]?.killed).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(processes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports synchronous and asynchronous process start failures', async () => {
    const synchronousEvents: unknown[] = [];
    const synchronous = new LspServerManager({
      canonicalize: async (root) => root,
      onEvent: (event) => synchronousEvents.push(event),
      spawn: () => { throw new Error('spawn failed'); },
    });

    expect(await synchronous.acquire('/project', 'session-1')).toMatchObject({
      code: 'START_FAILED',
      success: false,
    });
    expect(synchronousEvents).toContainEqual(expect.objectContaining({
      detail: expect.stringContaining('spawn failed'),
      status: 'crashed',
    }));

    const process = new FakeProcess();
    const asynchronousEvents: unknown[] = [];
    const asynchronous = new LspServerManager({
      canonicalize: async (root) => root,
      onEvent: (event) => asynchronousEvents.push(event),
      spawn: () => process,
    });
    expect(await asynchronous.acquire('/project', 'session-1')).toMatchObject({ success: true });

    process.emit('error', new Error('ENOENT'));

    expect(process.killed).toBe(true);
    expect(asynchronousEvents).toContainEqual(expect.objectContaining({
      detail: expect.stringContaining('ENOENT'),
      status: 'crashed',
    }));
    asynchronous.dispose();
  });
});
