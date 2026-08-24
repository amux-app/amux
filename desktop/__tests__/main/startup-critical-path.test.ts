import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_SOURCE = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8');

describe('startup critical path', () => {
  it('does not await best-effort detached PTY cleanup before declaring readiness', () => {
    expect(MAIN_SOURCE).toContain("void cleanupDetachedPtyViewSessions('startup');");
    expect(MAIN_SOURCE).not.toMatch(
      /Promise\.all\(\[\s*validateRequiredSystemRequirements\(\),\s*cleanupDetachedPtyViewSessions\('startup'\)/,
    );
  });
});
