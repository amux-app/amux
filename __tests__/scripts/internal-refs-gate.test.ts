import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'internal-refs-gate.mjs');
let fixtureRoot: string;

function runGate(env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--root', fixtureRoot], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUMX_PRIVATE_REF_PATTERNS: '',
      AUMX_PRIVATE_REF_PATTERNS_FILE: '',
      AUMX_REQUIRE_PRIVATE_REFS: '0',
      ...env,
    },
  });
}

function makeCommit(cwd: string, authorName: string, authorEmail: string, message = 'test commit') {
  execFileSync('git', ['add', '--all'], { cwd });
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    },
  });
}

describe('internal reference gate', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'amux-internal-refs-'));
    execFileSync('git', ['init', '-q'], { cwd: fixtureRoot });
    writeFileSync(join(fixtureRoot, 'clean.txt'), 'public content\n');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { force: true, recursive: true });
  });

  it('runs public rules when private configuration is unavailable', () => {
    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('ignores tracked files deleted by the pending change', () => {
    execFileSync('git', ['add', 'clean.txt'], { cwd: fixtureRoot });
    unlinkSync(join(fixtureRoot, 'clean.txt'));

    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('fails closed when an upstream job requires private configuration', () => {
    const result = runGate({ AUMX_REQUIRE_PRIVATE_REFS: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('required');
  });

  it('detects a planted private reference without echoing the configured value', () => {
    const privatePattern = ['private', 'marker', 'for', 'test'].join('-');
    writeFileSync(join(fixtureRoot, 'planted.txt'), `prefix ${privatePattern} suffix\n`);

    const result = runGate({
      AUMX_PRIVATE_REF_PATTERNS: JSON.stringify([privatePattern]),
      AUMX_REQUIRE_PRIVATE_REFS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('planted.txt:1');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(privatePattern);
  });

  it('fails when a source file carries a raw NUL byte instead of skipping it as binary', () => {
    writeFileSync(join(fixtureRoot, 'planted.ts'), 'export const value = 1;\n\0\n');

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('raw NUL byte in source file');
    expect(result.stderr).toContain('planted.ts [raw-nul-in-source]');
  });

  it('still reports a credential a NUL byte would previously have concealed', () => {
    const credential = `${['api', 'key'].join('_')}="${'A'.repeat(32)}"`;
    writeFileSync(join(fixtureRoot, 'planted.ts'), `\0\nexport const token = ${credential};\n`);

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('planted.ts [raw-nul-in-source]');
    expect(result.stderr).toContain('planted.ts:2 [credential-assignment]');
  });

  it('keeps skipping genuine binaries', () => {
    const privateHost = ['service', 'example', 'internal'].join('.');
    writeFileSync(join(fixtureRoot, 'icon.png'), `\0PNG\0https://${privateHost}/api\n`);

    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('detects generic private hosts without publishing matched content', () => {
    const privateHost = ['service', 'example', 'internal'].join('.');
    writeFileSync(join(fixtureRoot, 'host.txt'), `https://${privateHost}/api\n`);

    const result = runGate();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('host.txt:1');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(privateHost);
  });

  it('detects a self-hosted forge host while allowing the public forge', () => {
    writeFileSync(join(fixtureRoot, 'clone.txt'), `git clone https://${['github', 'acme', 'com'].join('.')}/org/repo\n`);
    writeFileSync(join(fixtureRoot, 'public.txt'), `git clone https://${['github', 'com'].join('.')}/org/repo\n`);

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('clone.txt:1 [enterprise-forge-host]');
    expect(result.stderr).not.toContain('public.txt');
  });

  it('detects a corporate domain as a bare host and as an e-mail domain', () => {
    writeFileSync(join(fixtureRoot, 'host.txt'), `internal host ${['wdf', 'sap'].join('.')}\n`);
    writeFileSync(join(fixtureRoot, 'author.txt'), `author first.last@${['sap', 'com'].join('.')}\n`);
    writeFileSync(join(fixtureRoot, 'public.txt'), 'contact first.last@example.com\n');

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.txt:1 [corporate-domain]');
    expect(result.stderr).toContain('author.txt:1 [corporate-domain]');
    expect(result.stderr).not.toContain('public.txt');
  });

  it('ignores workflow expressions that look like forge hostnames', () => {
    writeFileSync(join(fixtureRoot, 'workflow.yml'), 'group: ${{ github.workflow }}-${{ github.event.pull_request.number }}\n');

    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  describe('git author/committer metadata scanning', () => {
    it('fails when a commit author email matches a corporate-domain rule', () => {
      // Arrange: repo with a commit carrying a corporate author email
      const corporateEmail = ['x', '@', 'sap', '.com'].join('');
      makeCommit(fixtureRoot, 'Some Dev', corporateEmail);

      // Act
      const result = runGate();

      // Assert: gate fails and the finding references a git-commit path
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/<git-commit [0-9a-f]{7} author-email>:0 \[corporate-domain\]/);
    });

    it('fails when a commit author name matches a configured private pattern', () => {
      // Arrange: repo with a commit whose author name contains a private username
      const privateUsername = 'private-handle-42';
      makeCommit(fixtureRoot, privateUsername, 'dev@example.com');

      // Act
      const result = runGate({
        AUMX_PRIVATE_REF_PATTERNS: JSON.stringify([privateUsername]),
      });

      // Assert: gate fails and the finding references a git-commit path
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/<git-commit [0-9a-f]{7} author-name>:0 \[private-rule\]/);
    });

    it('stays clean when all commits have neutral public author metadata', () => {
      // Arrange: repo with a commit that has no matching patterns
      makeCommit(fixtureRoot, 'Dev Bot', 'dev@example.com');

      // Act
      const result = runGate();

      // Assert: gate remains green
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('clean');
    });
  });
});
