// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHealthIndicator } from '../src/renderer/components/shared/ProviderHealthIndicator';
import type { ElectronSettings, ProviderStatus } from '../src/shared/ipc-types';
import { useElectronSettingsStore } from '../src/renderer/stores/electron-settings.store';
import { useProviderStatusStore } from '../src/renderer/stores/provider-status.store';

const openExternalMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/renderer/api/system.api', () => ({
  openExternal: (url: string) => openExternalMock(url),
}));

function buildAnthropicStatus(withArena = true): ProviderStatus {
  const now = Date.parse('2026-06-19T17:00:00.000Z');
  return {
    provider: 'anthropic',
    level: 'degraded',
    quality: {
      score: 64,
      level: 'degraded',
      trend: 'down',
      measuredAt: now - 30 * 60_000,
      arenaTotal: withArena ? 50 : undefined,
      models: [
        {
          id: '160',
          name: 'claude-sonnet-4-5-20250929',
          score: 66,
          status: 'good',
          trend: 'down',
          history: [70, 68, 66, 65, 66],
          measuredAt: now - 20 * 60_000,
          arena: withArena ? { rank: 9, elo: 1480, ci: 6, votes: 12000 } : undefined,
        },
        {
          id: '161',
          name: 'claude-opus-4-6',
          score: 63,
          status: 'warning',
          trend: 'stable',
          history: [60, 61, 62, 63, 63],
          measuredAt: now - 10 * 60_000,
          arena: withArena ? { rank: 4, elo: 1499, ci: 4, votes: 49596 } : undefined,
        },
      ],
    },
    operational: { level: 'ok', description: 'All Systems Operational' },
    sparkline: [62, 63, 64, 64, 63],
    updatedAt: now,
  };
}

function setShowArena(value: boolean) {
  useElectronSettingsStore.setState({
    settings: { showArenaScores: value, showAgentHealthTracker: false } as Partial<ElectronSettings> as ElectronSettings,
    isLoading: false,
  });
}

beforeEach(() => {
  openExternalMock.mockClear();
  useProviderStatusStore.setState({ statuses: { anthropic: buildAnthropicStatus() }, fetchedAt: Date.now() });
  setShowArena(false);
});

afterEach(() => {
  cleanup();
  useProviderStatusStore.setState({ statuses: {}, fetchedAt: 0 });
  useElectronSettingsStore.setState({ settings: null, isLoading: false });
});

