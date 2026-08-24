// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePicker } from '../src/renderer/components/workspace-picker/WorkspacePicker';
import { usePaneStore, useProjectStore, useWorkspacePickerStore } from '../src/renderer/stores';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
}));

vi.mock('../src/renderer/api/workspace.api', () => ({
  createProjectDialog: vi.fn(),
  createSession: vi.fn(),
  listHistory: vi.fn(async () => []),
  openFolderDialog: vi.fn(),
  removeHistory: vi.fn(),
  touchHistory: vi.fn(),
}));

vi.mock('../src/renderer/api/project.api', () => ({
  getSessionInfo: vi.fn(),
  listProjects: vi.fn(async () => []),
  switchProject: vi.fn(),
}));

vi.mock('../src/renderer/api/pane.api', () => ({
  listPanes: vi.fn(async () => []),
  listPaneSessions: vi.fn(async () => ({ sessions: [] })),
}));

const PICKER_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/components/workspace-picker/WorkspacePicker.tsx'),
  'utf8',
);

const ART_TOKENS = [
  '--workspace-orb-primary',
  '--workspace-orb-secondary',
  '--workspace-wordmark-from',
  '--workspace-wordmark-to',
  '--workspace-wordmark-via',
];

const RETIRED_ART_LITERALS = ['#00d4aa', '#58a6ff', '#8b949e', '#e6edf3'];

const ORB_LAYERS = [
  { box: 'w-[600px] h-[600px]', opacity: '', token: '--workspace-orb-primary' },
  { box: 'w-[300px] h-[300px]', opacity: 'opacity-[0.04]', token: '--workspace-orb-secondary' },
];

const WORDMARK_GRADIENT =
  'linear-gradient(135deg, var(--workspace-wordmark-from) 0%, var(--workspace-wordmark-via) 60%, var(--workspace-wordmark-to) 100%)';

const WORDMARK_CLIP_PROPS = ['WebkitBackgroundClip', 'WebkitTextFillColor', 'backgroundClip'];

const THEMES = ['colorful', 'dark', 'dark-colorful', 'light'];

function styleOf(element: Element): string {
  return element.getAttribute('style') ?? '';
}

function renderPicker(): { orbs: HTMLElement[]; wordmark: HTMLElement } {
  const { container } = render(<WorkspacePicker />);
  const layer = container.querySelector('.pointer-events-none.overflow-hidden');
  return {
    orbs: Array.from(layer?.children ?? []) as HTMLElement[],
    wordmark: screen.getByText('Amux'),
  };
}

describe('workspace picker art tokens', () => {
  beforeEach(() => {
    usePaneStore.setState({ isCreating: false, loaded: true, panes: [], selectedPaneId: null });
    useProjectStore.setState({ activeProject: null, projectSwitching: false, projects: [] });
    useWorkspacePickerStore.setState({
      activeProjects: [],
      deletingRoot: null,
      historyEntries: [],
      isLoading: false,
      isOpen: true,
      search: '',
      selectedIndex: 0,
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
  });

  it('paints both orb layers from the workspace orb tokens', () => {
    // Act
    const { orbs } = renderPicker();

    // Assert
    expect(orbs).toHaveLength(ORB_LAYERS.length);
    expect(orbs.filter((orb, idx) => !styleOf(orb).includes(`var(${ORB_LAYERS[idx].token})`))).toEqual([]);
    expect(orbs.flatMap((orb) => RETIRED_ART_LITERALS.filter((literal) => styleOf(orb).includes(literal)))).toEqual([]);
  });

  it('keeps the orb composition, sizing, opacity and float animation intact', () => {
    // Act
    const { orbs } = renderPicker();

    // Assert
    expect(orbs.map((orb) => orb.className)).toEqual([
      'absolute top-1/2 left-1/2 w-[600px] h-[600px] rounded-full',
      'absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full opacity-[0.04]',
    ]);
    expect(orbs.filter((orb, idx) => !orb.className.includes(ORB_LAYERS[idx].box))).toEqual([]);
    expect(styleOf(orbs[0])).toContain('orb-float 6s ease-in-out infinite');
    expect(styleOf(orbs[1])).not.toContain('orb-float');
    expect(orbs[1].className).toContain(ORB_LAYERS[1].opacity);
  });

  it('paints the wordmark from the workspace wordmark tokens and clips it to the text', () => {
    // Act
    const { wordmark } = renderPicker();

    // Assert
    expect(styleOf(wordmark)).toContain(WORDMARK_GRADIENT);
    expect(RETIRED_ART_LITERALS.filter((literal) => styleOf(wordmark).includes(literal))).toEqual([]);
    expect(wordmark.className).toContain('text-[48px]');
    expect(screen.getByText('Multi-agent terminal')).toBeTruthy();
  });

  it('resolves the same token references in every theme so the art never becomes a dark island', () => {
    // Act
    const wiring = THEMES.map((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const { orbs, wordmark } = renderPicker();
      const entry = { orbs: orbs.map(styleOf), theme, wordmark: styleOf(wordmark) };
      cleanup();
      return entry;
    });

    // Assert
    expect(wiring.filter((entry) => !entry.wordmark.includes(WORDMARK_GRADIENT)).map((entry) => entry.theme)).toEqual([]);
    expect(
      wiring
        .filter((entry) => ORB_LAYERS.some((layer, idx) => !entry.orbs[idx].includes(`var(${layer.token})`)))
        .map((entry) => entry.theme),
    ).toEqual([]);
  });
});

describe('workspace picker art source', () => {
  it('drops every retired fixed art colour from the picker', () => {
    // Act
    const survivors = RETIRED_ART_LITERALS.filter((literal) =>
      PICKER_SOURCE.toLowerCase().includes(literal.toLowerCase()),
    );

    // Assert
    expect(survivors).toEqual([]);
  });

  it('wires every art surface to its semantic token', () => {
    // Act
    const gaps = ART_TOKENS.filter((token) => !PICKER_SOURCE.includes(token));

    // Assert
    expect(gaps).toEqual([]);
  });

  it('keeps the wordmark gradient clipped to the glyphs', () => {
    // Act
    const gaps = WORDMARK_CLIP_PROPS.filter((prop) => !PICKER_SOURCE.includes(prop));

    // Assert
    expect(gaps).toEqual([]);
  });
});
