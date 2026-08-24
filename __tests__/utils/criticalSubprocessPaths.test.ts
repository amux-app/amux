import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const criticalModules = [
  'src/utils/aiCli.ts',
  'src/utils/aiMerge.ts',
  'src/utils/conflictMonitor.ts',
  'src/utils/conflictResolutionPane.ts',
  'src/utils/gitMergeOps.ts',
  'src/utils/mergeValidation.ts',
  'src/utils/paneCreation.ts',
  'src/utils/paneCreationRollback.ts',
  'src/utils/paneWorktree.ts',
  'src/utils/tmuxTranscript.ts',
  'src/utils/worktreeDiscovery.ts',
] as const;

describe('critical subprocess paths', () => {
  it.each(criticalModules)('%s does not call a synchronous child process API', (modulePath) => {
    const source = readFileSync(resolve(process.cwd(), modulePath), 'utf8');

    expect(source).not.toMatch(
      /\b(?:execFileSync|execSync|getPaneSessionNameSync|newWindowPaneSync|spawnSync)\b/,
    );
  });
});