describe('ProviderHealthIndicator', () => {
  it('renders the active model score in the trigger pill when modelId matches', () => {
    // Arrange & Act
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);

    // Assert — trigger button shows the active model's score (63), not the provider mean (64)
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('63');
    expect(trigger.textContent).not.toContain('64');
  });

  it('falls back to the provider average when modelId is unknown', () => {
    // Arrange & Act
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-bogus" />);

    // Assert — trigger button shows provider mean (64)
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('64');
  });

  it('matches a dated reported model id against the API short name', () => {
    // Arrange — Claude reports `claude-sonnet-4-5-20250929`, list also has dated form
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-sonnet-4-5-20250929" />);

    // Assert — exact-name match wins, score is 66
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('66');
  });

  it('does not match a too-short ambiguous prefix like "claude"', () => {
    // Arrange & Act — modelId 'claude' must NOT pick the first Anthropic model
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude" />);

    // Assert — falls back to provider mean, not 66 or 63
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('64');
  });

  it('resolves `claude-opus-latest` to the newest dated sibling, not the highest scorer', () => {
    // Arrange — three opus versions; the NEWEST (4-8) scores LOWER than older ones (4-5).
    // The test guards against the wrong heuristic of "pick the top-scored model in the family".
    const now = Date.parse('2026-06-19T17:00:00.000Z');
    useProviderStatusStore.setState({
      statuses: {
        anthropic: {
          provider: 'anthropic',
          level: 'degraded',
          quality: {
            score: 64,
            level: 'degraded',
            trend: 'down',
            measuredAt: now,
            models: [
              { id: '1', name: 'claude-opus-4-5', score: 67, status: 'good', trend: 'stable', history: [67] },
              { id: '2', name: 'claude-opus-4-6', score: 66, status: 'good', trend: 'stable', history: [66] },
              { id: '3', name: 'claude-opus-4-8', score: 61, status: 'warning', trend: 'down', history: [61] },
            ],
          },
          operational: { level: 'ok', description: 'All Systems Operational' },
          sparkline: [],
          updatedAt: now,
        },
      },
      fetchedAt: Date.now(),
    });

    // Act
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-latest" />);

    // Assert — picks 4-8 (newest), score 61 — NOT 67 (highest) or 64 (provider mean)
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('61');
    expect(trigger.textContent).not.toContain('67');
    expect(trigger.textContent).not.toContain('64');
  });

  it('returns provider average for `<family>-latest` when no dated sibling is listed', () => {
    // Arrange — only sonnet rows; haiku-latest has no concrete sibling to resolve to.
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-haiku-latest" />);

    // Assert — falls back to provider mean (64), no spurious match
    const trigger = screen.getByRole('button', { name: /model quality details/i });
    expect(trigger.textContent).toContain('64');
  });

  it('opens the popup, marks the active row, and survives mouse-move from trigger to popup', async () => {
    // Arrange
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    const trigger = screen.getByRole('button', { name: /model quality details/i });

    // Act — hover trigger to open
    fireEvent.mouseEnter(trigger);
    const popup = await screen.findByRole('tooltip', { name: /model quality details/i });

    // Move from trigger -> popup; trigger fires leave but popup fires enter,
    // so the closeTimer is cancelled and the popup must remain.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(popup);

    // Assert
    expect(popup).toBeTruthy();
    const activeChip = screen.getByText('Active');
    expect(activeChip).toBeTruthy();
    // Active model row is the first model row
    const opusRow = screen.getByRole('button', { name: /Open claude-opus-4-6/i });
    expect(opusRow).toBeTruthy();
  });

  it('opens the per-model aistupidlevel page when a model row is clicked', async () => {
    // Arrange — sonnet has id=160 in our fixture
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    const trigger = screen.getByRole('button', { name: /model quality details/i });

    // Act
    fireEvent.mouseEnter(trigger);
    await screen.findByRole('tooltip', { name: /model quality details/i });
    const sonnetRow = screen.getByRole('button', { name: /Open claude-sonnet-4-5-20250929/i });
    fireEvent.click(sonnetRow);

    // Assert
    await waitFor(() => expect(openExternalMock).toHaveBeenCalledTimes(1));
    expect(openExternalMock).toHaveBeenCalledWith('https://aistupidlevel.info/models/160');
  });

  it('falls back to the dashboard homepage when the model has no numeric id', async () => {
    // Arrange — replace fixture with a model missing id
    useProviderStatusStore.setState({
      statuses: {
        anthropic: {
          ...buildAnthropicStatus(),
          quality: {
            ...buildAnthropicStatus().quality,
            models: [
              {
                name: 'my-custom-alias',
                score: 70,
                status: 'good',
                trend: 'stable',
                history: [70],
              },
            ],
          },
        },
      },
      fetchedAt: Date.now(),
    });
    render(<ProviderHealthIndicator provider="anthropic" modelId="my-custom-alias" />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /model quality details/i }));
    await screen.findByRole('tooltip', { name: /model quality details/i });
    fireEvent.click(screen.getByRole('button', { name: /Open my-custom-alias/i }));

    // Assert
    await waitFor(() => expect(openExternalMock).toHaveBeenCalledTimes(1));
    expect(openExternalMock).toHaveBeenCalledWith('https://aistupidlevel.info');
  });

  it('opens the dashboard homepage when the footer is clicked', async () => {
    // Arrange
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    const trigger = screen.getByRole('button', { name: /model quality details/i });

    // Act
    fireEvent.mouseEnter(trigger);
    await screen.findByRole('tooltip', { name: /model quality details/i });
    const footer = screen.getByRole('button', { name: /Open AI Stupid Level dashboard for Anthropic/i });
    fireEvent.click(footer);

    // Assert
    await waitFor(() => expect(openExternalMock).toHaveBeenCalledTimes(1));
    expect(openExternalMock).toHaveBeenCalledWith('https://aistupidlevel.info');
  });

  it('renders nothing when provider is undefined', () => {
    // Arrange & Act
    const { container } = render(<ProviderHealthIndicator provider={undefined} />);

    // Assert
    expect(container.children.length).toBe(0);
  });

  it('hides the Arena column by default (toggle off)', async () => {
    // Arrange — default beforeEach sets showArena=false
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /model quality details/i }));
    const popup = await screen.findByRole('tooltip', { name: /model quality details/i });

    // Assert — neither the KPI cell nor per-row pills surface "Arena"/"#4"
    expect(popup.textContent).toContain('Benchmark');
    expect(popup.textContent).not.toContain('Arena');
    expect(popup.textContent).not.toContain('#4');
  });

  it('renders the two-up KPI grid with labeled sources, value, and Arena rank when the toggle is on', async () => {
    // Arrange
    setShowArena(true);
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    const trigger = screen.getByRole('button', { name: /model quality details/i });

    // Act
    fireEvent.mouseEnter(trigger);
    const popup = await screen.findByRole('tooltip', { name: /model quality details/i });

    // Assert — both KPI cells, labeled with their compact source label
    expect(popup.textContent).toContain('Benchmark');
    expect(popup.textContent).toContain('Arena');
    // Active-model values: bench 63 and Arena rank #4 of 50
    expect(popup.textContent).toContain('63');
    expect(popup.textContent).toContain('#4');
    expect(popup.textContent).toContain('of 50');
  });

  it('shows Bench and Arena column headers above the model rows when toggle is on and rows have Arena data', async () => {
    // Arrange
    setShowArena(true);
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /model quality details/i }));
    await screen.findByRole('tooltip', { name: /model quality details/i });

    // Assert — column header "Bench" appears only here, so we can match it uniquely
    expect(screen.getByText('Bench')).toBeTruthy();
    // Per-row Arena pills: #4 (active) and #9 (sonnet)
    const opusRow = screen.getByRole('button', { name: /Open claude-opus-4-6/i });
    expect(opusRow.textContent).toContain('#4');
    const sonnetRow = screen.getByRole('button', { name: /Open claude-sonnet-4-5-20250929/i });
    expect(sonnetRow.textContent).toContain('#9');
  });

  it('hides Arena column entirely when toggle is on but no row has Arena data', async () => {
    // Arrange
    setShowArena(true);
    useProviderStatusStore.setState({
      statuses: { anthropic: buildAnthropicStatus(false) },
      fetchedAt: Date.now(),
    });
    render(<ProviderHealthIndicator provider="anthropic" modelId="claude-opus-4-6" />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /model quality details/i }));
    const popup = await screen.findByRole('tooltip', { name: /model quality details/i });

    // Assert — column header "Bench" is the canonical "models table" marker; it's still present.
    // The Arena KPI cell still shows "Not ranked" as the empty state.
    expect(screen.getByText('Bench')).toBeTruthy();
    expect(popup.textContent).toContain('Not ranked');
    // No per-row Arena rank pill should be rendered
    const opusRow = screen.getByRole('button', { name: /Open claude-opus-4-6/i });
    expect(opusRow.textContent).not.toMatch(/#\d/);
  });
});
