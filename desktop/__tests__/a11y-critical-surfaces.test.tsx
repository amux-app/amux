// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import type { AxeResults } from 'axe-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AdvancedSettings } from '../src/renderer/components/settings/AdvancedSettings';
import { AttentionStat } from '../src/renderer/components/dashboard/AttentionStat';
import { CommandPalette } from '../src/renderer/components/command-palette/CommandPalette';
import { CreatePaneDialog } from '../src/renderer/components/create/CreatePaneDialog';
import { HelpOverlay } from '../src/renderer/components/shared/HelpOverlay';
import { MarketplaceSettings } from '../src/renderer/components/settings/MarketplaceSettings';
import { PaneActionsMenu } from '../src/renderer/components/dashboard/PaneActionsMenu';
import { PaneCell } from '../src/renderer/components/dashboard/PaneCell';
import { PaneTerminalGrid } from '../src/renderer/components/dashboard/PaneTerminalGrid';
import { ResourceBar } from '../src/renderer/components/dashboard/ResourceBar';
import { ReviewLaunchButton } from '../src/renderer/components/dashboard/ReviewLaunchButton';
import { Sidebar } from '../src/renderer/components/layout/Sidebar';
import { SupportBundleDialog } from '../src/renderer/components/settings/SupportBundleDialog';
import {
  type FileTab,
  useAgentSessionStore,
  useCommandPaletteStore,
  useElectronSettingsStore,
  useMarketplaceStore,
  useNotificationStore,
  usePaneStore,
  usePaneActivityStore,
  useProjectStore,
  useUiStore,
  useWorkspaceTabsStore,
} from '../src/renderer/stores';
import { useWorktreeStatusStore } from '../src/renderer/stores/worktree-status.store';
import type { ElectronSettings } from '../src/shared/ipc-types';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../src/shared/terminal-profile';

const getSessionInfoMock = vi.hoisted(() => vi.fn());
const previewSupportBundleMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/project.api', () => ({
  getSessionInfo: getSessionInfoMock,
}));

vi.mock('../src/renderer/api/system.api', () => ({
  clipboardWrite: vi.fn(),
  exportSupportBundle: vi.fn(),
  previewSupportBundle: previewSupportBundleMock,
  revealPath: vi.fn(),
  searchProjectFiles: vi.fn(() => new Promise(() => undefined)),
  searchProjectText: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../src/renderer/api/agent-session.api', () => ({
  searchSessions: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting: vi.fn(),
}));

vi.mock('../src/renderer/api/marketplace.api', () => ({
  addSource: vi.fn(async () => ({ success: true })),
  browseSource: vi.fn(async () => []),
  installPlugin: vi.fn(async () => true),
  listInstalled: vi.fn(async () => []),
  listSources: vi.fn(async () => []),
  removeSource: vi.fn(async () => undefined),
  uninstallPlugin: vi.fn(async () => undefined),
  updateSource: vi.fn(async () => undefined),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, layoutId: _layoutId, ...props }: React.HTMLAttributes<HTMLSpanElement> & { layoutId?: string }) => <span {...props}>{children}</span>,
  },
}));

vi.mock('../src/renderer/api/ipc', () => ({
  invoke: vi.fn(async () => ['claude', 'codex']),
}));

vi.mock('../src/renderer/api/pane.api', () => ({
  createDuelPanes: vi.fn(async () => ({ success: true })),
  listPaneSessions: vi.fn(async () => ({ sessions: [] })),
}));

vi.mock('../src/renderer/api/settings.api', () => ({
  getSettings: vi.fn(async () => ({ permissionMode: 'auto', useWorktree: false })),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({ createPane: vi.fn() }),
}));

vi.mock('../src/renderer/api/git.api', () => ({
  getStatus: vi.fn(async () => ({ hasChanges: false })),
}));

vi.mock('../src/renderer/components/pane-detail/InteractiveTerminal', () => ({
  InteractiveTerminal: () => <div data-testid="interactive-terminal" />,
}));

vi.mock('../src/renderer/hooks/useAgentSessionHydration', () => ({
  useAgentSessionHydration: vi.fn(),
}));

const DEFAULT_SETTINGS: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  costCurrency: 'EUR-hai',
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: true,
  disableExternalNetwork: false,
  enableConversationTopics: false,
  enableKanbanBoard: false,
  enablePaneSummary: false,
  enableReviewAgent: true,
  enableTelemetryCostTracking: true,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 25000,
  showAgentHealthTracker: false,
  showArenaScores: false,
  showPerformanceMetrics: false,
  terminalBell: false,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 12,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'classic',
  theme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
};

const WAITING_PANE: MuxBasePane = {
  agentStatus: 'waiting',
  id: 'pane-waiting',
  paneId: '%1',
  prompt: 'do something',
  slug: 'pane-waiting',
  type: 'worktree',
};

