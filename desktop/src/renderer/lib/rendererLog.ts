import type { RendererLogLevel } from '../../shared/ipc-types';
import { writeRendererLog } from '../api/renderer-log.api';

const MAX_LOG_DEPTH = 4;

function normalizeLogData(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (depth >= MAX_LOG_DEPTH) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogData(item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeLogData(item, depth + 1),
      ]),
    );
  }

  return String(value);
}

function logRenderer(level: RendererLogLevel, scope: string, message: string, data?: unknown): void {
  if (typeof window === 'undefined' || typeof window.aumx?.invoke !== 'function') {
    return;
  }

  void writeRendererLog({
    level,
    scope,
    message,
    data: normalizeLogData(data),
  }).catch(() => undefined);
}

export const rendererLog = {
  debug: (scope: string, message: string, data?: unknown) => logRenderer('debug', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => logRenderer('error', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => logRenderer('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => logRenderer('warn', scope, message, data),
};
