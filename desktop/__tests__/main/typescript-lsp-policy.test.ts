import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assessTypeScriptLspSupport,
  resolveTypeScriptLspBinary,
} from '../../src/main/lsp/typescriptLspPolicy';

describe('TypeScript LSP support policy', () => {
  it('accepts trusted JS/TS roots with no declared TypeScript or TypeScript 7', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxbase-ts7-policy-'));
    expect(await assessTypeScriptLspSupport(root, 'src/index.ts', true)).toEqual({ supported: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^7.0.2' } }));
    expect(await assessTypeScriptLspSupport(root, 'src/index.ts', true)).toEqual({ supported: true });
  });

  it('keeps untrusted, classic TypeScript, plugin, and unsupported-language roots syntax-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muxbase-ts7-policy-'));
    await mkdir(join(root, 'src'));
    expect(await assessTypeScriptLspSupport(root, 'src/index.ts', false)).toMatchObject({ supported: false });
    expect(await assessTypeScriptLspSupport(root, 'src/App.vue', true)).toMatchObject({ supported: false });
    expect(await assessTypeScriptLspSupport(root, '../outside.ts', true)).toMatchObject({
      code: 'UNTRUSTED',
      supported: false,
    });

    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { typescript: '~6.0.3' } }));
    expect(await assessTypeScriptLspSupport(root, 'src/index.ts', true)).toMatchObject({
      code: 'CLASSIC_TYPESCRIPT',
      supported: false,
    });

    await mkdir(join(root, 'packages', 'legacy', 'src'), { recursive: true });
    await writeFile(join(root, 'packages', 'legacy', 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^6.0.0' },
    }));
    expect(await assessTypeScriptLspSupport(root, 'packages/legacy/src/index.ts', true)).toMatchObject({
      code: 'CLASSIC_TYPESCRIPT',
      supported: false,
    });

    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'tsconfig.json'), '{ "compilerOptions": { "plugins": [] } }');
    expect(await assessTypeScriptLspSupport(root, 'src/index.ts', true)).toMatchObject({
      code: 'CLASSIC_PLUGIN',
      supported: false,
    });
  });

  it('resolves the packaged binary outside ASAR for the target architecture', () => {
    expect(resolveTypeScriptLspBinary({
      arch: 'arm64',
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/App/Contents/Resources',
    })).toBe('/App/Contents/Resources/typescript/lib/tsc');
    expect(() => resolveTypeScriptLspBinary({
      arch: 'ia32',
      isPackaged: false,
      platform: 'darwin',
      resourcesPath: '',
    })).toThrow('Unsupported TypeScript LSP platform');
  });
});
