// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewLaunchButton } from '../src/renderer/components/dashboard/ReviewLaunchButton';
import { SendFixesConfirmDialog } from '../src/renderer/components/dashboard/SendFixesConfirmDialog';
import { SupportBundleDialog } from '../src/renderer/components/settings/SupportBundleDialog';
import { StatusDot } from '../src/renderer/components/shared/StatusDot';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { useReviewLaunchStore } from '../src/renderer/stores/review-launch.store';

const listAgentsMock = vi.hoisted(() => vi.fn());
const previewSupportBundleMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/agent.api', () => ({
  listAgents: listAgentsMock,
  refreshAgents: vi.fn(),
}));

vi.mock('../src/renderer/api/system.api', () => ({
  exportSupportBundle: vi.fn(),
  previewSupportBundle: previewSupportBundleMock,
  revealPath: vi.fn(),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({ sendFixesToAuthor: vi.fn(), startReview: vi.fn() }),
}));

const COMPONENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/components');
const THEME_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/theme.css'),
  'utf8',
);
const ACCENT_CONTRAST_CLASS = 'text-[var(--accent-contrast)]';
const RETIRED_LITERALS = ['#06281c', '#03070d'];
const STATUS_DOT_FILE = 'shared/StatusDot.tsx';
const THEMES = ['colorful', 'dark', 'dark-colorful', 'light'];
const SIZES = ['sm', 'md', 'lg'] as const;

type DotSize = (typeof SIZES)[number];

const SIZE_CONTRACT: Record<DotSize, { box: string; check: string }> = {
  lg: { box: 'h-3 w-3', check: '8' },
  md: { box: 'h-2.5 w-2.5', check: '7' },
  sm: { box: 'h-2 w-2', check: '6' },
};

const TOKEN_SOURCES: Array<[string, string[]]> = [
  ['dashboard/ReviewLaunchButton.tsx', ['--accent-contrast']],
  ['dashboard/SendFixesConfirmDialog.tsx', ['--accent-contrast']],
  ['settings/SupportBundleDialog.tsx', ['--accent-contrast']],
  [STATUS_DOT_FILE, ['--attention-ready-dot', '--attention-ready-icon']],
];

const REVIEW_PANE: AumxPane = {
  agent: 'claude',
  id: 'review-pane',
  paneId: '%1',
  prompt: 'review the change',
  review: { role: 'reviewer', sourcePaneId: 'source-pane', sourceSlug: 'add-login' },
  slug: 'review-add-login',
};

function sourceOf(file: string): string {
  return readFileSync(resolve(COMPONENT_ROOT, file), 'utf8');
}

interface ReadyWiring {
  box: string;
  check: string;
  ink: string;
  size: DotSize;
  theme: string;
}

function readyWiring(theme: string, size: DotSize): ReadyWiring {
  const view = render(<StatusDot status="idle" ready size={size} />);
  const dot = screen.getByRole('status');
  const check = view.container.querySelector('svg');
  const wiring = {
    box: dot.className,
    check: check?.getAttribute('width') ?? '',
    ink: check?.getAttribute('class') ?? '',
    size,
    theme,
  };
  view.unmount();
  return wiring;
}

function allReadyWiring(): ReadyWiring[] {
  return THEMES.flatMap((theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    return SIZES.map((size) => readyWiring(theme, size));
  });
}

function describeWiring({ size, theme }: ReadyWiring): string {
  return `${theme}/${size}`;
}

describe('retired hard-coded colours', () => {
  it('drops every dark-only literal from the attention and accent surfaces', () => {
    // Act
    const survivors = TOKEN_SOURCES.flatMap(([file]) =>
      RETIRED_LITERALS.filter((literal) =>
        new RegExp(literal, 'i').test(sourceOf(file)),
      ).map((literal) => `${file} still uses ${literal}`),
    );

    // Assert
    expect(survivors).toEqual([]);
  });

  it('wires every surface to its semantic token instead', () => {
    // Act
    const gaps = TOKEN_SOURCES.flatMap(([file, tokens]) =>
      tokens.filter((token) => !sourceOf(file).includes(token)).map((token) => `${file} is missing ${token}`),
    );

    // Assert
    expect(gaps).toEqual([]);
  });

  it('ships the ready dot flat, with no white highlight lifting the check off it', () => {
    // Act
    const lifted = sourceOf(STATUS_DOT_FILE)
      .split('\n')
      .filter((line) => line.includes('attention-ready-dot') && line.includes('white'));

    // Assert
    expect(lifted).toEqual([]);
  });
});