const A11Y_THEMES = ['colorful', 'dark', 'dark-colorful', 'light'] as const;

// react-resizable-panels derives aria-valuenow from measured panel sizes. happy-dom has
// no layout engine, so its separators render without it; the real DOM is asserted in
// __tests__/e2e/ui-accessibility.e2e.test.ts. Keyed by rule, matched on node markup.
const THIRD_PARTY_EXEMPT_NODES: Record<string, string> = {
  'aria-required-attr': 'muxbase-resize-handle',
};

function attentionFleet(): MuxBasePane[] {
  return ['waiting', 'working', 'idle', 'waiting'].map((agentStatus, index) => ({
    agent: 'claude',
    agentStatus: agentStatus as MuxBasePane['agentStatus'],
    id: `a11y-pane-${index + 1}`,
    paneId: `%${index + 1}`,
    projectRoot: '/Users/me/projects/app',
    prompt: 'ship it',
    slug: `a11y-pane-${index + 1}`,
    title: `Task ${index + 1}`,
    type: 'worktree',
    worktreePath: `/Users/me/projects/app/.muxbase/worktrees/a11y-pane-${index + 1}`,
  }));
}

const ATTENTION_FLEET = attentionFleet();

function seriousViolations(results: AxeResults) {
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

function blockingViolations(results: AxeResults) {
  return seriousViolations(results)
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter((node) => {
        const exemptMarkup = THIRD_PARTY_EXEMPT_NODES[violation.id];
        const isHappyDomFleetSeparator = violation.id === 'aria-required-attr'
          && node.target.join(' ').includes('fleet-')
          && node.target.join(' ').includes('separator-');
        return exemptMarkup === undefined
          || (!node.html.includes(exemptMarkup) && !isHappyDomFleetSeparator);
      }),
    }))
    .filter((violation) => violation.nodes.length > 0)
    .map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target.join(' ')) }));
}

function seedAttentionFleet(selectedPaneId: string | null = null): void {
  useAgentSessionStore.setState({ sessions: {} });
  usePaneStore.setState({
    isCreating: false,
    loaded: true,
    panes: ATTENTION_FLEET,
    pendingPane: null,
    selectedPaneId,
  });
  usePaneActivityStore.setState({
    activityByPaneId: Object.fromEntries(ATTENTION_FLEET.map((pane) => [pane.id, {
      activityRevision: 1,
      adapterHealth: 'degraded' as const,
      certainty: 'provisional' as const,
      liveness: 'unknown' as const,
      openBackgroundWork: [],
      origin: 'none' as const,
      paneIncarnationId: `${pane.id}-incarnation`,
      sinceWallMs: Date.now(),
      state: pane.agentStatus === 'analyzing' ? 'unknown' : pane.agentStatus ?? 'unknown',
    }])),
  });
  useUiStore.setState({ activeView: 'dashboard', focusPaneId: null, viewMode: 'fleet', zenMode: false });
  useWorkspaceTabsStore.setState({ activeTabByScope: {}, tabsByScope: {} });
  useWorktreeStatusStore.setState({
    statuses: { [ATTENTION_FLEET[0].id]: { deletions: 2, insertions: 4 } },
  });
}

const FILE_TABS: FileTab[] = [
  { fileName: 'auth.ts', id: 'tab-auth', openedAt: 1, relativePath: 'src/auth.ts', rootPath: '/Users/me/projects/app' },
  { fileName: 'router.ts', id: 'tab-router', openedAt: 2, relativePath: 'src/router.ts', rootPath: '/Users/me/projects/app' },
];

function seedFileTabs(paneId: string): void {
  useWorkspaceTabsStore.setState({
    activeTabByScope: { [paneId]: null },
    tabsByScope: { [paneId]: FILE_TABS },
  });
}

