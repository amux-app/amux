import { AnimatePresence } from 'motion/react';
import { TOAST_Z_CLASS } from '../../lib/constants';
import { useNotificationStore } from '../../stores';
import { Toast } from './Toast';

const CONTAINER_CLASS = `fixed bottom-4 right-4 ${TOAST_Z_CLASS} flex flex-col gap-2`;

export function ToastContainer() {
  const toasts = useNotificationStore((s) => s.toasts);
  const removeToast = useNotificationStore((s) => s.removeToast);

  return (
    <div className={CONTAINER_CLASS} aria-live="polite">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </AnimatePresence>
    </div>
  );
}
