import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { listPiSessions } from '../../src/main/services/agent-session/PiSessionLister';

const temporaryRoots: string[] = [];

async function createSession(
  sessionsRoot: string,
  options: { cwd: string; id: string; name?: string; prompt?: string; updatedAt: number },
): Promise<void> {
  const encodedCwd = `--${path.resolve(options.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const projectDir = path.join(sessionsRoot, encodedCwd);
  await mkdir(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: options.id, cwd: options.cwd }),
    ...(options.prompt
      ? [JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: options.prompt }] },
      })]
      : []),
    ...(options.name ? [JSON.stringify({ type: 'session_info', name: options.name })] : []),
  ];
  const file = path.join(projectDir, `${options.id}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  const date = new Date(options.updatedAt);
  await utimes(file, date, date);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listPiSessions', () => {
  it('lists only matching-project sessions newest first with bounded titles', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    await createSession(sessionsRoot, {
      cwd: '/repo/current',
      id: 'older',
      prompt: 'Investigate the flaky tests',
      updatedAt: 1_000,
    });
    await createSession(sessionsRoot, {
      cwd: '/repo/current',
      id: 'newer',
      prompt: 'Implement the production-ready Pi integration',
      updatedAt: 2_000,
    });
    await createSession(sessionsRoot, {
      cwd: '/repo/other',
      id: 'other-project',
      prompt: 'Do not show this session',
      updatedAt: 3_000,
    });

    const result = await listPiSessions('/repo/current', 1, sessionsRoot);

    expect(result).toEqual({
      sessions: [{ id: 'newer', title: 'Implement the production-ready Pi integration', updatedAt: 2_000 }],
      total: 2,
    });
  });

  it('skips malformed files and keeps valid untitled sessions usable', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    await createSession(sessionsRoot, {
      cwd: '/repo/current',
      id: 'untitled',
      updatedAt: 4_000,
    });
    const encodedCwd = `--${path.resolve('/repo/current').replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    await writeFile(path.join(sessionsRoot, encodedCwd, 'broken.jsonl'), '{not-json}\n', 'utf8');

    const result = await listPiSessions('/repo/current', undefined, sessionsRoot);

    expect(result).toEqual({
      sessions: [{ id: 'untitled', title: 'Untitled session', updatedAt: 4_000 }],
      total: 1,
    });
  });

  it('uses the latest session name instead of the first prompt', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    await createSession(sessionsRoot, {
      cwd: '/repo/current',
      id: 'renamed',
      name: 'Production-ready Pi integration',
      prompt: 'Initial prompt',
      updatedAt: 5_000,
    });

    const result = await listPiSessions('/repo/current', undefined, sessionsRoot);

    expect(result.sessions[0]?.title).toBe('Production-ready Pi integration');
  });

  it('lists sessions from Pi session-directory overrides', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-custom-sessions-'));
    temporaryRoots.push(sessionDir);
    const file = path.join(sessionDir, 'custom.jsonl');
    await writeFile(file, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'custom',
      cwd: '/repo/current',
    })}\n`, 'utf8');
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

    try {
      const result = await listPiSessions('/repo/current');
      expect(result.sessions.map((session) => session.id)).toEqual(['custom']);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
  });

  it('honors Pi global sessionDir settings', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-agent-dir-'));
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-configured-sessions-'));
    temporaryRoots.push(agentDir, sessionDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ sessionDir }), 'utf8');
    await writeFile(path.join(sessionDir, 'configured.jsonl'), `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'configured',
      cwd: '/repo/current',
    })}\n`, 'utf8');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;

    try {
      const result = await listPiSessions('/repo/current');
      expect(result.sessions.map((session) => session.id)).toEqual(['configured']);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    }
  });

  it('honors a project-scoped Pi sessionDir over the global setting', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-project-'));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-agent-dir-'));
    const globalSessionDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-global-sessions-'));
    const projectSessionDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-project-sessions-'));
    temporaryRoots.push(projectRoot, agentDir, globalSessionDir, projectSessionDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: globalSessionDir }), 'utf8');
    await mkdir(path.join(projectRoot, '.pi'), { recursive: true });
    await writeFile(path.join(projectRoot, '.pi', 'settings.json'), JSON.stringify({ sessionDir: projectSessionDir }), 'utf8');
    await writeFile(path.join(projectSessionDir, 'project.jsonl'), `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'project',
      cwd: projectRoot,
    })}\n`, 'utf8');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;

    try {
      const result = await listPiSessions(projectRoot);
      expect(result.sessions.map((session) => session.id)).toEqual(['project']);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    }
  });

  it('filters shared custom directories by project before applying the limit', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-custom-sessions-'));
    temporaryRoots.push(sessionDir);
    const current = path.join(sessionDir, 'current.jsonl');
    const other = path.join(sessionDir, 'other.jsonl');
    await writeFile(current, `${JSON.stringify({ type: 'session', version: 3, id: 'current', cwd: '/repo/current' })}\n`, 'utf8');
    await writeFile(other, `${JSON.stringify({ type: 'session', version: 3, id: 'other', cwd: '/repo/other' })}\n`, 'utf8');
    await utimes(current, new Date(1_000), new Date(1_000));
    await utimes(other, new Date(2_000), new Date(2_000));
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

    try {
      const result = await listPiSessions('/repo/current', 1);
      expect(result).toEqual({
        sessions: [{ id: 'current', title: 'Untitled session', updatedAt: 1_000 }],
        total: 1,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
  });

  it('uses the latest session name when it is appended beyond the bounded head', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    const cwd = '/repo/current';
    const encodedCwd = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const projectDir = path.join(sessionsRoot, encodedCwd);
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, 'renamed-late.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'renamed-late', cwd }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Initial title' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(70 * 1024) } }),
      JSON.stringify({ type: 'session_info', name: 'Latest Pi name' }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const result = await listPiSessions(cwd, undefined, sessionsRoot);

    expect(result.sessions[0]?.title).toBe('Latest Pi name');
  });

  it('preserves a session name from the middle of a long transcript', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    const cwd = '/repo/current';
    const encodedCwd = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const projectDir = path.join(sessionsRoot, encodedCwd);
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, 'renamed-in-middle.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'renamed-in-middle', cwd }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Initial title' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(70 * 1024) } }),
      JSON.stringify({ type: 'session_info', name: 'Durable Pi name' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'y'.repeat(70 * 1024) } }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const result = await listPiSessions(cwd, undefined, sessionsRoot);

    expect(result.sessions[0]?.title).toBe('Durable Pi name');
  });

  it('does not parse past the requested session limit', async () => {
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'muxbase-pi-sessions-'));
    temporaryRoots.push(sessionsRoot);
    await createSession(sessionsRoot, {
      cwd: '/repo/current',
      id: 'newest',
      prompt: 'Newest valid session',
      updatedAt: 6_000,
    });
    const encodedCwd = `--${path.resolve('/repo/current').replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const malformed = path.join(sessionsRoot, encodedCwd, 'older.jsonl');
    await writeFile(malformed, '{not-json}\n', 'utf8');
    const olderDate = new Date(1_000);
    await utimes(malformed, olderDate, olderDate);

    const result = await listPiSessions('/repo/current', 1, sessionsRoot);

    expect(result).toEqual({
      sessions: [{ id: 'newest', title: 'Newest valid session', updatedAt: 6_000 }],
      total: 2,
    });
  });
});