const ATTENTION_SURFACES: Array<{ mount: () => Promise<unknown>; name: string }> = [
  {
    mount: async () => {
      seedAttentionFleet(ATTENTION_FLEET[0].id);
      render(<PaneTerminalGrid />);
      return waitFor(() => expect(screen.getAllByTestId('pane-cell')).toHaveLength(ATTENTION_FLEET.length));
    },
    name: 'the fleet grid',
  },
  {
    mount: async () => {
      seedAttentionFleet(ATTENTION_FLEET[0].id);
      render(<PaneCell pane={ATTENTION_FLEET[0]} />);
      return screen.findByTestId('pane-attention-word');
    },
    name: 'a waiting pane cell',
  },
  {
    mount: async () => {
      seedAttentionFleet(ATTENTION_FLEET[0].id);
      seedFileTabs(ATTENTION_FLEET[0].id);
      render(<PaneCell pane={ATTENTION_FLEET[0]} />);
      return screen.findAllByRole('tab', { name: /\.ts$/ });
    },
    name: 'a pane cell with open file tabs',
  },
  {
    mount: async () => {
      seedAttentionFleet();
      render(<ResourceBar />);
      return screen.findByTestId('resource-attention-stat');
    },
    name: 'the resource bar with the waiting stat',
  },
  {
    mount: async () => {
      seedAttentionFleet();
      render(<ResourceBar />);
      fireEvent.click(await screen.findByTestId('resource-attention-stat'));
      return screen.findByRole('menu', { name: 'Waiting agents' });
    },
    name: 'the open attention peek',
  },
  {
    mount: async () => {
      seedAttentionFleet();
      useCommandPaletteStore.setState({ isOpen: true });
      render(<CommandPalette />);
      await screen.findByRole('dialog', { name: 'Command palette' });
      // Recent panes fill cmdk's list, so the surface is scanned with real items
      // instead of the empty-list shape that trips aria-required-children.
      return screen.findAllByRole('option');
    },
    name: 'the open command palette',
  },
  {
    mount: async () => {
      useUiStore.setState({ helpOverlayOpen: true });
      render(<HelpOverlay />);
      return screen.findByRole('dialog', { name: 'Keyboard Shortcuts' });
    },
    name: 'the open help overlay',
  },
  {
    mount: async () => {
      seedAttentionFleet(ATTENTION_FLEET[0].id);
      render(<PaneActionsMenu onRename={vi.fn()} pane={ATTENTION_FLEET[0]} status="idle" />);
      fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }));
      return screen.findByRole('menu', { name: 'Pane actions' });
    },
    name: 'the open pane actions menu',
  },
  {
    mount: async () => {
      seedAttentionFleet(ATTENTION_FLEET[0].id);
      render(<ReviewLaunchButton defaultAgent="claude" paneId={ATTENTION_FLEET[0].id} />);
      fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
      return screen.findByRole('button', { name: 'Start Review' });
    },
    name: 'the open review launch popup',
  },
];

// UI/UX baseline capture. Opt-in via MUXBASE_UI_BASELINE=1 so the default suite
// keeps its runtime; the block records every violation impact and asserts nothing.
const BASELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'ui-baseline');
const BASELINE_REPORT_PATH = resolve(BASELINE_DIR, 'a11y-critical-surfaces.json');

function summarizeViolations(surface: string, results: AxeResults) {
  return {
    incomplete: results.incomplete.map((check) => ({ id: check.id, nodes: check.nodes.length })),
    passes: results.passes.length,
    surface,
    violations: results.violations.map((violation) => ({
      help: violation.help,
      id: violation.id,
      impact: violation.impact ?? null,
      nodes: violation.nodes.length,
      sample: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
    })),
  };
}

