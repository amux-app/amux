import type { GitStatusResponse } from '../../../shared/ipc-types.js';
import type { WorkingTreeDiffData } from './gitDiffParser.js';

export function buildGitStatusResponse(
  workingTreeDiff: WorkingTreeDiffData,
  commitsAhead: number | null,
): GitStatusResponse {
  return {
    hasChanges: workingTreeDiff.filesChanged > 0,
    commitsAhead,
    filesChanged: workingTreeDiff.filesChanged,
    insertions: workingTreeDiff.insertions,
    deletions: workingTreeDiff.deletions,
  };
}
