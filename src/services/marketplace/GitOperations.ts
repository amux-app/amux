import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { canonicalizeSourceUrl } from './sourceIdentity.js';
import { assertSafeCloneTarget } from './urlSafety.js';

const RENAME_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

const execFileAsync = promisify(execFile);

export class GitOperations {
  async clone(url: string, targetPath: string): Promise<void> {
    if (existsSync(targetPath)) {
      return;
    }
    await this.cloneAtomic(url, targetPath);
  }

  async ensureClone(url: string, targetPath: string): Promise<string> {
    if (existsSync(targetPath) && (await this.originMatches(url, targetPath))) {
      return this.getHeadSha(targetPath);
    }
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    await this.cloneAtomic(url, targetPath);
    return this.getHeadSha(targetPath);
  }

  async pull(clonePath: string): Promise<void> {
    await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: clonePath,
      timeout: 30000,
    });
  }

  async getRemoteOriginUrl(clonePath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: clonePath,
      timeout: 10000,
    });
    return stdout.trim();
  }

  async getHeadSha(clonePath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: clonePath,
      timeout: 10000,
    });
    return stdout.trim();
  }

  async getLastCommitDate(clonePath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI'], {
      cwd: clonePath,
      timeout: 10000,
    });
    return stdout.trim();
  }

  // Committer date (ISO 8601) of the most recent commit that touched `filePath`.
  // `filePath` may be absolute or relative to the clone. Returns '' when the path
  // has no commit history (untracked, or a shallow clone that didn't fetch it).
  async getFileCommitDate(clonePath: string, filePath: string): Promise<string> {
    const rel = path.isAbsolute(filePath) ? path.relative(clonePath, filePath) : filePath;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '-1', '--format=%cI', '--', rel],
        { cwd: clonePath, timeout: 10000 },
      );
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async originMatches(url: string, clonePath: string): Promise<boolean> {
    const origin = await this.getRemoteOriginUrl(clonePath);
    try {
      return canonicalizeSourceUrl(origin) === canonicalizeSourceUrl(url);
    } catch {
      return false;
    }
  }

  private async cloneAtomic(url: string, targetPath: string): Promise<void> {
    // Authoritative DNS-resolution guard on the exact host about to be cloned.
    await assertSafeCloneTarget(url);
    const parentDir = path.dirname(targetPath);
    mkdirSync(parentDir, { recursive: true });
    const tempPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--', url, tempPath], { timeout: 60000 });
      await this.commitClone(url, tempPath, targetPath);
    } catch (error) {
      rmSync(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  // Rename the temp clone into place. A concurrent add for the same URL may have won the race
  // and already created the target — if its origin matches ours, treat it as a benign
  // concurrent-win: drop our temp and keep the existing clone instead of surfacing ENOTEMPTY.
  private async commitClone(url: string, tempPath: string, targetPath: string): Promise<void> {
    try {
      renameSync(tempPath, targetPath);
    } catch (error) {
      const collided = RENAME_COLLISION_CODES.has(errorCode(error) ?? '');
      if (collided && (await this.originMatches(url, targetPath))) {
        rmSync(tempPath, { recursive: true, force: true });
        return;
      }
      throw error;
    }
  }
}
