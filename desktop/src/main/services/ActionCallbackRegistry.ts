import type { ActionResult } from 'muxbase/core';
import { randomUUID } from 'crypto';
import type { SerializableActionResult } from '../../shared/ipc-types.js';
import { formatError } from '../utils/formatError.js';

interface StoredCallback {
  fn: (value?: string) => Promise<ActionResult>;
  createdAt: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const TTL_MS = 2 * 60 * 1000;

export class ActionCallbackRegistry {
  private callbacks = new Map<string, StoredCallback>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  register(fn: (value?: string) => Promise<ActionResult>): string {
    this.startCleanupTimer();
    const id = randomUUID();
    this.callbacks.set(id, { fn, createdAt: Date.now() });
    return id;
  }

  async execute(callbackId: string, value?: string): Promise<SerializableActionResult> {
    const entry = this.callbacks.get(callbackId);
    if (!entry) {
      return { type: 'error', message: 'Callback expired or not found', error: 'Callback expired or not found' };
    }

    this.callbacks.delete(callbackId);
    this.stopCleanupTimerIfIdle();

    try {
      const result = await entry.fn(value);
      return this.serializeActionResult(result);
    } catch (error) {
      return {
        type: 'error',
        message: formatError(error),
        error: formatError(error),
      };
    }
  }

  serializeActionResult(result: ActionResult): SerializableActionResult {
    const serialized: SerializableActionResult = {
      type: result.type,
      message: result.message,
    };

    if (result.type === 'error') {
      serialized.error = result.message;
    }

    if (result.title) serialized.title = result.title;
    if (result.confirmLabel) serialized.confirmLabel = result.confirmLabel;
    if (result.cancelLabel) serialized.cancelLabel = result.cancelLabel;
    if (result.placeholder) serialized.placeholder = result.placeholder;
    if (result.defaultValue) serialized.defaultValue = result.defaultValue;
    if (result.progress !== undefined) serialized.progress = result.progress;
    if (result.targetPaneId) serialized.targetPaneId = result.targetPaneId;
    if (result.data !== undefined) serialized.data = result.data;
    if (result.dismissable !== undefined) serialized.dismissable = result.dismissable;

    if (result.options) {
      serialized.options = result.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        description: opt.description,
        danger: opt.danger,
        default: opt.default,
      }));
    }

    if (result.onConfirm) {
      serialized.callbackId = this.register(async () => result.onConfirm!());
    } else if (result.onSelect) {
      serialized.callbackId = this.register(async (value) => result.onSelect!(value || ''));
    } else if (result.onSubmit) {
      serialized.callbackId = this.register(async (value) => result.onSubmit!(value || ''));
    }

    return serialized;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.callbacks) {
      if (now - entry.createdAt > TTL_MS) {
        this.callbacks.delete(id);
      }
    }
    this.stopCleanupTimerIfIdle();
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
  }

  private stopCleanupTimer(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private stopCleanupTimerIfIdle(): void {
    if (this.callbacks.size === 0) {
      this.stopCleanupTimer();
    }
  }

  cleanup(): void {
    this.stopCleanupTimer();
    this.callbacks.clear();
  }
}
