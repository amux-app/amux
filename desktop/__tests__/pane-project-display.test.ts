import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaneProjectDisplay } from '../src/renderer/lib/pane-project-display';

const PROJECT_ROOT = path.join(os.tmpdir(), 'amux-test', 'amux');
const OTHER_ROOT = path.join(os.tmpdir(), 'amux-test', 'Luxury-Cosmetics-Emporium');

describe('resolvePaneProjectDisplay', () => {
  it('prefers the pane project over the active project', () => {
    const display = resolvePaneProjectDisplay(
      {
        projectName: 'Luxury-Cosmetics-Emporium',
        projectRoot: OTHER_ROOT,
      },
      {
        name: 'amux',
        root: PROJECT_ROOT,
      },
    );

    expect(display).toEqual({
      initial: 'L',
      name: 'Luxury-Cosmetics-Emporium',
      root: OTHER_ROOT,
    });
  });

  it('derives the pane project name from the pane root', () => {
    const display = resolvePaneProjectDisplay(
      {
        projectRoot: `${OTHER_ROOT}/`,
      },
      {
        name: 'amux',
        root: PROJECT_ROOT,
      },
    );

    expect(display?.name).toBe('Luxury-Cosmetics-Emporium');
    expect(display?.root).toBe(OTHER_ROOT);
  });

  it('falls back to the active project for legacy panes without project metadata', () => {
    const display = resolvePaneProjectDisplay(
      {},
      {
        name: 'amux',
        root: PROJECT_ROOT,
      },
    );

    expect(display).toEqual({
      initial: 'A',
      name: 'amux',
      root: PROJECT_ROOT,
    });
  });
});
