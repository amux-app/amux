import { listPackage } from '@electron/asar';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateMachOArchitectures,
  verifyAppLaunch,
} from '../../scripts/verify-macos-release.mjs';

// Initial measured budget: the previous 11.7 MB archive plus the bounded Node
// formatter runtime (Prettier and diff). Tune only from packaged measurements.
const MAX_APP_ASAR_BYTES = 26_000_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = resolve(SCRIPT_DIR, '..', 'release');

const FORBIDDEN_ARCHIVE_ENTRIES = [
  { label: 'source map', pattern: /\.map$/ },
  {
    label: 'measured development source tree',
    pattern: /\/node_modules\/(?:minisearch|zod|node-pty)\/src(?:\/|$)/,
  },
  { label: 'node-pty prebuild', pattern: /\/node_modules\/node-pty\/prebuilds(?:\/|$)/ },
  { label: 'winpty source', pattern: /\/node_modules\/node-pty\/deps\/winpty(?:\/|$)/ },
  { label: 'node-pty compiled test', pattern: /\/node_modules\/node-pty\/lib\/[^/]+\.test\.js$/ },
];

const REQUIRED_ARCHIVE_ENTRIES = [
  '/node_modules/debug/src/index.js',
  '/node_modules/node-pty/build/Release/pty.node',
  '/node_modules/muxbase/config/system-requirements.json',
];

function lspFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

async function verifyTypeScriptLspHandshake(executable, rootPath) {
  await new Promise((resolveHandshake, rejectHandshake) => {
    const child = spawn(executable, ['--lsp', '--stdio'], {
      cwd: rootPath,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = Buffer.alloc(0);
    let initialized = false;
    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectHandshake(new Error(`TypeScript LSP handshake timed out: ${stderr.slice(0, 500)}`));
    }, 10_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectHandshake(error);
      else resolveHandshake();
    };
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', finish);
    child.once('exit', (code) => {
      if (initialized && (code === 0 || code === null)) finish();
      else finish(new Error(`TypeScript LSP exited before initialization (${code}): ${stderr.slice(0, 500)}`));
    });
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const separator = buffer.indexOf('\r\n\r\n');
        if (separator < 0) return;
        const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString('ascii'));
        if (!match) return finish(new Error('TypeScript LSP returned malformed framing'));
        const bodyStart = separator + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (buffer.length < bodyEnd) return;
        const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
        buffer = buffer.subarray(bodyEnd);
        if (message.method && Object.hasOwn(message, 'id')) {
          child.stdin.write(lspFrame({ id: message.id, jsonrpc: '2.0', result: null }));
        } else if (message.id === 1 && message.result) {
          initialized = true;
          child.kill();
          finish();
        }
      }
    });
    child.stdin.write(lspFrame({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        processId: process.pid,
        rootUri: new URL(`file://${rootPath}/`).href,
        workspaceFolders: null,
      },
    }));
  });
}

function findArchives(root) {
  if (!existsSync(root)) return [];
  const archives = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      archives.push(...findArchives(path));
    } else if (entry.isFile() && entry.name === 'app.asar') {
      archives.push(path);
    }
  }
  return archives;
}

function verifyArchive(archivePath) {
  const entries = listPackage(archivePath);
  const failures = [];
  const archiveBytes = statSync(archivePath).size;

  if (archiveBytes > MAX_APP_ASAR_BYTES) {
    failures.push(
      `archive is ${archiveBytes} bytes; budget is ${MAX_APP_ASAR_BYTES} bytes`,
    );
  }

  for (const required of REQUIRED_ARCHIVE_ENTRIES) {
    if (!entries.includes(required)) {
      failures.push(`required runtime entry is missing: ${required}`);
    }
  }

  if (process.platform === 'darwin') {
    const helper = `${archivePath}.unpacked/node_modules/node-pty/build/Release/spawn-helper`;
    if (!existsSync(helper)) failures.push('unpacked node-pty spawn-helper is missing');
  }
  const nativeModule = `${archivePath}.unpacked/node_modules/node-pty/build/Release/pty.node`;
  if (!existsSync(nativeModule)) failures.push('unpacked node-pty native module is missing');

  for (const rule of FORBIDDEN_ARCHIVE_ENTRIES) {
    const matches = entries.filter((entry) => rule.pattern.test(entry));
    if (matches.length > 0) {
      failures.push(
        `${matches.length} forbidden ${rule.label} entr${matches.length === 1 ? 'y' : 'ies'} `
        + `(first: ${matches[0]})`,
      );
    }
  }

  if (process.platform === 'darwin') {
    const appPath = resolve(dirname(archivePath), '..', '..');
    const outputDirectory = relative(RELEASE_DIR, appPath).split('/')[0];
    const expectedArch = outputDirectory === 'mac-arm64'
      ? 'arm64'
      : outputDirectory === 'mac'
        ? 'x64'
        : null;
    if (expectedArch) {
      const typescriptBinary = join(dirname(archivePath), 'typescript', 'lib', 'tsc');
      if (!existsSync(typescriptBinary)) {
        failures.push('packaged TypeScript 7 LSP binary is missing from extraResources');
      }
      const binaries = [
        ['app executable', join(appPath, 'Contents', 'MacOS', 'MuxBase')],
        ['node-pty native module', nativeModule],
        [
          'node-pty spawn helper',
          `${archivePath}.unpacked/node_modules/node-pty/build/Release/spawn-helper`,
        ],
        ['TypeScript 7 LSP binary', typescriptBinary],
      ];
      for (const [label, path] of binaries) {
        if (!existsSync(path)) continue;
        try {
          const architectures = execFileSync('lipo', ['-archs', path], { encoding: 'utf8' });
          validateMachOArchitectures(
            architectures,
            expectedArch,
            `${outputDirectory} ${label}`,
          );
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Packaged-content verification failed for ${relative(RELEASE_DIR, archivePath)}:\n`
      + failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }

  process.stdout.write(
    `[package-verify] ${relative(RELEASE_DIR, archivePath)}: `
    + `${entries.length} entries, ${archiveBytes} bytes, clean\n`,
  );
}

const archives = findArchives(RELEASE_DIR);
if (archives.length === 0) {
  throw new Error(`No app.asar archive found under ${RELEASE_DIR}`);
}
for (const archive of archives) verifyArchive(archive);

if (process.platform === 'darwin') {
  for (const archive of archives) {
    const appPath = resolve(dirname(archive), '..', '..');
    const label = relative(RELEASE_DIR, appPath);
    const outputDirectory = label.split('/')[0];
    const packageArch = outputDirectory === 'mac-arm64'
      ? 'arm64'
      : outputDirectory === 'mac'
        ? 'x64'
        : null;
    if (packageArch && packageArch !== process.arch) {
      process.stdout.write(
        `[package-verify] ${label}: packaged launch skipped on ${process.arch} host\n`,
      );
      continue;
    }
    await verifyAppLaunch(appPath, label);
    process.stdout.write(`[package-verify] ${label}: packaged executable launch stable\n`);
    const typescriptBinary = join(dirname(archive), 'typescript', 'lib', 'tsc');
    await verifyTypeScriptLspHandshake(typescriptBinary, appPath);
    process.stdout.write(`[package-verify] ${label}: packaged TypeScript 7 LSP handshake passed\n`);
  }
}
