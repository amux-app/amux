// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../src/renderer/stores/ui.store';

describe('useUiStore zenMode', () => {
  const initial = useUiStore.getState();

  beforeEach(() => {
    useUiStore.setState({ ...initial, zenMode: false });
  });

  afterEach(() => {
    useUiStore.setState({ ...initial, zenMode: false });
  });

  it('defaults to false', () => {
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('setZenMode(true) turns Zen on and (false) turns it off', () => {
    useUiStore.getState().setZenMode(true);
    expect(useUiStore.getState().zenMode).toBe(true);
    useUiStore.getState().setZenMode(false);
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('toggleZenMode flips the value', () => {
    expect(useUiStore.getState().zenMode).toBe(false);
    useUiStore.getState().toggleZenMode();
    expect(useUiStore.getState().zenMode).toBe(true);
    useUiStore.getState().toggleZenMode();
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('does not touch viewMode or focusPaneId when toggled', () => {
    useUiStore.setState({ viewMode: 'focus', focusPaneId: 'p1' });
    useUiStore.getState().toggleZenMode();
    const s = useUiStore.getState();
    expect(s.zenMode).toBe(true);
    expect(s.viewMode).toBe('focus');
    expect(s.focusPaneId).toBe('p1');
  });
});
