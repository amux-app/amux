import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT_DIR = resolve(__dirname, '..', '..');

describe('CI workflow contracts', () => {
  it('runs each coverage suite once and keeps pull-request macOS testing focused', () => {
    const workflow = readFileSync(resolve(ROOT_DIR, '.github', 'workflows', 'ci.yml'), 'utf8');
    const parsed = parse(workflow) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string }> }>;
    };
    const qualitySteps = parsed.jobs.quality?.steps ?? [];
    const macSteps = parsed.jobs['desktop-smoke']?.steps ?? [];
    const configureIndex = workflow.indexOf('- name: Configure isolated tmux server');
    const startIndex = workflow.indexOf('- name: Start isolated tmux server');
    const checkIndex = workflow.indexOf('- name: Enforce minimum tmux version');
    const buildIndex = workflow.indexOf('- name: Build desktop application');
    const smokeIndex = workflow.indexOf('run: pnpm --filter muxbase-desktop test:smoke');
    const visualArtifactIndex = workflow.indexOf('- name: Upload visual regression failures');
    const cleanupIndex = workflow.indexOf('- name: Tear down isolated tmux server');

    expect(qualitySteps.map((step) => step.name)).toEqual([
      undefined,
      'Install system dependencies',
      'Install pnpm',
      'Setup Node',
      'Install dependencies',
      'Static verification',
      'Desktop type check',
      'Core coverage',
      'Desktop coverage',
    ]);
    expect(qualitySteps.filter((step) => step.run === 'pnpm test:coverage')).toHaveLength(1);
    expect(
      qualitySteps.filter((step) => step.run?.includes('muxbase-desktop test:coverage')),
    ).toHaveLength(1);
    expect(qualitySteps.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(false);
    expect(macSteps.some((step) => step.run?.includes('release:verify'))).toBe(false);
    expect(configureIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(configureIndex);
    expect(checkIndex).toBeGreaterThan(startIndex);
    expect(buildIndex).toBeGreaterThan(checkIndex);
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    expect(visualArtifactIndex).toBeGreaterThan(smokeIndex);
    expect(cleanupIndex).toBeGreaterThan(smokeIndex);
    expect(macSteps.find((step) => step.name === 'Upload visual regression failures')).toMatchObject({
      uses: expect.stringMatching(/^actions\/upload-artifact@[a-f0-9]{40}$/),
    });
    expect(workflow.slice(visualArtifactIndex, cleanupIndex)).toContain('if: failure()');
    expect(workflow.slice(visualArtifactIndex, cleanupIndex)).toContain('desktop/out/visual-regression/*.png');
    expect(workflow.slice(cleanupIndex)).toContain('if: always()');
    expect(workflow).not.toMatch(/new-session[^\n]*-s muxbase-/);
  });

  it('runs only the exact-floor compatibility matrix weekly and for relevant pull requests', () => {
    const workflow = readFileSync(resolve(ROOT_DIR, '.github', 'workflows', 'tmux-compat.yml'), 'utf8');
    const provisioner = readFileSync(resolve(ROOT_DIR, 'scripts', 'ci', 'provision-tmux-floor.mjs'), 'utf8');
    const exactJob = workflow.match(/exact-floor:([\s\S]*)/)?.[1];

    expect(workflow).toContain("cron: '23 6 * * 1'");
    expect(workflow).not.toContain('current-stable:');
    expect(exactJob).toBeDefined();
    expect(exactJob?.indexOf('Start exact-floor isolated tmux server')).toBeLessThan(
      exactJob?.indexOf('node scripts/ensure-tmux.mjs --check') ?? -1,
    );
    expect(provisioner).toContain('TMUX_TMPDIR=${socketDir}');
    expect(provisioner).toContain('tmux-version=${version}');
    expect(exactJob).toContain('MUXBASE_E2E_EXPECT_TMUX_VERSION: ${{ steps.floor.outputs.tmux-version }}');
    expect(exactJob).toContain('SHELL: /bin/sh');
    expect(workflow).not.toMatch(/new-session[^\n]*-s muxbase-/);
  });

  it('uses current CodeQL actions and avoids redundant scheduled security workflows', () => {
    const codeql = readFileSync(resolve(ROOT_DIR, '.github', 'workflows', 'codeql.yml'), 'utf8');
    const scorecard = readFileSync(resolve(ROOT_DIR, '.github', 'workflows', 'scorecard.yml'), 'utf8');

    expect(codeql).toContain('github/codeql-action/init@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4.37.8');
    expect(codeql).toContain('github/codeql-action/analyze@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4.37.8');
    expect(codeql).not.toContain('matrix:');
    expect(scorecard).toContain('github/codeql-action/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4.37.8');
    expect(scorecard).not.toMatch(/^ {2}push:/m);
    expect(existsSync(resolve(ROOT_DIR, '.github', 'workflows', 'dependency-audit.yml'))).toBe(false);
    expect(existsSync(resolve(ROOT_DIR, '.github', 'workflows', 'secret-scan.yml'))).toBe(false);
  });

  it('keeps Dependabot workspace and GitHub Actions updates consolidated', () => {
    const config = parse(readFileSync(resolve(ROOT_DIR, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: Array<{
        'package-ecosystem': string;
        directory: string;
        groups?: Record<string, { patterns?: string[] }>;
      }>;
    };
    const npmUpdates = config.updates.filter((update) => update['package-ecosystem'] === 'npm');
    const actionUpdates = config.updates.find(
      (update) => update['package-ecosystem'] === 'github-actions',
    );

    expect(npmUpdates).toHaveLength(1);
    expect(npmUpdates[0]?.directory).toBe('/');
    expect(actionUpdates?.groups).toEqual({ all: { patterns: ['*'] } });
  });

  it('runs credential-free deterministic release verification nightly', () => {
    const workflow = readFileSync(resolve(ROOT_DIR, '.github', 'workflows', 'nightly-e2e.yml'), 'utf8');
    const workflowPermissions = workflow.match(/^permissions:([\s\S]*?)^concurrency:/m)?.[1];
    const e2eJob = workflow.match(/^ {2}e2e:([\s\S]*)/m)?.[1];

    expect(workflowPermissions).toContain('contents: read');
    expect(e2eJob).toContain('permissions:\n      contents: read');
    expect(e2eJob).toContain('run: pnpm release:verify');
    expect(e2eJob).not.toContain('pnpm --filter muxbase-desktop release:verify');
    expect(workflow).not.toContain('API_KEY');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('agent-compatibility');
    expect(workflow).not.toContain('issues: write');
    expect(workflow).not.toContain('npm install "${install_flags[@]}"');
    expect(workflow).not.toContain('curl -fsSL https://claude.ai/install.sh');
  });

});
