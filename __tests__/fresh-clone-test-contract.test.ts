import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('fresh-clone test contract', () => {
  it('generates source documentation before the root test suite', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.pretest).toBe('pnpm run generate:hooks-docs');
  });

  it('keeps desktop build-output assertions conditional on an actual build', () => {
    const buildTest = readFileSync(new URL('../desktop/__tests__/build.test.ts', import.meta.url), 'utf8');
    expect(buildTest).toContain('if (HAS_BUILD_OUTPUT)');
    expect(buildTest).toContain('is deferred until the desktop build command runs');
  });
});
