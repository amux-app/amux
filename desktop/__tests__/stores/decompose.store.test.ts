import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DecomposeGenerateResponse } from '../../src/shared/kanban-types';

vi.mock('../../src/renderer/api/decompose.api', () => ({
  generateDecomposition: vi.fn(),
}));

import { useDecomposeStore } from '../../src/renderer/stores/decompose.store';
import * as decomposeApi from '../../src/renderer/api/decompose.api';

const mockedApi = vi.mocked(decomposeApi);

const INITIAL_STATE = {
  isOpen: false,
  isLoading: false,
  paneId: null,
  prompt: '',
  tasks: [],
  selectedIndices: new Set<number>(),
  includeDiff: false,
  error: null,
};

describe('useDecomposeStore', () => {
  beforeEach(() => {
    useDecomposeStore.setState(INITIAL_STATE);
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts closed with empty tasks', () => {
      const state = useDecomposeStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(state.tasks).toEqual([]);
      expect(state.selectedIndices.size).toBe(0);
      expect(state.error).toBeNull();
    });
  });

  describe('open', () => {
    it('sets state and triggers generation', async () => {
      const response: DecomposeGenerateResponse = {
        success: true,
        tasks: [
          { title: 'Task 1', prompt: 'Do A', complexity: 'S', definitionOfDone: 'A done', dependencies: [] },
          { title: 'Task 2', prompt: 'Do B', complexity: 'M', definitionOfDone: 'B done', dependencies: [0] },
        ],
      };
      mockedApi.generateDecomposition.mockResolvedValue(response);

      useDecomposeStore.getState().open({
        paneId: 'pane-1',
        prompt: 'Build feature X',
        projectRoot: '/project',
      });

      expect(useDecomposeStore.getState().isOpen).toBe(true);
      expect(useDecomposeStore.getState().paneId).toBe('pane-1');
      expect(useDecomposeStore.getState().prompt).toBe('Build feature X');

      // Wait for async generate to complete
      await vi.waitFor(() => {
        expect(useDecomposeStore.getState().isLoading).toBe(false);
      });

      expect(useDecomposeStore.getState().tasks).toHaveLength(2);
      expect(useDecomposeStore.getState().selectedIndices.size).toBe(2);
    });
  });

  describe('close', () => {
    it('resets all state', () => {
      useDecomposeStore.setState({
        isOpen: true,
        paneId: 'pane-1',
        prompt: 'test',
        tasks: [{ title: 't', prompt: 'p', complexity: 'S', definitionOfDone: 'd', dependencies: [] }],
        selectedIndices: new Set([0]),
        error: 'something',
      });

      useDecomposeStore.getState().close();

      const state = useDecomposeStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.paneId).toBeNull();
      expect(state.tasks).toEqual([]);
      expect(state.selectedIndices.size).toBe(0);
      expect(state.error).toBeNull();
    });
  });

  describe('generate', () => {
    it('handles API failure gracefully', async () => {
      useDecomposeStore.setState({ paneId: 'pane-1', prompt: 'test' });

      const response: DecomposeGenerateResponse = {
        success: false,
        tasks: [],
        error: 'API key missing',
      };
      mockedApi.generateDecomposition.mockResolvedValue(response);

      await useDecomposeStore.getState().generate('/project');

      expect(useDecomposeStore.getState().error).toBe('API key missing');
      expect(useDecomposeStore.getState().tasks).toEqual([]);
      expect(useDecomposeStore.getState().isLoading).toBe(false);
    });

    it('handles thrown errors', async () => {
      useDecomposeStore.setState({ paneId: 'pane-1', prompt: 'test' });
      mockedApi.generateDecomposition.mockRejectedValue(new Error('Network error'));

      await useDecomposeStore.getState().generate('/project');

      expect(useDecomposeStore.getState().error).toBe('Network error');
      expect(useDecomposeStore.getState().isLoading).toBe(false);
    });

    it('skips when no paneId', async () => {
      await useDecomposeStore.getState().generate('/project');

      expect(mockedApi.generateDecomposition).not.toHaveBeenCalled();
    });

    it('selects all tasks on success', async () => {
      useDecomposeStore.setState({ paneId: 'pane-1', prompt: 'test' });

      const response: DecomposeGenerateResponse = {
        success: true,
        tasks: [
          { title: 'T1', prompt: 'P1', complexity: 'S', definitionOfDone: 'D1', dependencies: [] },
          { title: 'T2', prompt: 'P2', complexity: 'M', definitionOfDone: 'D2', dependencies: [] },
          { title: 'T3', prompt: 'P3', complexity: 'L', definitionOfDone: 'D3', dependencies: [] },
        ],
      };
      mockedApi.generateDecomposition.mockResolvedValue(response);

      await useDecomposeStore.getState().generate('/project');

      expect(useDecomposeStore.getState().selectedIndices).toEqual(new Set([0, 1, 2]));
    });
  });

  describe('toggleTask', () => {
    it('adds index when not selected', () => {
      useDecomposeStore.setState({ selectedIndices: new Set([0, 2]) });

      useDecomposeStore.getState().toggleTask(1);

      expect(useDecomposeStore.getState().selectedIndices).toEqual(new Set([0, 1, 2]));
    });

    it('removes index when selected', () => {
      useDecomposeStore.setState({ selectedIndices: new Set([0, 1, 2]) });

      useDecomposeStore.getState().toggleTask(1);

      expect(useDecomposeStore.getState().selectedIndices).toEqual(new Set([0, 2]));
    });
  });

  describe('selectAll / deselectAll', () => {
    it('selectAll selects all task indices', () => {
      const tasks = [
        { title: 'T1', prompt: 'P1', complexity: 'S' as const, definitionOfDone: 'D1', dependencies: [] },
        { title: 'T2', prompt: 'P2', complexity: 'M' as const, definitionOfDone: 'D2', dependencies: [] },
      ];
      useDecomposeStore.setState({ tasks, selectedIndices: new Set() });

      useDecomposeStore.getState().selectAll();

      expect(useDecomposeStore.getState().selectedIndices).toEqual(new Set([0, 1]));
    });

    it('deselectAll clears selection', () => {
      useDecomposeStore.setState({ selectedIndices: new Set([0, 1, 2]) });

      useDecomposeStore.getState().deselectAll();

      expect(useDecomposeStore.getState().selectedIndices.size).toBe(0);
    });
  });

  describe('setIncludeDiff', () => {
    it('toggles includeDiff flag', () => {
      expect(useDecomposeStore.getState().includeDiff).toBe(false);

      useDecomposeStore.getState().setIncludeDiff(true);
      expect(useDecomposeStore.getState().includeDiff).toBe(true);

      useDecomposeStore.getState().setIncludeDiff(false);
      expect(useDecomposeStore.getState().includeDiff).toBe(false);
    });
  });
});
