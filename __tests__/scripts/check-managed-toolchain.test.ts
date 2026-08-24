import { describe, expect, it } from 'vitest';
import { validateManagedToolchain } from '../../scripts/check-managed-toolchain.mjs';

const requirements = {
  nodeVersion: '24.19.0',
  pnpmVersion: '11.22.0',
};

describe('managed toolchain validation', () => {
  it('accepts the exact lockfile-pinned Node and pnpm versions', () => {
    expect(() => validateManagedToolchain(requirements, requirements)).not.toThrow();
  });

  it('rejects execution outside the pnpm-managed Node runtime', () => {
    expect(() => validateManagedToolchain(
      { nodeVersion: '24.15.0', pnpmVersion: '11.22.0' },
      requirements,
    )).toThrow('Managed Node.js mismatch: running 24.15.0, expected 24.19.0');
  });

  it('rejects a package manager that bypassed the repository pin', () => {
    expect(() => validateManagedToolchain(
      { nodeVersion: '24.19.0', pnpmVersion: '11.21.0' },
      requirements,
    )).toThrow('Managed pnpm mismatch: running 11.21.0, expected 11.22.0');
  });
});
