import type { PaneSessionListResponse } from '../../src/shared/ipc-types';
import { describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
const opencodeParser = vi.hoisted(() => ({
  getFirstUserMessageTexts: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: childProcess.execFile }));
vi.mock('../../src/main/services/parsing/OpencodeLogParser.js', () => ({
  OpencodeLogParser: class {
    getFirstUserMessageTexts = opencodeParser.getFirstUserMessageTexts;
  },
}));

import { PaneSessionCatalog } from '../../src/main/services/bridge/PaneSessionCatalog';

function response(id: string): PaneSessionListResponse {
  return { sessions: [{ id, title: id, updatedAt: 1 }], total: 1 };
}

function makeDependencies() {
  return {
    listClaude: vi.fn().mockResolvedValue(response('claude-session')),
    listCodex: vi.fn(() => response('codex-session')),
    listOpencodeRows: vi.fn().mockResolvedValue([]),
    listPi: vi.fn().mockResolvedValue(response('pi-session')),
    rescueOpencodeTitles: vi.fn().mockResolvedValue(new Map<string, string>()),
  };
}

describe('PaneSessionCatalog', () => {
  it('routes each supported agent to its existing session lister', async () => {
    const dependencies = makeDependencies();
    const catalog = new PaneSessionCatalog(dependencies);

    await expect(catalog.list('claude', '/project', 2)).resolves.toEqual(response('claude-session'));
    await expect(catalog.list('codex', '/project', 3)).resolves.toEqual(response('codex-session'));
    await expect(catalog.list('pi', '/project', 4)).resolves.toEqual(response('pi-session'));

    expect(dependencies.listClaude).toHaveBeenCalledWith('/project', 2);
    expect(dependencies.listCodex).toHaveBeenCalledWith(3);
    expect(dependencies.listPi).toHaveBeenCalledWith('/project', 4);
  });

  it('limits OpenCode rows while retaining the total available count', async () => {
    const dependencies = makeDependencies();
    dependencies.listOpencodeRows.mockResolvedValue([
      { id: 'one', title: 'First', updated: 3 },
      { id: 'two', title: 'Second', updated: 2 },
      { id: 'three', title: 'Third', updated: 1 },
    ]);
    const catalog = new PaneSessionCatalog(dependencies);

    await expect(catalog.list('opencode', '/project', 2)).resolves.toEqual({
      sessions: [
        { id: 'one', title: 'First', updatedAt: 3 },
        { id: 'two', title: 'Second', updatedAt: 2 },
      ],
      total: 3,
    });
  });

  it('rescues placeholder OpenCode titles from the first user message', async () => {
    const dependencies = makeDependencies();
    dependencies.listOpencodeRows.mockResolvedValue([
      { id: 'rescued', title: 'New session - 2026-08-23T16:00:00.000Z', updated: 2 },
      { id: 'untitled', title: '', updated: 1 },
    ]);
    dependencies.rescueOpencodeTitles.mockResolvedValue(new Map([
      ['rescued', 'Implement a robust bridge split'],
    ]));
    const catalog = new PaneSessionCatalog(dependencies);

    const result = await catalog.list('opencode', '/project');

    expect(result.sessions[0]?.title).toBe('Implement a robust bridge split');
    expect(result.sessions[1]?.title).toBe('Untitled session');
    expect(dependencies.rescueOpencodeTitles).toHaveBeenCalledWith('/project', ['rescued', 'untitled']);
  });

  it('returns an empty list for malformed OpenCode output', async () => {
    const dependencies = makeDependencies();
    dependencies.listOpencodeRows.mockResolvedValue({ sessions: [] });
    const catalog = new PaneSessionCatalog(dependencies);

    await expect(catalog.list('opencode', '/project')).resolves.toEqual({ sessions: [], total: 0 });
  });

  it('keeps valid OpenCode sessions while rejecting malformed array rows', async () => {
    const dependencies = makeDependencies();
    dependencies.listOpencodeRows.mockResolvedValue([
      { id: 'valid', title: 'Valid session', updated: 3 },
      null,
      { id: '', title: 'Missing id', updated: 2 },
      { id: 'bad-title', title: 42, updated: 2 },
      { id: 'bad-date', title: 'Invalid date', updated: Number.POSITIVE_INFINITY },
    ]);
    const catalog = new PaneSessionCatalog(dependencies);

    await expect(catalog.list('opencode', '/project')).resolves.toEqual({
      sessions: [{ id: 'valid', title: 'Valid session', updatedAt: 3 }],
      total: 1,
    });
  });

  it('normalizes lister failures into the existing response contract', async () => {
    const dependencies = makeDependencies();
    dependencies.listClaude.mockRejectedValue(new Error('session index unavailable'));
    const catalog = new PaneSessionCatalog(dependencies);

    await expect(catalog.list('claude', '/project')).resolves.toEqual({
      sessions: [],
      error: 'session index unavailable',
    });
  });

  it('uses the default OpenCode CLI and parser adapters for valid session output', async () => {
    childProcess.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify([
        { id: 'session', title: 'New session - 2026-08-23T16:00:00.000Z', updated: 5 },
      ]), '');
    });
    opencodeParser.getFirstUserMessageTexts.mockResolvedValue(new Map([
      ['session', 'Recovered from OpenCode history'],
    ]));

    await expect(new PaneSessionCatalog().list('opencode', '/project')).resolves.toEqual({
      sessions: [{ id: 'session', title: 'Recovered from OpenCode history', updatedAt: 5 }],
      total: 1,
    });
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'opencode',
      ['session', 'list', '--format', 'json'],
      expect.objectContaining({ cwd: '/project', timeout: 8000 }),
      expect.any(Function),
    );
    expect(opencodeParser.getFirstUserMessageTexts).toHaveBeenCalledWith('/project', ['session']);
  });

  it('treats invalid default OpenCode CLI output as an empty catalog', async () => {
    childProcess.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'not-json', '');
    });

    await expect(new PaneSessionCatalog().list('opencode', '/project')).resolves.toEqual({
      sessions: [],
      total: 0,
    });
  });
});