describe('sidebar diff palette', () => {
  it('uses softly lightened success and error roles for additions and deletions', () => {
    expect(THEME_SOURCE).toContain(
      '--sidebar-diff-addition: color-mix(in srgb, var(--success) 46%, var(--sidebar-text));',
    );
    expect(THEME_SOURCE).toContain(
      '--sidebar-diff-deletion: color-mix(in srgb, var(--error) 46%, var(--sidebar-text));',
    );
  });
});

describe('StatusDot token wiring', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
  });

  it('paints the ready dot and check from the attention tokens in every theme', () => {
    // Act
    const wiring = allReadyWiring();

    // Assert
    expect(wiring.filter((entry) => !entry.box.includes('bg-[var(--attention-ready-dot)]')).map(describeWiring)).toEqual([]);
    expect(wiring.filter((entry) => !entry.ink.includes('text-[var(--attention-ready-icon)]')).map(describeWiring)).toEqual([]);
    expect(wiring.filter((entry) => entry.box.includes('--agent-idle')).map(describeWiring)).toEqual([]);
  });

  it('keeps the sm/md/lg size contract unchanged', () => {
    // Act
    const wiring = allReadyWiring();

    // Assert
    expect(wiring.filter((entry) => !entry.box.includes(SIZE_CONTRACT[entry.size].box)).map(describeWiring)).toEqual([]);
    expect(new Set(wiring.map((entry) => `${entry.size}=${entry.check}`))).toEqual(
      new Set(SIZES.map((size) => `${size}=${SIZE_CONTRACT[size].check}`)),
    );
  });

  it('leaves the non-ready states on their own role tokens', () => {
    // Arrange
    document.documentElement.setAttribute('data-theme', 'light');

    // Act
    const { container } = render(<StatusDot status="working" />);
    const dot = screen.getByRole('status', { name: 'working' });

    // Assert
    expect(dot.className).toContain('bg-[var(--agent-working)]');
    expect(dot.className).toContain('animate-[pulse-dot_1.5s_ease-in-out_infinite]');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('keeps the idle role on --agent-idle when the pane is not ready', () => {
    // Act
    render(<StatusDot status="idle" />);

    // Assert
    expect(screen.getByRole('status', { name: 'idle' }).className).toContain('bg-[var(--agent-idle)]');
  });
});

describe('accent action labels', () => {
  beforeEach(() => {
    listAgentsMock.mockResolvedValue(['claude']);
    previewSupportBundleMock.mockResolvedValue({
      files: [{ category: 'metadata', name: 'metadata/session.json', sizeBytes: 100 }],
      includeTranscripts: false,
      redactionNote: 'redacted',
      totalBytes: 100,
    });
    useAgentSessionStore.setState({ sessions: {} });
    useReviewLaunchStore.setState({ launchingIds: new Set() });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the support-bundle export button on the accent contrast token and its preview gate', async () => {
    // Act
    render(<SupportBundleDialog onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Export bundle' });

    // Assert
    expect(button.className).toContain(ACCENT_CONTRAST_CLASS);
    expect(button.hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('keeps the send-fixes button on the accent contrast token and its findings gate', () => {
    // Act
    render(<SendFixesConfirmDialog reviewPane={REVIEW_PANE} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Confirm send fixes' });

    // Assert
    expect(button.className).toContain(ACCENT_CONTRAST_CLASS);
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('keeps the start-review button on the accent contrast token and its loading gate', async () => {
    // Arrange
    render(<ReviewLaunchButton paneId="source-pane" />);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    const loading = screen.getByRole('button', { name: 'Loading…' });

    // Assert
    expect(loading.className).toContain(ACCENT_CONTRAST_CLASS);
    expect(loading.hasAttribute('disabled')).toBe(true);
    await waitFor(() => {
      const ready = screen.getByRole('button', { name: 'Start Review' });
      expect(ready.className).toContain(ACCENT_CONTRAST_CLASS);
      expect(ready.hasAttribute('disabled')).toBe(false);
    });
  });
});
