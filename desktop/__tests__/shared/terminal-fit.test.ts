// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import {
  fitTerminalToContainer,
  type TerminalFitAddon,
  type TerminalFitHost,
} from '../../src/renderer/lib/terminal-fit';

function sizedElement(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
  element.getBoundingClientRect = () => makeRect(width, height);
  return element;
}

function makeRect(width: number, height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: width,
    toJSON: () => ({}),
    top: 0,
    width,
    x: 0,
    y: 0,
  } as DOMRect;
}

function makeTerminal(cols = 80, rows = 24): TerminalFitHost {
  const terminal: TerminalFitHost = {
    cols,
    element: document.createElement('div'),
    options: {
      fontSize: 12,
    },
    resize: (nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    },
    rows,
  };
  terminal.resize = vi.fn(terminal.resize);
  return terminal;
}

describe('fitTerminalToContainer', () => {
  it('does not use xterm default dimensions when the fit addon cannot measure yet', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(400, 120);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => undefined),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container);

    // Assert
    expect(size).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it('returns dimensions only after the fit addon has measured the container', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(400, 120);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(() => {
        terminal.cols = 33;
        terminal.rows = 8;
      }),
      proposeDimensions: vi.fn(() => ({ cols: 33, rows: 8 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container);

    // Assert
    expect(size).toEqual({ cols: 33, rows: 8 });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
  });

  it('rejects measured dimensions that are too small for attach', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(400, 120);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 1 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container);

    // Assert
    expect(size).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
  });

  it('shrinks dimensions when the fitted xterm screen overflows the container', () => {
    // Arrange
    const terminal = makeTerminal();
    const screenElement = document.createElement('div');
    screenElement.className = 'xterm-screen';
    terminal.element?.appendChild(screenElement);
    // Model a real xterm: after `resize`, the rendered screen matches the
    // new cell count. Rendered size is one cell over the container until we
    // trim to (33, 8).
    const CELL_WIDTH = 401 / 34;
    const CELL_HEIGHT = 121 / 9;
    screenElement.getBoundingClientRect = () => makeRect(
      terminal.cols * CELL_WIDTH,
      terminal.rows * CELL_HEIGHT,
    );
    const container = sizedElement(400, 120);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(() => {
        terminal.cols = 34;
        terminal.rows = 9;
      }),
      proposeDimensions: vi.fn(() => ({ cols: 34, rows: 9 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container);

    // Assert
    expect(size).toEqual({ cols: 33, rows: 8 });
    expect(terminal.resize).toHaveBeenCalledWith(33, 8);
  });

  it('keeps constrained cols at the agent minimum while reporting honest rows in small cards', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(320, 120);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 45, rows: 9 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 80, rows: 9 });
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.resize).toHaveBeenCalledWith(80, 9);
    expect(terminal.options?.fontSize).toBe(11);
  });

  it('never scales constrained terminals above their configured font size', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(760, 300);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 79, rows: 23 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 80, rows: 23 });
    expect(terminal.options?.fontSize).toBeGreaterThanOrEqual(11);
    expect(terminal.options?.fontSize).toBeLessThanOrEqual(12);
    expect(Number.isInteger(terminal.options?.fontSize)).toBe(true);
  });

  it('preserves honest rows when only rows fall below the constrained minimum', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(960, 260);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 120, rows: 20 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 120, rows: 20 });
    expect(terminal.resize).toHaveBeenCalledWith(120, 20);
    expect(terminal.options?.fontSize).toBe(11);
  });

  it('shrinks rows below 24 while keeping cols at 80 for a tiny agent cell', () => {
    // Arrange
    const proposals = [
      { cols: 50, rows: 12 },
      { cols: 50, rows: 12 },
    ];
    const terminal = makeTerminal();
    const container = sizedElement(300, 200);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 50, rows: 12 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size?.cols).toBe(80);
    expect(size?.rows).toBe(12);
    expect(size?.rows).toBeLessThan(24);
    expect(size?.rows).toBeGreaterThanOrEqual(8);
    expect(fitAddon.fit).not.toHaveBeenCalled();
  });

  it('re-proposes rows at the clamped font so honest rows differ from base-font rows', () => {
    // Arrange: first propose (base font) is small enough to constrain; second
    // propose (after font clamp shrinks the cell) yields the honest smaller rows.
    const proposals = [
      { cols: 60, rows: 18 },
      { cols: 70, rows: 14 },
    ];
    const terminal = makeTerminal();
    const container = sizedElement(360, 220);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 70, rows: 14 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 80, rows: 14 });
    expect(terminal.resize).toHaveBeenCalledWith(80, 14);
  });

  it('leaves the unconstrained path unchanged when the cell fits 80x24', () => {
    // Arrange
    const terminal = makeTerminal();
    const container = sizedElement(1200, 600);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(() => {
        terminal.cols = 120;
        terminal.rows = 40;
      }),
      proposeDimensions: vi.fn(() => ({ cols: 120, rows: 40 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 120, rows: 40 });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(fitAddon.proposeDimensions).toHaveBeenCalledTimes(1);
    expect(terminal.options?.fontSize).toBe(12);
  });

  it('locks to exactly fixedCols without enlarging the font when the cell is wider than the profile', () => {
    // Arrange: the cell can fit 150 cols at the configured base font. The
    // fixed profile keeps 100 cols and leaves the remaining width as breathing
    // room instead of enlarging terminal text beyond the user's setting.
    const proposals = [
      { cols: 150, rows: 40 },
      { cols: 100, rows: 60 },
    ];
    const terminal = makeTerminal();
    const container = sizedElement(1200, 600);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 100, rows: 60 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
    });

    // Assert: cols pinned to exactly 100, honest rows from the re-propose, and
    // the font remains at (never above) the configured base size.
    expect(size?.cols).toBe(100);
    expect(size?.rows).toBe(60);
    expect(terminal.resize).toHaveBeenCalledWith(100, 60);
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.options?.fontSize).toBe(12);
  });

  it('reports a fixed profile as too narrow instead of rendering unreadable glyphs below 8px', () => {
    // Arrange: a narrow cell can fit the persisted grid only below the
    // readable 8px floor.
    const terminal = makeTerminal();
    const container = sizedElement(360, 300);
    const onFailure = vi.fn();
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({
        cols: (terminal.options?.fontSize ?? 12) <= 7 ? 100 : 60,
        rows: 20,
      })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
      onFailure,
    });

    // Assert
    expect(size).toBeNull();
    expect(terminal.options?.fontSize).toBe(8);
    expect(onFailure).toHaveBeenCalledWith('too-narrow');
  });

  it('scales a fixed-width terminal below the ordinary agent font minimum until every column fits', () => {
    // Arrange: at the normal 11px agent minimum the cell can only hold 72
    // columns. The fixed-width path must keep stepping down and re-measuring
    // until all 100 persisted columns fit instead of clipping the right edge.
    const terminal = makeTerminal();
    const container = sizedElement(360, 240);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => {
        const fontSize = terminal.options?.fontSize ?? 12;
        if (fontSize >= 11) return { cols: 72, rows: 18 };
        if (fontSize >= 9) return { cols: 94, rows: 24 };
        return { cols: 106, rows: 28 };
      }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
    });

    // Assert
    expect(size).toEqual({ cols: 100, rows: 28 });
    expect(terminal.options?.fontSize).toBe(8);
    expect(fitAddon.proposeDimensions).toHaveBeenCalledTimes(2);
  });

  it('reports too narrow when rendered metrics still overflow at the readable floor', () => {
    // Arrange: proposeDimensions claims 100 columns fit, but the rendered
    // screen is one pixel too wide at 8px and only fits at 7px. The DOM check
    // is the final authority, but readability wins over microscopic glyphs.
    const terminal = makeTerminal();
    const container = sizedElement(360, 240);
    const onFailure = vi.fn();
    const screenElement = document.createElement('div');
    screenElement.className = 'xterm-screen';
    screenElement.getBoundingClientRect = () => makeRect(
      (terminal.options?.fontSize ?? 12) > 7 ? 361 : 350,
      200,
    );
    terminal.element?.appendChild(screenElement);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 20 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
      onFailure,
    });

    // Assert
    expect(size).toBeNull();
    expect(terminal.options?.fontSize).toBe(8);
    expect(onFailure).toHaveBeenCalledWith('too-narrow');
  });

  it('uses honest small-card rows so the bottom composer row remains inside the visible screen', () => {
    // Arrange: reporting an artificial eight-row floor for a three-row cell
    // makes xterm taller than its viewport and clips the bottom/composer row.
    const terminal = makeTerminal();
    const container = sizedElement(360, 54);
    const proposals = [
      { cols: 60, rows: 3 },
      { cols: 100, rows: 3 },
    ];
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 100, rows: 3 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
    });

    // Assert
    expect(size).toEqual({ cols: 100, rows: 3 });
    expect(terminal.resize).toHaveBeenLastCalledWith(100, 3);
  });

  it('floors (never rounds up) the fixed-width font so fixedCols cannot overflow the container', () => {
    // Arrange: the cell proposes 97 cols at base 12 → scale 0.97 → 11.64.
    // Rounding UP to 12 would make 100 cols wider than the container and clip
    // the fixed profile's right edge; the fixed-width branch must floor to 11.
    const proposals = [
      { cols: 97, rows: 40 },
      { cols: 100, rows: 42 },
    ];
    const terminal = makeTerminal();
    const container = sizedElement(1200, 600);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 100, rows: 42 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 1,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
    });

    // Assert: font floored to 11 (not rounded to 12), cols pinned to 100.
    expect(size?.cols).toBe(100);
    expect(terminal.options?.fontSize).toBe(11);
    expect(Number.isInteger(terminal.options?.fontSize)).toBe(true);
  });

  it('reports honest fixed-width rows when the re-propose yields very few rows', () => {
    // Arrange
    const proposals = [
      { cols: 120, rows: 30 },
      { cols: 100, rows: 3 },
    ];
    const terminal = makeTerminal();
    const container = sizedElement(900, 90);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => proposals.shift() ?? { cols: 100, rows: 3 }),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
      fixedCols: 100,
    });

    // Assert: an artificial row floor would make xterm taller than the card and
    // hide its bottom/composer row.
    expect(size?.cols).toBe(100);
    expect(size?.rows).toBe(3);
  });

  it('restores the configured font size when constrained terminals have enough room', () => {
    // Arrange
    const terminal = makeTerminal();
    terminal.options!.fontSize = 9;
    const container = sizedElement(900, 420);
    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(() => {
        terminal.cols = 100;
        terminal.rows = 32;
      }),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 32 })),
    };

    // Act
    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    // Assert
    expect(size).toEqual({ cols: 100, rows: 32 });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(terminal.options?.fontSize).toBe(12);
  });

  it('shrinks constrained terminals below the min when the container cannot fit them', () => {
    // Constrained-branch pathology: the container is short enough that even
    // 24 rows at the min font size (11px) overflow, so the previous
    // implementation returned {80, 24} and let overflow-hidden clip the
    // bottom of the pane. Now we should trim rows until the screen fits.
    const terminal = makeTerminal();
    const container = sizedElement(320, 200);
    const screenElement = document.createElement('div');
    screenElement.className = 'xterm-screen';
    terminal.element?.appendChild(screenElement);

    const CELL_HEIGHT = 14;
    const CELL_WIDTH = 4;
    screenElement.getBoundingClientRect = () => makeRect(
      terminal.cols * CELL_WIDTH,
      terminal.rows * CELL_HEIGHT,
    );

    const fitAddon: TerminalFitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 45, rows: 12 })),
    };

    const size = fitTerminalToContainer(fitAddon, terminal, container, {
      baseFontSize: 12,
      minFontSize: 11,
      minCols: 80,
      minRows: 24,
    });

    expect(size).not.toBeNull();
    // Screen must fit inside the container (14px * rows ≤ 200 → rows ≤ 14).
    expect(size?.rows).toBeLessThanOrEqual(14);
    expect(terminal.rows).toBe(size?.rows);
  });
});
