import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

type UnsupportedCode =
  | 'CLASSIC_PLUGIN'
  | 'CLASSIC_TYPESCRIPT'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNTRUSTED';

export type TypeScriptLspSupport =
  | { supported: true }
  | { supported: false; code: UnsupportedCode; reason: string };

interface TypeScriptBinaryOptions {
  arch: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function declaredTypeScriptVersion(packageJson: string): string | null {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = parsed[key];
      if (typeof dependencies !== 'object' || dependencies === null) continue;
      const version = (dependencies as Record<string, unknown>).typescript;
      if (typeof version === 'string') return version;
    }
  } catch {
    return null;
  }
  return null;
}

function extension(path: string): string {
  const dotIndex = path.lastIndexOf('.');
  return dotIndex < 0 ? '' : path.slice(dotIndex).toLowerCase();
}

export async function assessTypeScriptLspSupport(
  canonicalRoot: string,
  relativePath: string,
  trusted: boolean,
): Promise<TypeScriptLspSupport> {
  if (!trusted) {
    return { supported: false, code: 'UNTRUSTED', reason: 'Language intelligence is disabled for untrusted workspaces' };
  }
  if (!SUPPORTED_EXTENSIONS.has(extension(relativePath))) {
    return { supported: false, code: 'UNSUPPORTED_LANGUAGE', reason: 'This file type is syntax-only' };
  }

  const root = resolve(canonicalRoot);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}/`)) {
    return { supported: false, code: 'UNTRUSTED', reason: 'The file is outside the workspace' };
  }

  const directories: string[] = [];
  let directory = dirname(filePath);
  for (let depth = 0; depth < 32; depth += 1) {
    directories.push(directory);
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory || (parent !== root && !parent.startsWith(`${root}/`))) break;
    directory = parent;
  }

  for (const configDirectory of directories) {
    const packageJson = await readSmallFile(join(configDirectory, 'package.json'));
    if (packageJson) {
      const version = declaredTypeScriptVersion(packageJson);
      if (version) {
        const match = /(?:^|[^\d])(\d+)(?:\.|$)/.exec(version);
        if (!match || Number(match[1]) < 7) {
          return {
            supported: false,
            code: 'CLASSIC_TYPESCRIPT',
            reason: 'Projects declaring TypeScript 6 or older remain syntax-only',
          };
        }
      }
    }
    for (const configName of ['tsconfig.json', 'jsconfig.json']) {
      const config = await readSmallFile(join(configDirectory, configName));
      if (config && /["']plugins["']\s*:/.test(config)) {
        return {
          supported: false,
          code: 'CLASSIC_PLUGIN',
          reason: 'Projects with TypeScript language-service plugins remain syntax-only',
        };
      }
    }
  }
  return { supported: true };
}

export function resolveTypeScriptLspBinary(options: TypeScriptBinaryOptions): string {
  if (options.platform !== 'darwin' || (options.arch !== 'arm64' && options.arch !== 'x64')) {
    throw new Error(`Unsupported TypeScript LSP platform: ${options.platform}-${options.arch}`);
  }
  if (options.isPackaged) return join(options.resourcesPath, 'typescript', 'lib', 'tsc');

  const packageName = options.arch === 'arm64'
    ? '@typescript/typescript-darwin-arm64'
    : '@typescript/typescript-darwin-x64';
  const require = createRequire(import.meta.url);
  return join(require.resolve(`${packageName}/package.json`), '..', 'lib', 'tsc');
}
