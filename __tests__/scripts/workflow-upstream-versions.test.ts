import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_DIR = resolve('.github', 'workflows');
const WORKFLOW_FILES = [
  'ci.yml',
  'codeql.yml',
  'homebrew-publish.yml',
  'nightly-e2e.yml',
  'pr-title.yml',
  'publish.yml',
  'release-please.yml',
  'scorecard.yml',
  'tmux-compat.yml',
];

const workflows = WORKFLOW_FILES
  .map((file) => readFileSync(resolve(WORKFLOW_DIR, file), 'utf8'))
  .join('\n');

describe('GitHub Actions upstream versions', () => {
  it.each([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020', 'v7.0.0'],
    ['actions/upload-artifact', 'b7c566a772e6b6bfb58ed0dc250532a479d7789f', 'v6.0.0'],
    ['pnpm/action-setup', '0977fd99725f1db4007ccb2928dbb4e90d06cc86', 'v6.0.10'],
    ['googleapis/release-please-action', '45996ed1f6d02564a971a2fa1b5860e934307cf7', 'v5.0.0'],
    ['github/codeql-action/init', 'db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28', 'v4.37.8'],
    ['ossf/scorecard-action', '2d1146689b8cda280b9bc96326124645441f03bc', 'v2.4.4'],
    ['amannn/action-semantic-pull-request', '48f256284bd46cdaab1048c3721360e808335d50', 'v6.1.1'],
  ])('pins %s to current upstream %s', (action, sha, version) => {
    expect(workflows).toContain(`${action}@${sha}`);
    expect(workflows).toContain(`# ${version}`);
  });

  it('does not retain superseded Node 20-era action pins', () => {
    for (const oldSha of [
      '34e114876b0b11c390a56381ad16ebd13914f8d5',
      '49933ea5288caeca8642d1e84afbd3f7d6820020',
      'ea165f8d65b6e75b540449e92b4886f43607fa02',
      'f40ffcd9367d9f12939873eb1018b921a783ffaa',
      'a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
      '4eaacf0543bb3f2c246792bd56e8cdeffafb205a',
    ]) {
      expect(workflows).not.toContain(oldSha);
    }
  });

  it('passes exact-floor tool paths through environment variables instead of shell templates', () => {
    const workflow = readFileSync(resolve(WORKFLOW_DIR, 'tmux-compat.yml'), 'utf8');

    expect(workflow).not.toContain('export PATH="${{ steps.floor.outputs.bin-dir }}:$PATH"');
    expect(workflow).not.toContain('"${{ steps.floor.outputs.tmux-bin }}"');
  });

  it('pins the release toolchain to current supported upstream versions', () => {
    const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const desktopPackage = JSON.parse(readFileSync(resolve('desktop', 'package.json'), 'utf8'));
    const workspace = readFileSync(resolve('pnpm-workspace.yaml'), 'utf8');

    expect(readFileSync(resolve('.nvmrc'), 'utf8').trim()).toBe('24.19.0');
    expect(rootPackage.packageManager).toBe('pnpm@11.22.0');
    expect(rootPackage.engines.node).toBe('>=24.19.0');
    expect(rootPackage.engines.pnpm).toBe('11.22.0');
    expect(rootPackage.devEngines).toEqual({
      runtime: {
        name: 'node',
        onFail: 'download',
        version: '24.19.0',
      },
    });
    expect(workspace).toMatch(/^nodeVersion: 24\.19\.0$/m);
    expect(rootPackage.devDependencies['@types/node']).toBe('^24.13.3');
    expect(rootPackage.devDependencies.yaml).toBe('^2.9.0');
    expect(desktopPackage.engines.node).toBe('>=24.19.0');
    expect(desktopPackage.devDependencies.electron).toBe('^43.4.1');
    expect(desktopPackage.devDependencies['@electron/notarize']).toBe('^3.1.1');
    // The desktop intentionally ships both macOS CPU-specific TypeScript
    // runtimes; pnpm's global engineStrict also rejects the non-host package.
    expect(workspace).not.toMatch(/^engineStrict: true$/m);
  });

  it('keeps public setup guidance aligned with the pinned toolchain', () => {
    const setupDocs = [
      readFileSync(resolve('README.md'), 'utf8'),
      readFileSync(resolve('CONTRIBUTING.md'), 'utf8'),
      readFileSync(resolve('Makefile'), 'utf8'),
    ].join('\n');

    expect(setupDocs).not.toMatch(/pnpm@10\.14\.0|11\.9\.0/);
    expect(setupDocs).toContain('Host Node.js >= 22.13');
    expect(setupDocs).toContain('24.19');
    expect(setupDocs).toContain('pnpm@11.22.0');
  });

  it('pins the patched nanoid line required by the full dependency audit', () => {
    const workspace = readFileSync(resolve('pnpm-workspace.yaml'), 'utf8');

    expect(workspace).toContain('nanoid: 3.3.18');
    expect(workspace).not.toContain('nanoid: 3.3.17');
  });
});
