import { beforeEach, describe, expect, it, vi } from 'vitest';

const displayPaneFormatMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/services/terminal-stream-state.js', () => ({
  displayPaneFormat: displayPaneFormatMock,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    warn: vi.fn(),
  },
}));

import {
  isTerminalPaneMissingError,
  readPaneDimensions,
  TerminalPaneMissingError,
} from '../../src/main/services/terminal-pane-dimensions';

describe('readPaneDimensions', () => {
  beforeEach(() => {
    displayPaneFormatMock.mockReset();
  });

  it('parses tmux pane dimensions', async () => {
    // Arrange
    displayPaneFormatMock.mockResolvedValue('120x40:@9:120x40:1');

    // Act
    const dimensions = await readPaneDimensions('%9');

    // Assert
    expect(dimensions).toEqual({
      cols: 120, rows: 40, windowCols: 120, windowId: '@9', windowPanes: 1, windowRows: 40,
    });
  });

  it('parses window dimensions and window pane count independently from pane dimensions when they diverge', async () => {
    // Arrange — the `window-size manual` mismatch that causes a dot-fill client:
    // the pane and the window it lives in report different sizes.
    displayPaneFormatMock.mockResolvedValue('100x30:@9:120x40:3');

    // Act
    const dimensions = await readPaneDimensions('%9');

    // Assert
    expect(dimensions).toEqual({
      cols: 100, rows: 30, windowCols: 120, windowId: '@9', windowPanes: 3, windowRows: 40,
    });
  });

  it('throws a typed error when tmux reports a missing pane', async () => {
    // Arrange
    displayPaneFormatMock.mockRejectedValue(new Error("can't find pane: %404"));

    // Act
    const result = readPaneDimensions('%404');

    // Assert
    await expect(result).rejects.toBeInstanceOf(TerminalPaneMissingError);
    await expect(result).rejects.toMatchObject({ tmuxPaneId: '%404' });
  });

  it('throws a typed error when tmux returns malformed dimensions for a stale pane target', async () => {
    // Arrange
    displayPaneFormatMock
      .mockResolvedValueOnce('x:')
      .mockResolvedValueOnce('');

    // Act
    const result = readPaneDimensions('%404');

    // Assert
    await expect(result).rejects.toBeInstanceOf(TerminalPaneMissingError);
    expect(displayPaneFormatMock).toHaveBeenNthCalledWith(2, '%404', '#{pane_id}');
  });

  it('recognizes missing-pane errors without depending on a single tmux message', () => {
    // Arrange
    const errors = [
      new Error("can't find pane: %404"),
      new Error('no such pane: %404'),
      new TerminalPaneMissingError('%404', new Error('wrapped')),
    ];

    // Act
    const recognized = errors.map((error) => isTerminalPaneMissingError(error));

    // Assert
    expect(recognized).toEqual([true, true, true]);
  });
});
