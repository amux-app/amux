import { existsSync, unlinkSync } from 'fs';
import { LogService } from '../services/LogService.js';
import { removeMuxBasePane } from './muxbaseConfigMutation.js';
import { execFileAsync } from './execAsync.js';

interface RollbackStep {
  label: string;
  run: () => Promise<void> | void;
}

interface WorktreeRollbackOptions {
  branchName?: string;
  deleteBranch: boolean;
  projectRoot: string;
  worktreePath: string;
}

export class PaneCreationRollback {
  private enabled = true;
  private steps: RollbackStep[] = [];

  constructor(private readonly logger = LogService.getInstance()) {}

  disarm(): void {
    this.enabled = false;
    this.steps = [];
  }

  trackConfigPane(configPath: string, paneId: string): void {
    this.add(`config pane ${paneId}`, () => {
      if (!existsSync(configPath)) return;
      removeMuxBasePane(configPath, paneId);
    });
  }

  trackCallback(label: string, run: () => void): void {
    this.add(label, run);
  }

  trackTmuxPane(paneId: string): void {
    this.add(`tmux pane ${paneId}`, async () => {
      await execFileAsync('tmux', ['kill-pane', '-t', paneId], { timeout: 5000 });
    });
  }

  trackTranscript(transcriptPath: string): void {
    this.add(`transcript ${transcriptPath}`, () => {
      if (existsSync(transcriptPath)) {
        unlinkSync(transcriptPath);
      }
    });
  }

  trackWorktree(options: WorktreeRollbackOptions): void {
    const { branchName, deleteBranch, projectRoot, worktreePath } = options;
    this.add(`worktree ${worktreePath}`, async () => {
      if (existsSync(worktreePath)) {
        await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
          cwd: projectRoot,
          timeout: 30000,
        });
      }

      if (deleteBranch && branchName) {
        await execFileAsync('git', ['branch', '-D', branchName], {
          cwd: projectRoot,
          timeout: 10000,
        });
      }
    });
  }

  async run(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;

    const steps = [...this.steps].reverse();
    this.steps = [];
    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        this.logger.warn(
          `Pane creation rollback failed for ${step.label}: ${error instanceof Error ? error.message : String(error)}`,
          'paneCreation',
        );
      }
    }
  }

  private add(label: string, run: () => Promise<void> | void): void {
    if (this.enabled) {
      this.steps.push({ label, run });
    }
  }
}
