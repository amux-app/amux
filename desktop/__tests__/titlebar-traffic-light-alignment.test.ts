import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TITLEBAR_LIGHTS_GUTTER,
  TITLEBAR_STRIP_HEIGHT,
  TRAFFIC_LIGHT_CENTER_Y,
  TRAFFIC_LIGHT_ORIGIN,
  TRAFFIC_LIGHT_RIGHT_EDGE,
} from '../src/shared/titlebar-metrics';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Tailwind's spacing scale is 4px per step, so `h-11` is 44px. */
const TAILWIND_STEP_PX = 4;

function source(relativePath: string): string {
  return readFileSync(resolve(SRC_ROOT, relativePath), 'utf8');
}

describe('titlebar traffic-light alignment', () => {
  it('pins the measured light geometry', () => {
    // Assert — values confirmed by screencapture of the real window (both windowed
    // and maximized): light centre 22px below the window top, green edge at 76px.
    expect(TRAFFIC_LIGHT_ORIGIN).toEqual({ x: 18, y: 16 });
    expect(TRAFFIC_LIGHT_CENTER_Y).toBe(22);
    expect(TRAFFIC_LIGHT_RIGHT_EDGE).toBe(76);
    expect(TITLEBAR_LIGHTS_GUTTER).toBe(86);
  });

  it('keeps the strip centre line on the lights', () => {
    // Assert — the cluster is flex-centred, so this equality is what makes it land
    // on the lights instead of near them.
    expect(TITLEBAR_STRIP_HEIGHT / 2).toBe(TRAFFIC_LIGHT_CENTER_Y);
  });

  it('renders the strip at the height that equality requires', () => {
    // Arrange
    const appShell = source('renderer/components/layout/AppShell.tsx');

    // Assert — a strip height or gutter that stops matching the shared geometry
    // silently drifts the cluster off the lights, which is how this last regressed.
    expect(appShell).toContain(`h-${TITLEBAR_STRIP_HEIGHT / TAILWIND_STEP_PX}`);
    expect(appShell).toContain(`pl-[${TITLEBAR_LIGHTS_GUTTER}px]`);
  });

  it('drives the window buttons from the same constant', () => {
    // Assert — main must not re-declare the origin the renderer lays out against.
    const main = source('main/index.ts');
    expect(main).toContain('trafficLightPosition: TRAFFIC_LIGHT_ORIGIN');
    expect(main).not.toMatch(/trafficLightPosition:\s*\{/);
  });
});
