import { rendererLog } from './rendererLog';

let installed = false;

function normalizeErrorValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

export function installRendererErrorLogging(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    rendererLog.error('renderer:global-error', 'Unhandled renderer error', {
      colno: event.colno,
      error: normalizeErrorValue(event.error),
      filename: event.filename,
      lineno: event.lineno,
      message: event.message,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    rendererLog.error('renderer:unhandled-rejection', 'Unhandled renderer promise rejection', {
      reason: normalizeErrorValue(event.reason),
    });
  });
}
