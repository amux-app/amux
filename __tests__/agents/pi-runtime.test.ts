import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildPiFlags,
  buildPiResumeCommand,
  findPiSessionFile,
  isPiCliIdentity,
  isPiProcessCommand,
} from '../../src/agents/pi-runtime.js';

describe('Pi runtime', () => {
  it('builds only explicit model and thinking overrides with shell-safe values', () => {
    expect(buildPiFlags({})).toBe('');
    expect(buildPiFlags({ model: 'openai/gpt-5.5', effort: 'xhigh' }))
      .toBe(" --model 'openai/gpt-5.5' --thinking 'xhigh'");
    expect(buildPiFlags({ model: "model'$(touch nope)", effort: 'high' }))
      .toContain("'model'\\''$(touch nope)'");
  });

  it('builds explicit and latest-session resume commands', () => {
    expect(buildPiResumeCommand('019fd282-216d')).toBe("pi --session '019fd282-216d'");
    expect(buildPiResumeCommand('019fd282-216d', 'fork')).toBe("pi --fork '019fd282-216d'");
    expect(buildPiResumeCommand()).toBe('pi --continue');
  });

  it('resolves a selected session from a project-relative Pi session directory', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aumx-pi-source-'));
    const sessionDirectory = path.join(projectRoot, '.pi-sessions');
    const sessionId = '019fd282-216d-7d9a-81af-323dd117ff21';
    const sessionFile = path.join(sessionDirectory, 'source.jsonl');
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;

    try {
      await mkdir(sessionDirectory);
      await writeFile(sessionFile, `${JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: projectRoot,
      })}\n`, 'utf8');
      process.env.PI_CODING_AGENT_SESSION_DIR = '.pi-sessions';

      await expect(findPiSessionFile(projectRoot, sessionId)).resolves.toBe(sessionFile);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('verifies Pi coding-agent help output instead of trusting a generic binary name', () => {
    expect(isPiCliIdentity('pi - AI coding assistant with read, bash, edit, write tools\nUsage: pi [options]')).toBe(true);
    expect(isPiCliIdentity('Usage: pi [digits]')).toBe(false);
    expect(isPiCliIdentity('Raspberry Pi utility')).toBe(false);
  });

  it('recognizes the real Pi help signature when color is forced', () => {
    const help = '\x1b[1mpi\x1b[22m - AI coding assistant with read, bash, edit, write tools\n'
      + '\x1b[1mUsage:\x1b[22m pi [options]';

    expect(isPiCliIdentity(help)).toBe(true);
  });

  it.each([
    ['pi', true],
    ['/opt/homebrew/bin/pi', true],
    ['pi --model openai/gpt-5.5', true],
    ['/usr/bin/env pi --thinking high', true],
    ['node /opt/homebrew/bin/pi --offline', true],
    ['node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', true],
    ['pip', false],
    ['spin', false],
    ['/tmp/pi-helper', false],
    ['bash -lc "echo pi"', false],
    ['node script.js --label pi', false],
  ])('matches %s exactly: %s', (command, expected) => {
    expect(isPiProcessCommand(command)).toBe(expected);
  });
});
