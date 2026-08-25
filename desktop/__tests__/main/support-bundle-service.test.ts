import type { MuxBasePane } from 'muxbase/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppInfoResult } from '../../src/shared/ipc-types';
import { createSupportBundle, previewSupportBundle } from '../../src/main/services/SupportBundleService';

const APP_INFO: AppInfoResult = { buildVersion: '0.0.1-test', isPackaged: false, version: '0.0.1' };

let root: string | null = null;
let home: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = null;
  }
  if (home) {
    rmSync(home, { force: true, recursive: true });
    home = null;
  }
});

describe('SupportBundleService', () => {
  it('exports logs, metadata, and terminal transcripts into a zip bundle', async () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'muxbase-support-'));
    const logDir = join(root, '.log');
    const terminalDir = join(logDir, 'terminal');
    mkdirSync(terminalDir, { recursive: true });

    const logFile = join(logDir, 'muxbase-desktop-2026-06-30.log');
    const rotatedLogFile = `${logFile}.1`;
    const transcriptPath = join(terminalDir, 'tmux-1-claude.ansi');
    writeFileSync(logFile, 'current log line');
    writeFileSync(rotatedLogFile, 'rotated log line');
    writeFileSync(transcriptPath, 'terminal transcript line');

    // Act
    const result = await createSupportBundle({
      appInfo: APP_INFO,
      includeTranscripts: true,
      logDir,
      logFile,
      now: new Date('2026-06-30T12:34:56.000Z'),
      outputDir: root,
      panes: [{
        agent: 'claude',
        agentStatus: 'working',
        id: 'pane-1',
        paneId: '%1',
        prompt: 'redacted from metadata',
        slug: 'claude-pane',
        terminalTranscriptPath: transcriptPath,
      }],
      projectName: 'muxbase',
      projectRoot: '/tmp/project',
      sessionName: 'muxbase-muxbase',
      systemCheck: {
        agents: ['claude'],
        git: { available: true, version: '2.50.0' },
        tmux: { available: true, version: '3.5' },
      },
    });

    // Assert
    expect(result.path).toBe(join(root, 'muxbase-support-2026-06-30-123456.zip'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.includedFiles).toEqual(expect.arrayContaining([logFile, rotatedLogFile, transcriptPath]));

    const zipBytes = readFileSync(result.path);
    expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipBytes.readUInt32LE(zipBytes.length - 22)).toBe(0x06054b50);

    const zipText = zipBytes.toString('utf8');
    expect(zipText).toContain('metadata/session.json');
    expect(zipText).toContain('logs/muxbase-desktop-2026-06-30.log');
    expect(zipText).toContain('terminal/tmux-1-claude.ansi');
    expect(zipText).toContain('current log line');
    expect(zipText).toContain('terminal transcript line');
    expect(zipText).toContain('"sessionName": "muxbase-muxbase"');
    expect(zipText).toContain('redaction-manifest.json');
    expect(zipText).toContain('README.txt');
    expect(zipText).not.toContain('redacted from metadata');
  });

  it('omits transcripts, tokenizes paths, and never leaks the raw home path when transcripts are off', async () => {
    // Arrange
    home = mkdtempSync(join(homedir(), 'muxbase-bundle-home-'));
    root = mkdtempSync(join(tmpdir(), 'muxbase-support-'));
    const { options, transcriptPath } = buildOptions(home, root, false);

    // Act
    const result = await createSupportBundle(options);
    const zip = readFileSync(result.path).toString('latin1');

    // Assert
    expect(zip).not.toContain('transcript body');
    expect(result.includedFiles).not.toContain(transcriptPath);
    expect(zip).toContain('<PROJECT>');
    expect(zip).toContain('<WORKTREE:feat-x>');
    expect(zip.indexOf(home)).toBe(-1);
  });

  it('strips ANSI and redacts a token split by an escape code inside a transcript', async () => {
    // Arrange
    home = mkdtempSync(join(homedir(), 'muxbase-bundle-home-'));
    root = mkdtempSync(join(tmpdir(), 'muxbase-support-'));
    const { options, transcriptPath } = buildOptions(home, root, true);
    writeFileSync(transcriptPath, 'auth ghp_0123456789\x1b[0mABCDEFGHIJ0123456789ABCD end\n');

    // Act
    const result = await createSupportBundle(options);
    const zip = readFileSync(result.path).toString('latin1');

    // Assert
    expect(zip).not.toContain('ghp_0123456789');
    expect(zip).toContain('<REDACTED:github-token>');
  });

  it('redacts a private-key block from a transcript', async () => {
    // Arrange
    home = mkdtempSync(join(homedir(), 'muxbase-bundle-home-'));
    root = mkdtempSync(join(tmpdir(), 'muxbase-support-'));
    const { options, transcriptPath } = buildOptions(home, root, true);
    writeFileSync(
      transcriptPath,
      ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEF', '-----END PRIVATE KEY-----'].join('\n'),
    );

    // Act
    const result = await createSupportBundle(options);
    const zip = readFileSync(result.path).toString('latin1');

    // Assert
    expect(zip).not.toContain('BEGIN PRIVATE KEY');
    expect(zip).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEF');
    expect(zip).toContain('<REDACTED:private-key>');
  });

  it('previews the transcript opt-in without writing a file', () => {
    // Arrange
    home = mkdtempSync(join(homedir(), 'muxbase-bundle-home-'));
    root = mkdtempSync(join(tmpdir(), 'muxbase-support-'));

    // Act
    const off = previewSupportBundle(buildOptions(home, root, false).options);
    const on = previewSupportBundle(buildOptions(home, root, true).options);

    // Assert
    expect(off.files.some((file) => file.category === 'transcript')).toBe(false);
    expect(on.files.some((file) => file.category === 'transcript')).toBe(true);
    expect(on.totalBytes).toBeGreaterThan(off.totalBytes);
  });
});

function buildOptions(homeDir: string, outputDir: string, includeTranscripts: boolean) {
  const logDir = join(homeDir, 'logs');
  const projectRoot = join(homeDir, 'proj');
  const worktreePath = join(projectRoot, '.worktrees', 'feat-x');
  const logFile = join(logDir, 'muxbase-desktop-2026-07-18.log');
  const transcriptPath = join(logDir, 'terminal', 'pane-1.ansi');
  mkdirSync(join(logDir, 'terminal'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(logFile, 'ready\n');
  writeFileSync(transcriptPath, 'transcript body\n');

  const pane: MuxBasePane = {
    agent: 'claude',
    id: 'pane-1',
    paneId: '%1',
    prompt: 'do the thing',
    slug: 'feat-x',
    terminalTranscriptPath: transcriptPath,
    type: 'worktree',
    worktreePath,
  };

  return {
    options: {
      appInfo: APP_INFO,
      includeTranscripts,
      logDir,
      logFile,
      outputDir,
      panes: [pane],
      projectName: 'proj',
      projectRoot,
      sessionName: 'muxbase-proj',
    },
    transcriptPath,
  };
}
