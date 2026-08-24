import { beforeEach, describe, expect, it } from 'vitest';
import { useTaskDefaultsStore } from '../../src/renderer/stores/task-defaults.store';

describe('useTaskDefaultsStore', () => {
  beforeEach(() => {
    useTaskDefaultsStore.setState({
      lastTaskProjectRoot: undefined,
      setLastTaskProjectRoot: useTaskDefaultsStore.getState().setLastTaskProjectRoot,
    });
  });

  it('starts without a default project root', () => {
    // Arrange
    const state = useTaskDefaultsStore.getState();

    // Act
    const value = state.lastTaskProjectRoot;

    // Assert
    expect(value).toBeUndefined();
  });

  it('stores the last selected project root', () => {
    // Arrange
    const projectRoot = '/tmp/project-a';

    // Act
    useTaskDefaultsStore.getState().setLastTaskProjectRoot(projectRoot);

    // Assert
    expect(useTaskDefaultsStore.getState().lastTaskProjectRoot).toBe(projectRoot);
  });

  it('allows resetting to current project default', () => {
    // Arrange
    useTaskDefaultsStore.getState().setLastTaskProjectRoot('/tmp/project-b');

    // Act
    useTaskDefaultsStore.getState().setLastTaskProjectRoot(undefined);

    // Assert
    expect(useTaskDefaultsStore.getState().lastTaskProjectRoot).toBeUndefined();
  });
});
