import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MarketplaceIntegrityError,
  MarketplaceTransaction,
  digestPath,
  type MarketplaceMutation,
} from '../../src/services/marketplace/MarketplaceTransaction.js';

function createRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-transaction-'));
}

function fileMutation(filePath: string, content: string, expectedDigest: string | null): MarketplaceMutation {
  return { content: Buffer.from(content), expectedDigest, kind: 'file', path: filePath };
}

describe('MarketplaceTransaction', () => {
  it('atomically replaces every mutation after staging their content', () => {
    const root = createRoot();
    const firstPath = path.join(root, 'first.txt');
    const secondPath = path.join(root, 'nested', 'second.txt');
    writeFileSync(firstPath, 'before');

    const transaction = new MarketplaceTransaction({ journalDir: path.join(root, 'journal') });
    transaction.execute([
      fileMutation(firstPath, 'after', digestPath(firstPath)),
      fileMutation(secondPath, 'created', null),
    ]);

    expect(readFileSync(firstPath, 'utf8')).toBe('after');
    expect(readFileSync(secondPath, 'utf8')).toBe('created');
    expect(existsSync(path.join(root, 'journal'))).toBe(true);
  });

  it('restores byte-identical destinations when a later mutation fails', () => {
    const root = createRoot();
    const firstPath = path.join(root, 'first.txt');
    const secondPath = path.join(root, 'second.txt');
    writeFileSync(firstPath, 'first-before');
    writeFileSync(secondPath, 'second-before');

    const transaction = new MarketplaceTransaction({
      failAfterApply: 1,
      journalDir: path.join(root, 'journal'),
    });

    expect(() => transaction.execute([
      fileMutation(firstPath, 'first-after', digestPath(firstPath)),
      fileMutation(secondPath, 'second-after', digestPath(secondPath)),
    ])).toThrow('Injected marketplace transaction failure');

    expect(readFileSync(firstPath, 'utf8')).toBe('first-before');
    expect(readFileSync(secondPath, 'utf8')).toBe('second-before');
  });

  it('rejects an external modification between preflight and apply', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'settings.json');
    writeFileSync(targetPath, '{"before":true}');
    const expectedDigest = digestPath(targetPath);
    writeFileSync(targetPath, '{"changedByUser":true}');

    const transaction = new MarketplaceTransaction({ journalDir: path.join(root, 'journal') });

    expect(() => transaction.execute([fileMutation(targetPath, '{"after":true}', expectedDigest)]))
      .toThrow(MarketplaceIntegrityError);
    expect(() => transaction.execute([fileMutation(targetPath, '{"after":true}', expectedDigest)]))
      .toThrow('CONCURRENT_MODIFICATION');
    expect(readFileSync(targetPath, 'utf8')).toBe('{"changedByUser":true}');
  });

  it('recovers an unfinished transaction by restoring its backups', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'target.txt');
    const journalDir = path.join(root, 'journal');
    writeFileSync(targetPath, 'before');

    const interrupted = new MarketplaceTransaction({
      failAfterApply: 1,
      journalDir,
      preserveJournalOnFailure: true,
      skipRollbackOnFailure: true,
    });
    expect(() => interrupted.execute([fileMutation(targetPath, 'after', digestPath(targetPath))]))
      .toThrow('Injected marketplace transaction failure');

    // The injected interruption leaves its journal and same-filesystem backup in place.
    expect(MarketplaceTransaction.recover(journalDir)).toEqual({ recovered: 1, rollbackFailures: [] });
    expect(readFileSync(targetPath, 'utf8')).toBe('before');
  });

  it('recovers a backup rename that completed before its journal state was persisted', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'target.txt');
    const backupPath = path.join(root, '.target.txt.muxbase-backup-interrupted-0');
    const stagedPath = path.join(root, '.target.txt.muxbase-stage-interrupted-0');
    const journalDir = path.join(root, 'journal');
    const transactionsDir = path.join(journalDir, 'transactions');
    mkdirSync(transactionsDir, { recursive: true });
    writeFileSync(backupPath, 'before');
    writeFileSync(stagedPath, 'after');
    writeFileSync(path.join(transactionsDir, 'interrupted.json'), JSON.stringify({
      version: 1,
      transactionId: 'interrupted',
      state: 'applying',
      operations: [{
        path: targetPath,
        kind: 'file',
        expectedDigest: digestPath(backupPath),
        stagedPath,
        backupPath,
        state: 'pending',
      }],
    }));

    expect(MarketplaceTransaction.recover(journalDir)).toEqual({ recovered: 1, rollbackFailures: [] });
    expect(readFileSync(targetPath, 'utf8')).toBe('before');
    expect(existsSync(backupPath)).toBe(false);
  });

  it('keeps an already-restored destination when recovery resumes before rollback state persistence', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'target.txt');
    const backupPath = path.join(root, '.target.txt.muxbase-backup-resumed-0');
    const journalDir = path.join(root, 'journal');
    const transactionsDir = path.join(journalDir, 'transactions');
    mkdirSync(transactionsDir, { recursive: true });
    writeFileSync(targetPath, 'before');
    writeFileSync(path.join(transactionsDir, 'resumed.json'), JSON.stringify({
      version: 1,
      transactionId: 'resumed',
      state: 'applying',
      operations: [{
        path: targetPath,
        kind: 'file',
        expectedDigest: digestPath(targetPath),
        backupPath,
        state: 'replaced',
      }],
    }));

    expect(MarketplaceTransaction.recover(journalDir)).toEqual({ recovered: 1, rollbackFailures: [] });
    expect(readFileSync(targetPath, 'utf8')).toBe('before');
  });

  it('removes a staged creation that completed before its journal state was persisted', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'target.txt');
    const stagedPath = path.join(root, '.target.txt.muxbase-stage-interrupted-0');
    const journalDir = path.join(root, 'journal');
    const transactionsDir = path.join(journalDir, 'transactions');
    mkdirSync(transactionsDir, { recursive: true });
    writeFileSync(targetPath, 'after');
    writeFileSync(path.join(transactionsDir, 'interrupted.json'), JSON.stringify({
      version: 1,
      transactionId: 'interrupted',
      state: 'applying',
      operations: [{
        path: targetPath,
        kind: 'file',
        expectedDigest: null,
        stagedPath,
        stagedDigest: digestPath(targetPath),
        state: 'pending',
      }],
    }));

    expect(MarketplaceTransaction.recover(journalDir)).toEqual({ recovered: 1, rollbackFailures: [] });
    expect(existsSync(targetPath)).toBe(false);
  });

  it('preserves a changed staged creation when recovery cannot prove ownership', () => {
    const root = createRoot();
    const targetPath = path.join(root, 'target.txt');
    const stagedPath = path.join(root, '.target.txt.muxbase-stage-interrupted-0');
    const journalDir = path.join(root, 'journal');
    const transactionsDir = path.join(journalDir, 'transactions');
    mkdirSync(transactionsDir, { recursive: true });
    writeFileSync(targetPath, 'installed');
    const stagedDigest = digestPath(targetPath);
    writeFileSync(targetPath, 'changed-by-user');
    writeFileSync(path.join(transactionsDir, 'interrupted.json'), JSON.stringify({
      version: 1,
      transactionId: 'interrupted',
      state: 'applying',
      operations: [{
        path: targetPath,
        kind: 'file',
        expectedDigest: null,
        stagedPath,
        stagedDigest,
        state: 'replaced',
      }],
    }));

    expect(MarketplaceTransaction.recover(journalDir)).toEqual({
      recovered: 1,
      rollbackFailures: [targetPath],
    });
    expect(readFileSync(targetPath, 'utf8')).toBe('changed-by-user');
  });

  it('cleans a valid journal even when an earlier journal cannot be recovered', () => {
    const root = createRoot();
    const journalDir = path.join(root, 'journal');
    const transactionsDir = path.join(journalDir, 'transactions');
    const invalidJournalPath = path.join(transactionsDir, 'a-invalid.json');
    const committedJournalPath = path.join(transactionsDir, 'z-committed.json');
    const stagedPath = path.join(root, '.target.txt.muxbase-stage-committed-0');
    const backupPath = path.join(root, '.target.txt.muxbase-backup-committed-0');
    mkdirSync(transactionsDir, { recursive: true });
    writeFileSync(invalidJournalPath, JSON.stringify({ version: 999, operations: [] }));
    writeFileSync(stagedPath, 'staged');
    writeFileSync(backupPath, 'backup');
    writeFileSync(committedJournalPath, JSON.stringify({
      version: 1,
      transactionId: 'committed',
      state: 'committed',
      operations: [{
        path: path.join(root, 'target.txt'),
        kind: 'file',
        expectedDigest: null,
        stagedPath,
        backupPath,
        state: 'replaced',
      }],
    }));

    expect(MarketplaceTransaction.recover(journalDir)).toEqual({
      recovered: 0,
      rollbackFailures: [invalidJournalPath],
    });
    expect(existsSync(invalidJournalPath)).toBe(true);
    expect(existsSync(committedJournalPath)).toBe(false);
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });
});
