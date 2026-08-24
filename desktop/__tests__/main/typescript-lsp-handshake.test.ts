import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LspServerManager } from '../../src/main/lsp/LspServerManager';
import { resolveTypeScriptLspBinary } from '../../src/main/lsp/typescriptLspPolicy';

const supportedHost = process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64');
const LSP_COMPLETION_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 25_000;

describe('bundled TypeScript 7 language server', () => {
  it.skipIf(!supportedHost)('completes a real tsc --lsp --stdio initialization handshake', async () => {
    const rootUri = new URL(`file://${process.cwd()}/`).href;
    const fileUri = new URL('__aumx_lsp_probe.ts', rootUri).href;
    const content = 'export const value = Math.ma';
    let resolveCompletion: ((value: unknown) => void) | undefined;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const executable = resolveTypeScriptLspBinary({
      arch: process.arch,
      isPackaged: false,
      platform: process.platform,
      resourcesPath: '',
    });
    const manager = new LspServerManager({
      canonicalize: async (root) => root,
      onEvent: (event) => {
        if (event.type !== 'message') return;
        const message = JSON.parse(event.message) as { id?: number; result?: unknown };
        if (message.id === 1 && message.result) {
          manager.send(process.cwd(), 'handshake-session', JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialized',
            params: {},
          }));
          manager.send(process.cwd(), 'handshake-session', JSON.stringify({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
              textDocument: { languageId: 'typescript', text: content, uri: fileUri, version: 0 },
            },
          }));
          manager.send(process.cwd(), 'handshake-session', JSON.stringify({
            id: 2,
            jsonrpc: '2.0',
            method: 'textDocument/completion',
            params: {
              position: { character: content.length, line: 0 },
              textDocument: { uri: fileUri },
            },
          }));
        }
        if (message.id === 2) resolveCompletion?.(message.result);
      },
      spawn: (root) => spawn(executable, ['--lsp', '--stdio'], {
        cwd: root,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    });

    try {
      expect(await manager.acquire(process.cwd(), 'handshake-session')).toMatchObject({ success: true });
      expect(manager.send(process.cwd(), 'handshake-session', JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          processId: process.pid,
          rootUri,
          workspaceFolders: null,
        },
      }))).toBe(true);
      await Promise.race([
        completion,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('LSP completion timed out')),
          LSP_COMPLETION_TIMEOUT_MS,
        )),
      ]);
      const result = await completion as { items?: Array<{ label?: string }> } | Array<{ label?: string }>;
      const items = Array.isArray(result) ? result : result.items ?? [];
      expect(items.some((item) => item.label === 'max')).toBe(true);
    } finally {
      manager.dispose();
    }
  }, TEST_TIMEOUT_MS);
});
