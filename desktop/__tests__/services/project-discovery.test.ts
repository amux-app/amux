import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock('aumx/core', () => ({
  execAsync: execAsyncMock,
  getProjectConfigPath: (projectRoot: string) => `${projectRoot}/.amux/aumx.config.json`,
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
    delete process.env.AUMX_E2E;
    existsSyncMock.mockImplementation((path: string) => !path.endsWith('/.aumx/aumx.config.json'));
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('list-sessions')) {
        return [
          'aumx-demo--view-pane-1',
          'aumx-demo',
          'aumx-demo--view-pane-2',
        ].join('\n');
      }
      if (command.includes('@aumx_project_root')) {
        return '@aumx_project_root /repo/demo';
      }
      if (command.includes('@aumx_project_name')) {
        return '@aumx_project_name Demo';
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
        configPath: '/repo/demo/.amux/aumx.config.json',
        root: '/repo/demo',
        sessionName: 'aumx-demo',
      }),
    ]);
    const resolvedSessions = execAsyncMock.mock.calls
      .map((call) => call[0] as string)
      .filter((command) => command.includes('@aumx_project_root') || command.includes('pane_current_path'));
    expect(resolvedSessions.some((command) => command.includes('--view-'))).toBe(false);
  });

  it('ignores pty view sessions while resolving the current project', async () => {
    const currentProject = await discoverCurrentProject();

    expect(currentProject).toEqual({
      projectName: 'demo',
      projectRoot: '/repo/demo',
      sessionName: 'aumx-demo',
    });
  });

  it('skips stale project sessions whose root no longer exists', async () => {
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('list-sessions')) {
        return [
          'aumx-stale',
          'aumx-live',
        ].join('\n');
      }
      if (command.includes("tmux show -t 'aumx-stale' @aumx_project_root")) {
        return '@aumx_project_root /tmp/deleted-aumx-project\n';
      }
      if (command.includes("tmux show -t 'aumx-live' @aumx_project_root")) {
        return '@aumx_project_root /repo/live\n';
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
        sessionName: 'aumx-live',
      }),
    ]);
    expect(currentProject).toEqual({
      projectName: 'live',
      projectRoot: '/repo/live',
      sessionName: 'aumx-live',
    });
  });

  it('prefers the launch working tree when multiple valid project sessions exist', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/aumx');
    try {
      execAsyncMock.mockImplementation(async (command: string) => {
        if (command.includes('list-sessions')) {
          return [
            'aumx-desktop',
            'aumx-aumx',
          ].join('\n');
        }
        if (command.includes("tmux show -t 'aumx-desktop' @aumx_project_root")) {
          return '@aumx_project_root /repo/aumx/desktop\n';
        }
        if (command.includes("tmux show -t 'aumx-aumx' @aumx_project_root")) {
          return '@aumx_project_root /repo/aumx\n';
        }
        return '';
      });
      existsSyncMock.mockImplementation((path: string) => (
        path === '/repo/aumx' || path === '/repo/aumx/desktop'
      ));

      const currentProject = await discoverCurrentProject();

      expect(currentProject).toEqual({
        projectName: 'aumx',
        projectRoot: '/repo/aumx',
        sessionName: 'aumx-aumx',
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('resolves current-project session metadata concurrently', async () => {
    const pendingResolvers = new Map<string, (value: string) => void>();
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) {
        return Promise.resolve(['aumx-one', 'aumx-two'].join('\n'));
      }
      if (command.includes('@aumx_project_root')) {
        return new Promise<string>((resolve) => {
          pendingResolvers.set(command, resolve);
        });
      }
      return Promise.resolve('');
    });

    const discovery = discoverCurrentProject();
    await vi.waitFor(() => {
      const metadataCalls = execAsyncMock.mock.calls.filter(
        ([command]) => String(command).includes('@aumx_project_root'),
      );
      expect(metadataCalls).toHaveLength(2);
    });

    for (const [command, resolve] of pendingResolvers) {
      resolve(command.includes('aumx-one')
        ? '@aumx_project_root /repo/one'
        : '@aumx_project_root /repo/two');
    }

    await expect(discovery).resolves.toEqual(expect.objectContaining({
      projectRoot: '/repo/one',
    }));
  });
});
