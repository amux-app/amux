import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('atomic update publication workflow', () => {
  it('configures Release Please to create a forced-tag draft', () => {
    const config = JSON.parse(readFileSync(resolve('release-please-config.json'), 'utf8'));
    expect(config.draft).toBe(true);
    expect(config['force-tag-creation']).toBe(true);
    expect(config.packages['.']).not.toHaveProperty('release-as');

    const workflow = readFileSync(resolve('.github/workflows/release-please.yml'), 'utf8');
    expect(workflow).toContain('googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7');
    expect(workflow).toContain('# v5.0.0');
  });

  it('uploads and audits an exact draft asset set before one-way publication', () => {
    const workflow = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
    const uploadIndex = workflow.indexOf('name: Upload exact asset set to draft');
    const auditIndex = workflow.indexOf('name: Audit uploaded draft');
    const publishIndex = workflow.indexOf('name: Publish verified draft');

    expect(workflow).toContain('"$GITHUB_REPOSITORY" != "amux-app/amux"');
    expect(workflow).toContain('group: publish-release-${{ github.repository }}');
    expect(workflow).toContain(".draft == true");
    expect(workflow).toContain('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6');
    expect(workflow).not.toContain('actions/attest-build-provenance');
    expect(workflow).not.toContain('continue-on-error: true');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).toContain('cd "$release_dir"');
    expect(workflow).toContain('shasum -a 256 "${checksum_names[@]}" > SHA256SUMS');
    expect(workflow).not.toContain('shasum -a 256 "${checksum_inputs[@]}"');
    expect(uploadIndex).toBeGreaterThan(0);
    expect(auditIndex).toBeGreaterThan(uploadIndex);
    expect(publishIndex).toBeGreaterThan(auditIndex);
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --draft=false --latest');
    expect(workflow.indexOf('homebrew-publish:')).toBeGreaterThan(publishIndex);
  });

  it('grants the reusable publisher its complete least-privilege token ceiling', () => {
    const workflow = readFileSync(resolve('.github/workflows/release-please.yml'), 'utf8');
    const publishJob = workflow.match(/ {2}publish:([\s\S]*)/)?.[1];

    expect(publishJob).toBeDefined();
    expect(publishJob).toContain('attestations: write');
    expect(publishJob).toContain('contents: write');
    expect(publishJob).toContain('id-token: write');
    expect(publishJob).not.toContain('secrets: inherit');
    expect(workflow).toContain('APPLE_CERTIFICATE_BASE64: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}');
    expect(workflow).toContain('HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}');
  });

  it('keeps credentials step-scoped and binds a pnpm-compatible SBOM to release binaries', () => {
    const workflow = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
    const publishJobEnv = workflow.match(/ {2}publish:[\s\S]*? {4}env:\n([\s\S]*?) {4}outputs:/)?.[1];
    const sensitiveNames = [
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_CERTIFICATE_BASE64',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_ID',
      'APPLE_KEYCHAIN_PASSWORD',
      'APPLE_SIGN_IDENTITY',
      'APPLE_TEAM_ID',
    ];

    expect(publishJobEnv).toBeDefined();
    for (const name of sensitiveNames) expect(publishJobEnv).not.toContain(name);
    expect(workflow).toContain('anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610');
    expect(workflow).toContain('format: cyclonedx-json');
    expect(workflow).toContain('sbom-path: desktop/release/amux-sbom.cdx.json');
    expect(workflow).toContain('name: Attest SBOM document provenance');
    expect(workflow).toContain('subject-path: desktop/release/amux-sbom.cdx.json');
    expect(workflow).not.toContain('@cyclonedx/cyclonedx-npm');
    expect(workflow).toContain("jq -e '.private == false'");
  });

  it('keeps Homebrew publication independently retryable after the GitHub release is public', () => {
    const publishWorkflow = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
    const homebrewWorkflow = readFileSync(resolve('.github/workflows/homebrew-publish.yml'), 'utf8');
    const checkoutIndex = homebrewWorkflow.indexOf('uses: actions/checkout@');
    const preCheckout = homebrewWorkflow.slice(0, checkoutIndex);

    expect(publishWorkflow).toContain('uses: ./.github/workflows/homebrew-publish.yml');
    expect(publishWorkflow).not.toContain('  cask-publish:');
    expect(homebrewWorkflow).toContain('workflow_call:');
    expect(homebrewWorkflow).toContain('workflow_dispatch:');
    expect(homebrewWorkflow).toContain('  cask-publish:');
    expect(homebrewWorkflow).toContain('  cask-smoke:');
    expect(homebrewWorkflow).toContain(
      'gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft',
    );
    expect(checkoutIndex).toBeGreaterThan(0);
    expect(preCheckout).toContain('gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"');
  });
});
