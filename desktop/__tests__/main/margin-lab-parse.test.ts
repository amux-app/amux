import { describe, expect, it } from 'vitest';
import { parseMarginLabPage, trackerUrlFor } from '../../src/main/services/margin-lab-parse';

const SAMPLE_DAILY = [
  { date: '2026-06-19', passRate: 67.2, ciLower: 52.1, ciUpper: 79.0, runsCount: 49, displayRunsCount: 50, passed: 33 },
  { date: '2026-06-20', passRate: 68.18, ciLower: 53.44, ciUpper: 80.0, runsCount: 44, displayRunsCount: 50, passed: 30 },
];

function buildPage(dailyJson: string): string {
  return `<html><head></head><body><script>(function(){const dailyChartData = ${dailyJson}, weeklyChartData = []; window.__init = 1;})()</script></body></html>`;
}

describe('parseMarginLabPage', () => {
  it('extracts the most recent daily entry and shapes it into an AgentHealthSnapshot', () => {
    // Arrange
    const html = buildPage(JSON.stringify(SAMPLE_DAILY));

    // Act
    const snapshot = parseMarginLabPage(html, 'claude', 1_000_000);

    // Assert
    expect(snapshot).toEqual({
      agent: 'claude',
      trackedModel: 'claude-opus-4-x',
      passRate: 68.2,
      ciLower: 53.4,
      ciUpper: 80.0,
      passed: 30,
      displayRunsCount: 50,
      date: '2026-06-20',
      measuredAt: 1_000_000,
      trackerUrl: trackerUrlFor('claude'),
    });
  });

  it('returns null when the dailyChartData regex misses', () => {
    // Arrange
    const html = '<html><body>no inline script here</body></html>';

    // Act
    const snapshot = parseMarginLabPage(html, 'codex', 2_000_000);

    // Assert
    expect(snapshot).toBeNull();
  });

  it('returns null when the array is empty', () => {
    // Arrange
    const html = buildPage('[]');

    // Act
    const snapshot = parseMarginLabPage(html, 'codex', 0);

    // Assert
    expect(snapshot).toBeNull();
  });

  it('filters out malformed entries and uses the last well-formed one', () => {
    // Arrange — first entry missing required fields, second entry valid
    const partial = [
      { date: '2026-06-19', passRate: 50 }, // missing ciLower etc — filtered
      SAMPLE_DAILY[0],
    ];
    const html = buildPage(JSON.stringify(partial));

    // Act
    const snapshot = parseMarginLabPage(html, 'codex', 1_000);

    // Assert
    expect(snapshot?.date).toBe('2026-06-19');
    expect(snapshot?.passRate).toBe(67.2);
  });
});
