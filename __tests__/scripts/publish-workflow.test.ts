import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('binary publish workflow', () => {
  it('passes the release signing identity through electron-builder CSC_NAME', () => {
    const builderConfig = readFileSync('desktop/electron-builder.yml', 'utf8');
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');

    expect(builderConfig).not.toMatch(/^\s*identity:/m);
    expect(workflow).toContain('CSC_NAME: ${{ secrets.APPLE_SIGN_IDENTITY }}');
  });

  it('isolates the preflight package smoke from release signing and notarization', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
    const preflightStart = workflow.indexOf('- name: Configure isolated tmux server');
    const serverStart = workflow.indexOf('- name: Start isolated tmux server');
    const versionCheck = workflow.indexOf('- name: Enforce minimum tmux version');
    const releaseCheck = workflow.indexOf('- name: Verify release candidate');
    const serverCleanup = workflow.indexOf('- name: Tear down isolated tmux server');
    const signingStart = workflow.indexOf('- name: Import Apple signing certificate');
    const preflight = workflow.match(
      /- name: Verify release candidate([\s\S]*?)- name: Import Apple signing certificate/,
    )?.[1];

    expect(preflightStart).toBeGreaterThan(-1);
    expect(serverStart).toBeGreaterThan(preflightStart);
    expect(versionCheck).toBeGreaterThan(serverStart);
    expect(releaseCheck).toBeGreaterThan(versionCheck);
    expect(serverCleanup).toBeGreaterThan(releaseCheck);
    expect(signingStart).toBeGreaterThan(serverCleanup);
    expect(workflow.slice(serverCleanup, signingStart)).toContain('if: always()');
    expect(workflow).not.toMatch(/new-session[^\n]*-s aumx-/);
    expect(preflight).toBeDefined();
    expect(preflight).toContain('run: pnpm release:verify');
    expect(preflight).toContain("AUMX_REQUIRE_NOTARIZATION: '0'");
    expect(preflight).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(preflight).toContain("CSC_NAME: ''");
    expect(preflight).toContain("APPLE_ID: ''");
    expect(preflight).toContain("APPLE_APP_SPECIFIC_PASSWORD: ''");
    expect(preflight).toContain("APPLE_NOTARY_PROFILE: ''");
    expect(preflight).toContain("APPLE_TEAM_ID: ''");
  });

  it('keeps release publication self-contained without a prerequisite nightly run', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
    const caller = readFileSync('.github/workflows/release-please.yml', 'utf8');

    expect(workflow).not.toContain('Require successful nightly release verification');
    expect(workflow).not.toContain('/actions/workflows/nightly-e2e.yml/runs');
    expect(workflow).toContain('- name: Verify release candidate');
    expect(workflow).toContain('run: pnpm release:verify');
    expect(workflow.match(/^ {2}publish:([\s\S]*?)^ {2}homebrew-publish:/m)?.[1]).not.toContain(
      'actions: read',
    );
    expect(caller.match(/^ {2}publish:([\s\S]*)/m)?.[1]).not.toContain('actions: read');
  });

  it('keeps the release verification command single-pass', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['verify:static']).toBeDefined();
    expect(packageJson.scripts['release:verify']).toBe('pnpm run audit:all && pnpm run verify');
    expect(packageJson.scripts['desktop:release:verify']).toBe(
      'pnpm --filter aumx-desktop release:verify',
    );
  });

  it('fails closed when Homebrew tap credentials are unavailable', () => {
    const workflow = readFileSync('.github/workflows/homebrew-publish.yml', 'utf8');

    expect(workflow).toContain('HOMEBREW_TAP_TOKEN is required for binary publication.');
    expect(workflow).toContain("repository: amux-app/homebrew-amux");
    expect(workflow).not.toContain('skipping cask publish');
    expect(workflow).not.toContain('steps.gate.outputs.skip');
  });
});
