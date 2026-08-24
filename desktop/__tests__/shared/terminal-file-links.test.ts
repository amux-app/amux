import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalFileLinkProvider,
  findTerminalFileLinks,
} from '../../src/renderer/lib/terminal-file-links';

describe('terminal file links', () => {
  it('detects workspace-relative file references with line numbers', () => {
    expect(findTerminalFileLinks('see src/app.ts:42 and package.json:7.', '/repo')).toEqual([
      {
        lineNumber: 42,
        relativePath: 'src/app.ts',
        startIndex: 4,
        text: 'src/app.ts:42',
      },
      {
        lineNumber: 7,
        relativePath: 'package.json',
        startIndex: 22,
        text: 'package.json:7',
      },
    ]);
  });

  it('maps absolute paths only when they are inside the pane root', () => {
    expect(findTerminalFileLinks('/repo/src/app.ts:42 /other/src/app.ts:99', '/repo')).toEqual([
      expect.objectContaining({
        lineNumber: 42,
        relativePath: 'src/app.ts',
        text: '/repo/src/app.ts:42',
      }),
    ]);
  });

  it('rejects parent traversal and URL-looking text', () => {
    expect(findTerminalFileLinks('../secret.ts:1 ./src/app.ts:2 http://host/src/app.ts:3', '/repo')).toEqual([
      expect.objectContaining({
        lineNumber: 2,
        relativePath: 'src/app.ts',
        text: './src/app.ts:2',
      }),
    ]);
  });

  it('provides xterm links that open through the supplied callback', () => {
    const onOpen = vi.fn();
    const terminal = {
      buffer: {
        active: {
          getLine: (index: number) => index === 0
            ? { translateToString: () => 'open src/app.ts:42' }
            : undefined,
        },
      },
    };
    const provider = createTerminalFileLinkProvider({
      onOpen,
      rootPath: '/repo',
      terminal: terminal as never,
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks).toEqual([
      expect.objectContaining({
        range: {
          end: { x: 18, y: 1 },
          start: { x: 6, y: 1 },
        },
        text: 'src/app.ts:42',
      }),
    ]);

    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    providedLinks?.[0]?.activate(event, 'src/app.ts:42');

    expect(onOpen).toHaveBeenCalledWith({
      lineNumber: 42,
      relativePath: 'src/app.ts',
      startIndex: 5,
      text: 'src/app.ts:42',
    }, event);
  });

  it('maps link ranges through buffer cells when wide characters precede the path', () => {
    const terminalLine = '界 see src/app.ts:42';
    const cells = ['界', '', ' ', 's', 'e', 'e', ' ', ...'src/app.ts:42'];
    const terminal = {
      buffer: {
        active: {
          getLine: (index: number) => index === 0
            ? {
                length: cells.length,
                getCell: (cellIndex: number) => {
                  const chars = cells[cellIndex];
                  return chars === undefined ? undefined : { getChars: () => chars };
                },
                translateToString: () => terminalLine,
              }
            : undefined,
        },
      },
    };
    const provider = createTerminalFileLinkProvider({
      onOpen: vi.fn(),
      rootPath: '/repo',
      terminal: terminal as never,
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks?.[0]?.range).toEqual({
      end: { x: 20, y: 1 },
      start: { x: 8, y: 1 },
    });
  });
});
