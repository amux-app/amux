// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindOverlay } from '../src/renderer/components/shared/FindOverlay';

interface Handlers {
  onQueryChange: ReturnType<typeof vi.fn>;
  onNext: ReturnType<typeof vi.fn>;
  onPrev: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onToggleCase: ReturnType<typeof vi.fn>;
}

function makeHandlers(): Handlers {
  return {
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    onToggleCase: vi.fn(),
  };
}

function renderOverlay(props: Partial<Parameters<typeof FindOverlay>[0]> = {}) {
  const handlers = makeHandlers();
  const result = render(
    <FindOverlay
      query=""
      matchCount={0}
      matchIndex={0}
      caseSensitive={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...result, ...handlers };
}

describe('FindOverlay', () => {
  afterEach(cleanup);

  it('auto-focuses the input on mount', () => {
    renderOverlay();
    const input = screen.getByPlaceholderText('Find');
    expect(document.activeElement).toBe(input);
  });

  it('shows match counter only when there is a query', () => {
    const { rerender } = renderOverlay({ query: '', matchCount: 0, matchIndex: 0 });
    expect(screen.queryByText('0/0')).toBeNull();

    rerender(
      <FindOverlay
        query="hello"
        onQueryChange={vi.fn()}
        matchCount={3}
        matchIndex={2}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
        caseSensitive={false}
        onToggleCase={vi.fn()}
      />,
    );
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('renders "No results" when query has no matches', () => {
    renderOverlay({ query: 'zzz', matchCount: 0, matchIndex: 0 });
    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('disables prev/next buttons when there are no matches', () => {
    renderOverlay({ query: 'zzz', matchCount: 0 });
    const next = screen.getByTitle('Next match (Enter)') as HTMLButtonElement;
    const prev = screen.getByTitle('Previous match (Shift+Enter)') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(true);
  });

  it('Enter key advances next, Shift+Enter goes back', () => {
    const { onNext, onPrev } = renderOverlay({ query: 'hi', matchCount: 5, matchIndex: 1 });
    const input = screen.getByPlaceholderText('Find');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('Escape key fires onClose', () => {
    const { onClose } = renderOverlay({ query: 'hi', matchCount: 1, matchIndex: 1 });
    const input = screen.getByPlaceholderText('Find');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the X button fires onClose', () => {
    const { onClose } = renderOverlay({ query: 'hi', matchCount: 1, matchIndex: 1 });
    fireEvent.click(screen.getByTitle('Close (Esc)'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the case toggle fires onToggleCase', () => {
    const { onToggleCase } = renderOverlay();
    fireEvent.click(screen.getByTitle('Case sensitive (off)'));
    expect(onToggleCase).toHaveBeenCalledTimes(1);
  });

  it('reflects caseSensitive state in the toggle button', () => {
    const { rerender } = renderOverlay({ caseSensitive: true });
    expect(screen.getByTitle('Case sensitive (on)').getAttribute('aria-pressed')).toBe('true');
    rerender(
      <FindOverlay
        query=""
        onQueryChange={vi.fn()}
        matchCount={0}
        matchIndex={0}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
        caseSensitive={false}
        onToggleCase={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Case sensitive (off)').getAttribute('aria-pressed')).toBe('false');
  });

  it('typing in the input fires onQueryChange', () => {
    const { onQueryChange } = renderOverlay();
    const input = screen.getByPlaceholderText('Find');
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(onQueryChange).toHaveBeenCalledWith('foo');
  });
});
