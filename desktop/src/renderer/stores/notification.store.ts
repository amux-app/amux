import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  detail?: string;
  dismissMs: number;
  timestamp: number;
}

interface ToastOptions {
  title?: string;
  detail?: string;
  dismissMs?: number;
}

const DEFAULT_DISMISS_MS = 5_000;
const ERROR_DISMISS_MS = 8_000;
let counter = 0;

interface NotificationState {
  toasts: Toast[];
}

interface NotificationActions {
  addToast: (message: string, severity: Toast['severity'], options?: ToastOptions) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useNotificationStore = create<NotificationState & NotificationActions>(
  (set) => ({
    toasts: [],

    addToast: (message, severity, options) => {
      const dismissMs =
        options?.dismissMs ?? (severity === 'error' ? ERROR_DISMISS_MS : DEFAULT_DISMISS_MS);
      const id = `toast-${++counter}`;
      const toast: Toast = {
        id,
        message,
        severity,
        title: options?.title,
        detail: options?.detail,
        dismissMs,
        timestamp: Date.now(),
      };

      set((state) => ({ toasts: [...state.toasts, toast] }));
    },

    removeToast: (id) =>
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

    clearToasts: () => set({ toasts: [] }),
  }),
);
