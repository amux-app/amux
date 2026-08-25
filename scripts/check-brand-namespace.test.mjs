import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./check-brand-namespace.mjs', import.meta.url));
const temporaryRoots = [];

function createGitFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'muxbase-brand-namespace-'));
  temporaryRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = resolve(root, relativePath);
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { force: true, recursive: true });
  }
});

describe('brand namespace guard', () => {
  it('rejects old namespace content and filenames in tracked files', () => {
    const oldName = ['a', 'u', 'm', 'x'].join('');
    const root = createGitFixture({
      [`${oldName}-fixture.txt`]: `old namespace: ${oldName}\n`,
      'src/current.txt': `old namespace: ${oldName}\n`,
    });

    const result = spawnSync(process.execPath, [scriptPath, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Brand namespace guard FAILED');
    expect(result.stdout).toContain(`${oldName}-fixture.txt`);
    expect(result.stdout).toContain('src/current.txt');
  });

  it('allows explicitly historical matches only in changelog files', () => {
    const oldName = ['a', 'm', 'u', 'x'].join('');
    const root = createGitFixture({
      'CHANGELOG.md': `Historical ${oldName} release\n`,
      'LOCAL_CHANGELOG.md': `Historical ${oldName} note\n`,
    });

    const result = spawnSync(process.execPath, [scriptPath, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allowlisted historical matches: 2');
  });
});
