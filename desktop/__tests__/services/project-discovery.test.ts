import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock('muxbase/core', () => ({
  execAsync: execAsyncMock,
  getProjectConfigPath: (projectRoot: string) => `${projectRoot}/.muxbase/muxbase.config.json`,
  shQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: vi.fn(),
  statSync: statSyncMock,
}));

import { discoverCurrentProject, discoverProjects } from '../../src/main/services/ProjectDiscovery';

describe('ProjectDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MUXBASE_E2E;
    existsSyncMock.mockImplementation((path: string) => !path.endsWith('/.muxbase/muxbase.config.json'));
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('list-sessions')) {
        return [
          'muxbase-demo--view-pane-1',
          'muxbase-demo',
          'muxbase-demo--view-pane-2',
        ].join('\n');
      }
      if (command.includes('@muxbase_project_root')) {
        return '@muxbase_project_root /repo/demo';
      }
      if (command.includes('@muxbase_project_name')) {
        return '@muxbase_project_name Demo';
      }
      if (command.includes('pane_current_path')) {
        return '/repo/demo';
      }
      return '';
    });
  });

  it('ignores pty view sessions while discovering projects', async () => {
    const projects = await discoverProjects();

    expect(projects).toEqual([
      expect.objectContaining({
        configPath: '/repo/demo/.muxbase/muxbase.config.json',
        root: '/repo/demo',
        sessionName: 'muxbase-demo',
      }),
    ]);
    const resolvedSessions = execAsyncMock.mock.calls
      .map((call) => call[0] as string)
      .filter((command) => command.includes('@muxbase_project_root') || command.includes('pane_current_path'));
    expect(resolvedSessions.some((command) => command.includes('--view-'))).toBe(false);
  });

  it('ignores pty view sessions while resolving the current project', async () => {
    const currentProject = await discoverCurrentProject();

    expect(currentProject).toEqual({
      projectName: 'demo',
      projectRoot: '/repo/demo',
      sessionName: 'muxbase-demo',
    });
  });

  it('skips stale project sessions whose root no longer exists', async () => {
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('list-sessions')) {
        return [
          'muxbase-stale',
          'muxbase-live',
        ].join('\n');
      }
      if (command.includes("tmux show -t 'muxbase-stale' @muxbase_project_root")) {
        return '@muxbase_project_root /tmp/deleted-muxbase-project\n';
      }
      if (command.includes("tmux show -t 'muxbase-live' @muxbase_project_root")) {
        return '@muxbase_project_root /repo/live\n';
      }
      return '';
    });
    existsSyncMock.mockImplementation((path: string) => (
      path === '/repo/live'
    ));

    const projects = await discoverProjects();
    const currentProject = await discoverCurrentProject();

    expect(projects).toEqual([
      expect.objectContaining({
        root: '/repo/live',
        sessionName: 'muxbase-live',
      }),
    ]);
    expect(currentProject).toEqual({
      projectName: 'live',
      projectRoot: '/repo/live',
      sessionName: 'muxbase-live',
    });
  });

  it('prefers the launch working tree when multiple valid project sessions exist', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/muxbase');
    try {
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('list-sessions')) {
          return [
            'muxbase-desktop',
            'muxbase-muxbase',
          ].join('\n');
        }
        if (command.includes("tmux show -t 'muxbase-desktop' @muxbase_project_root")) {
          return '@muxbase_project_root /repo/muxbase/desktop\n';
        }
        if (command.includes("tmux show -t 'muxbase-muxbase' @muxbase_project_root")) {
          return '@muxbase_project_root /repo/muxbase\n';
        }
        return '';
      });
      existsSyncMock.mockImplementation((path: string) => (
        path === '/repo/muxbase' || path === '/repo/muxbase/desktop'
      ));

      const currentProject = await discoverCurrentProject();

      expect(currentProject).toEqual({
        projectName: 'muxbase',
        projectRoot: '/repo/muxbase',
        sessionName: 'muxbase-muxbase',
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('resolves current-project session metadata concurrently', async () => {
    const pendingResolvers = new Map<string, (value: string) => void>();
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) {
        return Promise.resolve(['muxbase-one', 'muxbase-two'].join('\n'));
      }
      if (command.includes('@muxbase_project_root')) {
        return new Promise<string>((resolve) => {
          pendingResolvers.set(command, resolve);
        });
      }
      return Promise.resolve('');
    });

    const discovery = discoverCurrentProject();
    await vi.waitFor(() => {
      const metadataCalls = execAsyncMock.mock.calls.filter(
        ([command]) => String(command).includes('@muxbase_project_root'),
      );
      expect(metadataCalls).toHaveLength(2);
    });

    for (const [command, resolve] of pendingResolvers) {
      resolve(command.includes('muxbase-one')
        ? '@muxbase_project_root /repo/one'
        : '@muxbase_project_root /repo/two');
    }

    await expect(discovery).resolves.toEqual(expect.objectContaining({
      projectRoot: '/repo/one',
    }));
  });
});
