import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = join(__dirname, '../../src/main/services/PaneMonitor.ts');

describe('PaneMonitor wiring', () => {
  it('subscribes the detector before monitoring so the first status edge reaches the callback', () => {
    // Arrange
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    const subscribeIndex = source.indexOf("detector.on('status-updated'");
    const monitorIndex = source.indexOf('detector.monitorPanes(panes)');

    // Act / Assert — PaneActivityService is now the sole status writer;
    // PaneMonitor only forwards the raw detector event via its callback.
    expect(subscribeIndex).toBeGreaterThanOrEqual(0);
    expect(monitorIndex).toBeGreaterThan(subscribeIndex);
    expect(source).toMatch(/this\.onStatusDetected\?\.\(event\)/);
    expect(source).toMatch(/detector\.off\(\s*['"]status-updated['"]/);
    expect(source).not.toMatch(/arbiter/i);
  });
});
