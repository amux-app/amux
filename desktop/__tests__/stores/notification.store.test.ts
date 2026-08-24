import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';

describe('useNotificationStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({ toasts: [] });
  });

  it('starts with empty toasts', () => {
    expect(useNotificationStore.getState().toasts).toEqual([]);
  });

  it('addToast adds a toast with correct fields', () => {
    useNotificationStore.getState().addToast('Something happened', 'info');

    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Something happened');
    expect(toasts[0].severity).toBe('info');
    expect(toasts[0].id).toMatch(/^toast-/);
    expect(typeof toasts[0].timestamp).toBe('number');
  });

  it('addToast generates unique IDs for multiple toasts', () => {
    useNotificationStore.getState().addToast('First', 'success');
    useNotificationStore.getState().addToast('Second', 'error');
    useNotificationStore.getState().addToast('Third', 'warning');

    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(3);

    const ids = toasts.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  it('removeToast removes the specific toast', () => {
    useNotificationStore.getState().addToast('Keep me', 'info');
    useNotificationStore.getState().addToast('Remove me', 'error');

    const toastToRemove = useNotificationStore.getState().toasts[1];
    useNotificationStore.getState().removeToast(toastToRemove.id);

    const { toasts } = useNotificationStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Keep me');
  });

  it('removeToast with unknown id does not affect existing toasts', () => {
    useNotificationStore.getState().addToast('Existing', 'info');
    useNotificationStore.getState().removeToast('toast-nonexistent');

    expect(useNotificationStore.getState().toasts).toHaveLength(1);
  });

  it('clearToasts removes all toasts', () => {
    useNotificationStore.getState().addToast('One', 'info');
    useNotificationStore.getState().addToast('Two', 'success');
    useNotificationStore.getState().addToast('Three', 'warning');

    useNotificationStore.getState().clearToasts();

    expect(useNotificationStore.getState().toasts).toEqual([]);
  });

  it('sets default dismissMs based on severity', () => {
    useNotificationStore.getState().addToast('Info toast', 'info');
    useNotificationStore.getState().addToast('Error toast', 'error');

    const { toasts } = useNotificationStore.getState();
    expect(toasts[0].dismissMs).toBe(5_000);
    expect(toasts[1].dismissMs).toBe(8_000);
  });

  it('accepts title and detail via options', () => {
    useNotificationStore.getState().addToast('raw msg', 'error', {
      title: 'Merge failed',
      detail: 'Worktree not initialized',
    });

    const toast = useNotificationStore.getState().toasts[0];
    expect(toast.title).toBe('Merge failed');
    expect(toast.detail).toBe('Worktree not initialized');
    expect(toast.message).toBe('raw msg');
  });
});