describe('accessibility of critical surfaces', () => {
  beforeEach(() => {
    usePaneActivityStore.getState().reset();
    getSessionInfoMock.mockResolvedValue({
      logDir: '/tmp/muxbase-logs',
      logFile: '/tmp/muxbase-logs/muxbase-desktop-test.log',
      projectName: 'muxbase',
      projectRoot: '/tmp/project',
      sessionName: 'muxbase-muxbase',
    });
    previewSupportBundleMock.mockResolvedValue({
      files: [{ category: 'metadata', name: 'metadata/session.json', sizeBytes: 100 }],
      includeTranscripts: false,
      redactionNote: 'Paths and detected credentials are redacted on a best-effort basis.',
      totalBytes: 100,
    });
    useElectronSettingsStore.setState({ isLoading: false, settings: DEFAULT_SETTINGS });
    useMarketplaceStore.setState({
      browsedPlugins: {},
      error: null,
      installedPlugins: [],
      installingPlugin: null,
      isLoading: false,
      sources: [],
    });
    useCommandPaletteStore.setState({ activeTab: 'all', isOpen: false, search: '' });
    useNotificationStore.setState({ toasts: [] });
    useUiStore.setState({ helpOverlayOpen: false });
    usePaneStore.setState({
      isCreating: true,
      loaded: true,
      panes: [],
      pendingPane: null,
      selectedPaneId: null,
    });
    useProjectStore.setState({
      activeProject: {
        configPath: '/Users/me/projects/app/.muxbase/muxbase.config.json',
        name: 'app',
        paneCount: 0,
        root: '/Users/me/projects/app',
        sessionName: 'muxbase-app',
      },
      projectSwitching: false,
      projects: [],
      sessionName: 'muxbase-app',
      sessionProjectName: 'app',
      sessionProjectRoot: '/Users/me/projects/app',
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('AdvancedSettings has no serious a11y violations', async () => {
    const { container } = render(<AdvancedSettings />);
    await screen.findByText('/tmp/muxbase-logs/muxbase-desktop-test.log');

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('SupportBundleDialog has no serious a11y violations', async () => {
    const { container } = render(<SupportBundleDialog onClose={vi.fn()} />);
    await screen.findByRole('dialog');

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('MarketplaceSettings has no serious a11y violations', async () => {
    const { container } = render(<MarketplaceSettings />);
    await screen.findByText('Sources');

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('CreatePaneDialog has no serious a11y violations', async () => {
    const { container } = render(<CreatePaneDialog />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New Pane' })).toBeTruthy());

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('the open CommandPalette has no serious a11y violations', async () => {
    useCommandPaletteStore.setState({ isOpen: true });
    usePaneStore.setState({ panes: [WAITING_PANE] });
    const { container } = render(<CommandPalette />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy());

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('the open HelpOverlay has no serious a11y violations', async () => {
    useUiStore.setState({ helpOverlayOpen: true });
    const { container } = render(<HelpOverlay />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeTruthy());

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('the Sidebar has no serious a11y violations', async () => {
    useAgentSessionStore.setState({ sessions: {} });
    usePaneStore.setState({ loaded: true, panes: [WAITING_PANE], selectedPaneId: WAITING_PANE.id });
    useUiStore.setState({ sidebarCollapsed: false });
    const { container } = render(<Sidebar />);
    await screen.findByTestId('app-shell-sidebar');

    const results = await axe(container);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('the Sidebar leads with the MuxBase wordmark as its only heading', async () => {
    usePaneStore.setState({ loaded: true, panes: [WAITING_PANE], selectedPaneId: WAITING_PANE.id });
    useUiStore.setState({ sidebarCollapsed: false });
    render(<Sidebar />);
    await screen.findByTestId('app-shell-sidebar');

    const headings = screen.getAllByRole('heading', { level: 1 });

    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('MuxBase');
  });

  it('the Sidebar options menu has no serious a11y violations', async () => {
    usePaneStore.setState({ loaded: true, panes: [WAITING_PANE], selectedPaneId: null });
    useUiStore.setState({ sidebarCollapsed: false });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Sidebar options' }));
    await screen.findByRole('menu', { name: 'Sidebar options' });

    const results = await axe(document.body);

    expect(seriousViolations(results)).toEqual([]);
  });

  it('a keyboard-opened HoverTooltip has no serious a11y violations', async () => {
    useAgentSessionStore.setState({ sessions: {} });
    usePaneStore.setState({ loaded: true, panes: [WAITING_PANE], selectedPaneId: null });
    usePaneActivityStore.setState({
      justFinishedPaneIds: new Set(),
      activityByPaneId: { [WAITING_PANE.id]: {
        activityRevision: 1,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'unknown',
        openBackgroundWork: [],
        origin: 'none',
        paneIncarnationId: 'waiting-incarnation',
        sinceWallMs: Date.now(),
        state: 'waiting',
      } },
    });
    render(<AttentionStat variant="stat" />);
    const trigger = screen.getByRole('button', { name: /waiting for input/i });

    fireEvent.focusIn(trigger);

    const tooltip = screen.getByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);

    const results = await axe(document.body);

    expect(seriousViolations(results)).toEqual([]);
  });

  describe.each(A11Y_THEMES)('under the %s theme', (theme) => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-theme', theme);
    });

    afterEach(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    it.each(ATTENTION_SURFACES)('$name has no serious or critical a11y violations', async ({ mount }) => {
      // Arrange + Act
      await mount();

      // Assert
      expect(blockingViolations(await axe(document.body))).toEqual([]);
    });
  });

  it.runIf(process.env.MUXBASE_UI_BASELINE === '1')('records the a11y baseline for critical surfaces', async () => {
    const surfaces: Array<[string, React.ReactElement, () => Promise<unknown>]> = [
      ['AdvancedSettings', <AdvancedSettings />, () => screen.findByText('/tmp/muxbase-logs/muxbase-desktop-test.log')],
      ['SupportBundleDialog', <SupportBundleDialog onClose={vi.fn()} />, () => screen.findByRole('dialog')],
      ['MarketplaceSettings', <MarketplaceSettings />, () => screen.findByText('Sources')],
      ['CreatePaneDialog', <CreatePaneDialog />, () => waitFor(() => screen.getByRole('dialog', { name: 'New Pane' }))],
    ];

    const report = [];
    for (const [name, element, ready] of surfaces) {
      const { container } = render(element);
      await ready();
      report.push(summarizeViolations(name, await axe(container)));
      cleanup();
    }

    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(BASELINE_REPORT_PATH, `${JSON.stringify({ capturedAt: new Date().toISOString(), surfaces: report }, null, 2)}\n`);
  });
});
