import type { KeyboardEvent } from 'react';

const ACTIVATION_KEYS = new Set(['Enter', ' ']);

/**
 * Build an `onKeyDown` handler for elements that act as buttons but are
 * rendered with `role="button"` (e.g. a `<div>` standing in for a `<button>`
 * to avoid invalid nested-interactive HTML). Mirrors a real button's
 * Enter/Space activation semantics.
 */
export function activateOnEnterOrSpace<T extends Element>(
  activate: () => void,
): (event: KeyboardEvent<T>) => void {
  return (event) => {
    if (!ACTIVATION_KEYS.has(event.key)) return;
    event.preventDefault();
    activate();
  };
}
