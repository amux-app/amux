import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from '../../src/renderer/stores/ui.store';

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.setState({
      theme: 'dark',
      sidebarCollapsed: false,
      sidebarOrganize: 'project',
      sidebarSort: 'updated',
      activeView: 'dashboard',
      progressAction: null,
      viewMode: 'fleet',
      focusPaneId: null,
    });
  });

  describe('default state', () => {
    it('has correct initial values', () => {
      const state = useUiStore.getState();
      expect(state.theme).toBe('dark');
      expect(state.sidebarCollapsed).toBe(false);
      expect(state.activeView).toBe('dashboard');
      expect(state.viewMode).toBe('fleet');
      expect(state.focusPaneId).toBeNull();
    });

    it('seeds the sidebar preferences from boot settings so the first paint is not a default flash', () => {
      const initial = useUiStore.getInitialState();
      expect(initial.sidebarCollapsed).toBe(false);
      expect(initial.sidebarOrganize).toBe('project');
      expect(initial.sidebarSort).toBe('manual');
    });
  });

  describe('sidebar preferences', () => {
    it('switches organize mode', () => {
      useUiStore.getState().setSidebarOrganize('flat');
      expect(useUiStore.getState().sidebarOrganize).toBe('flat');
    });

    it('switches sort mode', () => {
      useUiStore.getState().setSidebarSort('updated');
      expect(useUiStore.getState().sidebarSort).toBe('updated');

      useUiStore.getState().setSidebarSort('manual');
      expect(useUiStore.getState().sidebarSort).toBe('manual');
    });

    it('leaves the other preference untouched', () => {
      useUiStore.getState().setSidebarOrganize('flat');
      expect(useUiStore.getState().sidebarSort).toBe('updated');
    });
  });

  describe('setTheme', () => {
    it('switches to light theme', () => {
      useUiStore.getState().setTheme('light');
      expect(useUiStore.getState().theme).toBe('light');
    });

    it('switches to system theme', () => {
      useUiStore.getState().setTheme('system');
      expect(useUiStore.getState().theme).toBe('system');
    });

    it('switches back to dark theme', () => {
      useUiStore.getState().setTheme('light');
      useUiStore.getState().setTheme('dark');
      expect(useUiStore.getState().theme).toBe('dark');
    });
  });

  describe('setSidebarCollapsed', () => {
    it('collapses the sidebar', () => {
      useUiStore.getState().setSidebarCollapsed(true);
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    });

    it('expands the sidebar again', () => {
      useUiStore.getState().setSidebarCollapsed(true);
      useUiStore.getState().setSidebarCollapsed(false);
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe('progressAction', () => {
    it('defaults to null', () => {
      expect(useUiStore.getState().progressAction).toBeNull();
    });

    it('sets progress action', () => {
      useUiStore.getState().setProgressAction('Creating pane...');
      expect(useUiStore.getState().progressAction).toBe('Creating pane...');
    });
  });

  describe('setActiveView', () => {
    it('switches to settings', () => {
      useUiStore.getState().setActiveView('settings');
      expect(useUiStore.getState().activeView).toBe('settings');
    });

    it('switches back to dashboard', () => {
      useUiStore.getState().setActiveView('settings');
      useUiStore.getState().setActiveView('dashboard');
      expect(useUiStore.getState().activeView).toBe('dashboard');
    });
  });

  describe('setViewMode', () => {
    it('switches to focus mode', () => {
      useUiStore.getState().setViewMode('focus');
      expect(useUiStore.getState().viewMode).toBe('focus');
    });

    it('switches to kanban mode', () => {
      useUiStore.getState().setViewMode('kanban');
      expect(useUiStore.getState().viewMode).toBe('kanban');
    });

    it('switches back to fleet mode', () => {
      useUiStore.getState().setViewMode('focus');
      useUiStore.getState().setViewMode('fleet');
      expect(useUiStore.getState().viewMode).toBe('fleet');
    });

    it('cycles through all view modes', () => {
      useUiStore.getState().setViewMode('fleet');
      expect(useUiStore.getState().viewMode).toBe('fleet');

      useUiStore.getState().setViewMode('kanban');
      expect(useUiStore.getState().viewMode).toBe('kanban');

      useUiStore.getState().setViewMode('focus');
      expect(useUiStore.getState().viewMode).toBe('focus');

      useUiStore.getState().setViewMode('fleet');
      expect(useUiStore.getState().viewMode).toBe('fleet');
    });
  });

  describe('focusPane', () => {
    it('sets viewMode to focus and focusPaneId', () => {
      useUiStore.getState().focusPane('pane-42');
      const state = useUiStore.getState();
      expect(state.viewMode).toBe('focus');
      expect(state.focusPaneId).toBe('pane-42');
    });

    it('replaces previously focused pane', () => {
      useUiStore.getState().focusPane('pane-1');
      useUiStore.getState().focusPane('pane-2');
      expect(useUiStore.getState().focusPaneId).toBe('pane-2');
    });
  });

  describe('returnToFleet', () => {
    it('resets to fleet mode and clears focusPaneId', () => {
      useUiStore.getState().focusPane('pane-1');
      useUiStore.getState().returnToFleet();

      const state = useUiStore.getState();
      expect(state.viewMode).toBe('fleet');
      expect(state.focusPaneId).toBeNull();
    });

    it('is idempotent when already in fleet mode', () => {
      useUiStore.getState().returnToFleet();
      const state = useUiStore.getState();
      expect(state.viewMode).toBe('fleet');
      expect(state.focusPaneId).toBeNull();
    });
  });
});
