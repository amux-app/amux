// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorBanner } from '../src/renderer/components/agent-devtools/tool-viewers/CodeView';
import { EditToolViewer } from '../src/renderer/components/agent-devtools/tool-viewers/EditToolViewer';
import { WriteToolViewer } from '../src/renderer/components/agent-devtools/tool-viewers/WriteToolViewer';
import type { NormalizedToolCall } from '../src/shared/agent-session-types';

function makeToolCall(name: string, input: Record<string, unknown>): NormalizedToolCall {
  return { id: 'tool-1', input, name };
}

describe('tool viewers', () => {
  afterEach(() => cleanup());

  it('renders an Edit as a diff with one removed and one added line', async () => {
    // Arrange
    const toolCall = makeToolCall('Edit', {
      file_path: '/repo/app.ts',
      new_string: 'const answer = 2;',
      old_string: 'const answer = 1;',
    });

    // Act
    const { container, getByText } = render(<EditToolViewer toolCall={toolCall} />);

    // Assert
    expect(getByText('/repo/app.ts')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).toBeTruthy());
  });

  it('syntax-highlights Write content based on the file extension', async () => {
    // Arrange
    const toolCall = makeToolCall('Write', {
      content: 'def f():\n    return 1',
      file_path: 'main.py',
    });

    // Act
    const { container } = render(<WriteToolViewer toolCall={toolCall} />);

    // Assert
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).toBeTruthy());
  });

  it('renders unknown file types as plain text without highlighting', () => {
    // Arrange
    const toolCall = makeToolCall('Write', {
      content: 'plain text body',
      file_path: 'notes.unknownext',
    });

    // Act
    const { container, getByText } = render(<WriteToolViewer toolCall={toolCall} />);

    // Assert
    expect(getByText('plain text body')).toBeTruthy();
    expect(container.querySelector('.hljs-keyword')).toBeNull();
  });

  it('bounds long error output inside the viewer', () => {
    // Arrange
    const content = Array.from({ length: 200 }, (_, index) => `error line ${index}`).join('\n');

    // Act
    const { container } = render(<ErrorBanner content={content} />);
    const banner = container.firstElementChild as HTMLElement | null;

    // Assert
    expect(banner?.textContent).toContain('error line 199');
    expect(banner?.style.maxHeight).toBe('300px');
    expect(banner?.style.overflow).toBe('auto');
  });
});
