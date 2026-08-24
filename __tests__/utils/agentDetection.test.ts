import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const enhancedPath = vi.hoisted(() => ({ value: '' }));

vi.mock('../../src/utils/execAsync.js', () => ({
  getEnhancedPathAsync: vi.fn(async () => enhancedPath.value),
}));

import { findPiCommand } from '../../src/utils/agentDetection.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeExecutable(filePath: string, output: string): Promise<void> {
  await writeFile(filePath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, 'utf8');
  await chmod(filePath, 0o755);
}

async function writeExecutableScript(filePath: string, script: string): Promise<void> {
  await writeFile(filePath, `#!/bin/sh\n${script}\n`, 'utf8');
  await chmod(filePath, 0o755);
}

describe('agent detection', () => {
  it('recognizes a Pi package entrypoint from its resolved install path without launching the runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aumx-pi-detection-'));
    temporaryRoots.push(root);
    const binDirectory = path.join(root, 'bin');
    const entrypoint = path.join(
      root,
      'lib/node_modules/@vendor/pi-coding-agent/dist/cli.js',
    );
    await mkdir(binDirectory);
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeExecutable(entrypoint, 'Usage: pi [digits]');
    await symlink(entrypoint, path.join(binDirectory, 'pi'));
    enhancedPath.value = binDirectory;

    await expect(findPiCommand()).resolves.toBe(path.join(binDirectory, 'pi'));
  });

  it('continues past an unrelated pi executable and returns the verified binary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aumx-pi-detection-'));
    temporaryRoots.push(root);
    const unrelatedDirectory = path.join(root, 'unrelated');
    const codingAgentDirectory = path.join(root, 'coding-agent');
    await mkdir(unrelatedDirectory);
    await mkdir(codingAgentDirectory);
    await writeExecutable(path.join(unrelatedDirectory, 'pi'), 'Usage: pi [digits]');
    await writeExecutable(
      path.join(codingAgentDirectory, 'pi'),
      'pi - AI coding assistant with read, bash, edit, write tools\\nUsage: pi [options]',
    );
    enhancedPath.value = `${unrelatedDirectory}${path.delimiter}${codingAgentDirectory}`;

    await expect(findPiCommand()).resolves.toBe(path.join(codingAgentDirectory, 'pi'));
  });

  it('verifies Pi candidates within one bounded probe window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aumx-pi-detection-'));
    temporaryRoots.push(root);
    const slowDirectory = path.join(root, 'slow-collision');
    const codingAgentDirectory = path.join(root, 'coding-agent');
    const probeMarker = path.join(root, 'coding-agent-probed');
    await mkdir(slowDirectory);
    await mkdir(codingAgentDirectory);
    await writeExecutableScript(
      path.join(slowDirectory, 'pi'),
      `i=0\nwhile [ ! -f ${JSON.stringify(probeMarker)} ] && [ "$i" -lt 150 ]; do\n  sleep 0.01\n  i=$((i + 1))\ndone\nprintf '%s\\n' 'Usage: pi [digits]'`,
    );
    await writeExecutableScript(
      path.join(codingAgentDirectory, 'pi'),
      `touch ${JSON.stringify(probeMarker)}\nprintf '%s\\n' 'pi - AI coding assistant with read, bash, edit, write tools' 'Usage: pi [options]'`,
    );
    enhancedPath.value = `${slowDirectory}${path.delimiter}${codingAgentDirectory}`;

    const startedAt = Date.now();
    await expect(findPiCommand()).resolves.toBe(path.join(codingAgentDirectory, 'pi'));
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
