import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { MarketplaceIntegrityError } from './MarketplaceErrors.js';

export { MarketplaceIntegrityError } from './MarketplaceErrors.js';
export type { MarketplaceIntegrityErrorCode } from './MarketplaceErrors.js';

export interface MarketplaceMutation {
  path: string;
  kind: 'file' | 'directory';
  /** `null` removes an owned destination. */
  content?: Buffer;
  sourcePath?: string;
  expectedDigest: string | null;
}

interface JournalOperation {
  path: string;
  kind: MarketplaceMutation['kind'];
  expectedDigest: string | null;
  stagedPath?: string;
  stagedDigest?: string;
  backupPath?: string;
  state: 'pending' | 'backed-up' | 'replaced' | 'rolled-back';
}

interface Journal {
  version: 1;
  transactionId: string;
  state: 'applying' | 'committed';
  operations: JournalOperation[];
}

export interface MarketplaceTransactionOptions {
  journalDir: string;
  transactionId?: string;
  /** Test-only fault injection, counted after successful replacements. */
  failAfterApply?: number;
  /** Test-only: retain the journal and backups after rollback. */
  preserveJournalOnFailure?: boolean;
  /** Test-only: simulate process termination before rollback. */
  skipRollbackOnFailure?: boolean;
}

export interface MarketplaceRecoveryResult {
  recovered: number;
  rollbackFailures: string[];
}

function hashBytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function addDirectoryDigestParts(root: string, relativePath: string, parts: string[]): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`Marketplace artifact symlinks are not allowed: ${root}`);
  if (stat.isFile()) {
    parts.push(`file:${relativePath}:${hashBytes(readFileSync(root))}`);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported marketplace artifact type: ${root}`);
  parts.push(`directory:${relativePath}`);
  for (const entry of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    addDirectoryDigestParts(path.join(root, entry), path.join(relativePath, entry), parts);
  }
}

/** Returns `null` when the path does not exist and rejects symlink artifacts. */
export function digestPath(targetPath: string): string | null {
  if (!existsSync(targetPath)) return null;
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`Marketplace artifact symlinks are not allowed: ${targetPath}`);
  if (stat.isFile()) return hashBytes(readFileSync(targetPath));
  if (!stat.isDirectory()) throw new Error(`Unsupported marketplace artifact type: ${targetPath}`);
  const parts: string[] = [];
  addDirectoryDigestParts(targetPath, '.', parts);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function assertCompatibleMutation(mutation: MarketplaceMutation): void {
  if (mutation.content && mutation.sourcePath) {
    throw new Error(`Marketplace mutation cannot have both content and source: ${mutation.path}`);
  }
  if (mutation.content && mutation.kind !== 'file') {
    throw new Error(`Directory marketplace mutation requires a source path: ${mutation.path}`);
  }
  if (!mutation.content && !mutation.sourcePath && mutation.expectedDigest === null) {
    throw new Error(`Marketplace deletion needs ownership evidence: ${mutation.path}`);
  }
  if (mutation.sourcePath) {
    const sourceStat = lstatSync(mutation.sourcePath);
    if (sourceStat.isSymbolicLink()) throw new Error(`Marketplace artifact symlinks are not allowed: ${mutation.sourcePath}`);
    if ((mutation.kind === 'file') !== sourceStat.isFile()) {
      throw new Error(`Marketplace mutation type does not match source: ${mutation.sourcePath}`);
    }
  }
}

export class MarketplaceTransaction {
  private readonly failAfterApply?: number;
  private readonly journalDir: string;
  private readonly preserveJournalOnFailure: boolean;
  private readonly skipRollbackOnFailure: boolean;
  private readonly transactionId: string;

  constructor(options: MarketplaceTransactionOptions) {
    this.failAfterApply = options.failAfterApply;
    this.journalDir = options.journalDir;
    this.preserveJournalOnFailure = options.preserveJournalOnFailure ?? false;
    this.skipRollbackOnFailure = options.skipRollbackOnFailure ?? false;
    this.transactionId = options.transactionId ?? randomUUID();
  }

  get id(): string {
    return this.transactionId;
  }

  execute(mutations: MarketplaceMutation[]): void {
    if (mutations.length === 0) return;
    const uniquePaths = new Set<string>();
    for (const mutation of mutations) {
      if (uniquePaths.has(mutation.path)) throw new Error(`Duplicate marketplace mutation: ${mutation.path}`);
      uniquePaths.add(mutation.path);
      assertCompatibleMutation(mutation);
      this.assertExpectedDigest(mutation);
    }

    const transactionsDir = path.join(this.journalDir, 'transactions');
    const journalPath = path.join(transactionsDir, `${this.transactionId}.json`);
    mkdirSync(transactionsDir, { recursive: true });

    const journal: Journal = {
      version: 1,
      transactionId: this.transactionId,
      state: 'applying',
      operations: mutations.map((mutation, index) => ({
        path: mutation.path,
        kind: mutation.kind,
        expectedDigest: mutation.expectedDigest,
        ...(mutation.content || mutation.sourcePath ? {
          stagedPath: path.join(path.dirname(mutation.path), `.${path.basename(mutation.path)}.muxbase-stage-${this.transactionId}-${index}`),
        } : {}),
        ...(existsSync(mutation.path) ? {
          backupPath: path.join(path.dirname(mutation.path), `.${path.basename(mutation.path)}.muxbase-backup-${this.transactionId}-${index}`),
        } : {}),
        state: 'pending',
      })),
    };

    try {
      mutations.forEach((mutation, index) => {
        const operation = journal.operations[index];
        this.stage(mutation, operation.stagedPath);
        if (operation.stagedPath) {
          const stagedDigest = digestPath(operation.stagedPath);
          if (stagedDigest === null) throw new Error(`Marketplace staging failed: ${operation.path}`);
          operation.stagedDigest = stagedDigest;
        }
      });
      this.writeJournal(journalPath, journal);

      let applied = 0;
      for (const operation of journal.operations) {
        this.apply(operation, journalPath, journal);
        applied += 1;
        if (this.failAfterApply !== undefined && applied >= this.failAfterApply) {
          throw new Error('Injected marketplace transaction failure');
        }
      }

      journal.state = 'committed';
      this.writeJournal(journalPath, journal);
      this.cleanupOperationFiles(journal.operations);
      rmSync(journalPath, { force: true });
    } catch (error) {
      const rollbackFailures = this.skipRollbackOnFailure ? [] : this.rollback(journal, journalPath);
      if (!this.preserveJournalOnFailure && !this.skipRollbackOnFailure && rollbackFailures.length === 0) {
        this.cleanupOperationFiles(journal.operations);
        rmSync(journalPath, { force: true });
      }
      if (rollbackFailures.length > 0) {
        throw new MarketplaceIntegrityError(
          'ROLLBACK_FAILED',
          `Could not restore ${rollbackFailures.join(', ')}`,
          rollbackFailures[0],
          rollbackFailures,
        );
      }
      throw error;
    }
  }

  static recover(journalDir: string): MarketplaceRecoveryResult {
    const transactionsDir = path.join(journalDir, 'transactions');
    if (!existsSync(transactionsDir)) return { recovered: 0, rollbackFailures: [] };
    const rollbackFailures: string[] = [];
    let recovered = 0;
    for (const journalName of readdirSync(transactionsDir).filter((entry) => entry.endsWith('.json'))) {
      const journalPath = path.join(transactionsDir, journalName);
      const failureCountBeforeJournal = rollbackFailures.length;
      try {
        const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal;
        if (journal.version !== 1 || !Array.isArray(journal.operations)) {
          rollbackFailures.push(journalPath);
          continue;
        }
        if (journal.state !== 'committed') {
          const failures = new MarketplaceTransaction({ journalDir, transactionId: journal.transactionId })
            .rollback(journal, journalPath);
          rollbackFailures.push(...failures);
          recovered += 1;
        }
        if (rollbackFailures.length === failureCountBeforeJournal) {
          new MarketplaceTransaction({ journalDir, transactionId: journal.transactionId })
            .cleanupOperationFiles(journal.operations);
          rmSync(journalPath, { force: true });
        }
      } catch {
        rollbackFailures.push(journalPath);
      }
    }
    return { recovered, rollbackFailures };
  }

  private assertExpectedDigest(mutation: MarketplaceMutation): void {
    const currentDigest = digestPath(mutation.path);
    if (currentDigest !== mutation.expectedDigest) {
      throw new MarketplaceIntegrityError(
        'CONCURRENT_MODIFICATION',
        `Destination changed before apply: ${mutation.path}`,
        mutation.path,
      );
    }
  }

  private stage(mutation: MarketplaceMutation, stagedPath?: string): void {
    if (!stagedPath) return;
    mkdirSync(path.dirname(stagedPath), { recursive: true });
    if (mutation.content) {
      writeFileSync(stagedPath, mutation.content);
      return;
    }
    if (mutation.sourcePath) {
      if (mutation.kind === 'file') copyFileSync(mutation.sourcePath, stagedPath);
      else cpSync(mutation.sourcePath, stagedPath, { recursive: true, dereference: false });
    }
  }

  private apply(operation: JournalOperation, journalPath: string, journal: Journal): void {
    const currentDigest = digestPath(operation.path);
    if (currentDigest !== operation.expectedDigest) {
      throw new MarketplaceIntegrityError(
        'CONCURRENT_MODIFICATION',
        `Destination changed during apply: ${operation.path}`,
        operation.path,
      );
    }
    mkdirSync(path.dirname(operation.path), { recursive: true });
    if (operation.backupPath) {
      mkdirSync(path.dirname(operation.backupPath), { recursive: true });
      renameSync(operation.path, operation.backupPath);
      operation.state = 'backed-up';
      this.writeJournal(journalPath, journal);
    }
    if (operation.stagedPath) {
      renameSync(operation.stagedPath, operation.path);
    }
    operation.state = 'replaced';
    this.writeJournal(journalPath, journal);
  }

  private rollback(journal: Journal, journalPath: string): string[] {
    const failures: string[] = [];
    for (const operation of [...journal.operations].reverse()) {
      if (operation.state === 'rolled-back') continue;
      try {
        if (operation.backupPath) {
          const backupDigest = digestPath(operation.backupPath);
          if (backupDigest !== null) {
            if (backupDigest !== operation.expectedDigest) {
              throw new Error(`Marketplace backup changed before rollback: ${operation.backupPath}`);
            }
            const targetDigest = digestPath(operation.path);
            if (targetDigest !== null) {
              if (targetDigest !== operation.stagedDigest) {
                throw new Error(`Marketplace destination changed before rollback: ${operation.path}`);
              }
              rmSync(operation.path, { force: true, recursive: true });
            }
            mkdirSync(path.dirname(operation.path), { recursive: true });
            renameSync(operation.backupPath, operation.path);
          } else if (digestPath(operation.path) !== operation.expectedDigest) {
            throw new Error(`Marketplace destination cannot be safely restored: ${operation.path}`);
          }
        } else {
          const targetDigest = digestPath(operation.path);
          if (targetDigest !== null) {
            if (targetDigest !== operation.stagedDigest) {
              throw new Error(`Marketplace destination changed before rollback: ${operation.path}`);
            }
            rmSync(operation.path, { force: true, recursive: true });
          }
        }
        operation.state = 'rolled-back';
        this.writeJournal(journalPath, journal);
      } catch {
        failures.push(operation.path);
      }
    }
    return failures;
  }

  private writeJournal(journalPath: string, journal: Journal): void {
    mkdirSync(path.dirname(journalPath), { recursive: true });
    const temporaryPath = `${journalPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(journal), 'utf-8');
    renameSync(temporaryPath, journalPath);
  }

  private cleanupOperationFiles(operations: JournalOperation[]): void {
    for (const operation of operations) {
      if (operation.stagedPath) rmSync(operation.stagedPath, { force: true, recursive: true });
      if (operation.backupPath) rmSync(operation.backupPath, { force: true, recursive: true });
    }
  }
}
