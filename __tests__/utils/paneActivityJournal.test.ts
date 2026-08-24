import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeHome = mkdtempSync(join(tmpdir(), 'aumx-activity-journal-home-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const { getPaneActivityJournalPath, removePaneActivityJournal } = await import('../../src/utils/paneActivityJournal');

describe('removePaneActivityJournal', () => {
  it('reaps a dead incarnation journal and its rotated siblings, leaving other panes alone', () => {
    // Arrange
    const doomed = getPaneActivityJournalPath('incarnation-a');
    const survivor = getPaneActivityJournalPath('incarnation-b');
    mkdirSync(join(fakeHome, '.aumx', 'activity-journals'), { recursive: true });
    for (const path of [doomed, `${doomed}.1700000000000.42`, survivor]) writeFileSync(path, '{}\n');

    // Act
    removePaneActivityJournal(doomed);

    // Assert
    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(`${doomed}.1700000000000.42`)).toBe(false);
    expect(existsSync(survivor)).toBe(true);
  });

  it('is a no-op when the journal directory does not exist', () => {
    // Arrange
    const missing = getPaneActivityJournalPath('never-created');

    // Act + Assert
    expect(() => removePaneActivityJournal(missing)).not.toThrow();
  });
});
