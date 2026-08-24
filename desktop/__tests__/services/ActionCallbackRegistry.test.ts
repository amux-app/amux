import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActionCallbackRegistry } from '../../src/main/services/ActionCallbackRegistry';
import type { ActionResult } from 'aumx/core';

function makeSuccessResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return { type: 'success', message: 'Done', ...overrides };
}

describe('ActionCallbackRegistry', () => {
  let registry: ActionCallbackRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ActionCallbackRegistry();
  });

  afterEach(() => {
    registry.cleanup();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('does not keep a cleanup timer running while idle', async () => {
      expect(vi.getTimerCount()).toBe(0);

      const id = registry.register(async () => makeSuccessResult());

      expect(vi.getTimerCount()).toBe(1);
      await registry.execute(id);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('returns a unique UUID string', () => {
      const id1 = registry.register(async () => makeSuccessResult());
      const id2 = registry.register(async () => makeSuccessResult());

      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('execute', () => {
    it('calls the registered callback and returns serialized result', async () => {
      const fn = vi.fn(async () => makeSuccessResult({ message: 'All good' }));
      const id = registry.register(fn);

      const result = await registry.execute(id);

      expect(fn).toHaveBeenCalledOnce();
      expect(result.type).toBe('success');
      expect(result.message).toBe('All good');
    });

    it('passes value to the callback', async () => {
      const fn = vi.fn(async (value?: string) =>
        makeSuccessResult({ message: `Received: ${value}` }),
      );
      const id = registry.register(fn);

      const result = await registry.execute(id, 'user-input');

      expect(fn).toHaveBeenCalledWith('user-input');
      expect(result.message).toBe('Received: user-input');
    });

    it('removes callback after execution (single-use)', async () => {
      const id = registry.register(async () => makeSuccessResult());

      await registry.execute(id);
      const secondResult = await registry.execute(id);

      expect(secondResult.type).toBe('error');
      expect(secondResult.message).toBe('Callback expired or not found');
    });

    it('returns error for unknown callbackId', async () => {
      const result = await registry.execute('nonexistent-id');

      expect(result.type).toBe('error');
      expect(result.message).toBe('Callback expired or not found');
    });

    it('handles callback errors gracefully', async () => {
      const id = registry.register(async () => {
        throw new Error('Something broke');
      });

      const result = await registry.execute(id);

      expect(result.type).toBe('error');
      expect(result.message).toBe('Something broke');
    });

    it('handles non-Error throws gracefully', async () => {
      const id = registry.register(async () => {
        throw 'raw string error';
      });

      const result = await registry.execute(id);

      expect(result.type).toBe('error');
      expect(result.message).toBe('raw string error');
    });
  });

  describe('serializeActionResult', () => {
    it('serializes basic type and message', () => {
      const result = registry.serializeActionResult(makeSuccessResult({ message: 'OK' }));
      expect(result.type).toBe('success');
      expect(result.message).toBe('OK');
    });

    it('serializes title when present', () => {
      const result = registry.serializeActionResult(
        makeSuccessResult({ title: 'My Title' }),
      );
      expect(result.title).toBe('My Title');
    });

    it('serializes confirm/cancel labels', () => {
      const result = registry.serializeActionResult({
        type: 'confirm',
        message: 'Are you sure?',
        confirmLabel: 'Yes',
        cancelLabel: 'No',
      });
      expect(result.confirmLabel).toBe('Yes');
      expect(result.cancelLabel).toBe('No');
    });

    it('serializes placeholder and defaultValue', () => {
      const result = registry.serializeActionResult({
        type: 'input',
        message: 'Enter name',
        placeholder: 'e.g. my-pane',
        defaultValue: 'default',
      });
      expect(result.placeholder).toBe('e.g. my-pane');
      expect(result.defaultValue).toBe('default');
    });

    it('serializes progress', () => {
      const result = registry.serializeActionResult({
        type: 'progress',
        message: 'Working...',
        progress: 42,
      });
      expect(result.progress).toBe(42);
    });

    it('serializes progress of 0', () => {
      const result = registry.serializeActionResult({
        type: 'progress',
        message: 'Starting...',
        progress: 0,
      });
      expect(result.progress).toBe(0);
    });

    it('serializes targetPaneId', () => {
      const result = registry.serializeActionResult({
        type: 'navigation',
        message: 'Navigate',
        targetPaneId: 'aumx-3',
      });
      expect(result.targetPaneId).toBe('aumx-3');
    });

    it('serializes data', () => {
      const result = registry.serializeActionResult(
        makeSuccessResult({ data: { key: 'value' } }),
      );
      expect(result.data).toEqual({ key: 'value' });
    });

    it('serializes dismissable', () => {
      const result = registry.serializeActionResult(
        makeSuccessResult({ dismissable: true }),
      );
      expect(result.dismissable).toBe(true);
    });

    it('serializes options array', () => {
      const result = registry.serializeActionResult({
        type: 'choice',
        message: 'Pick one',
        options: [
          { id: 'a', label: 'Option A', description: 'First', danger: false, default: true },
          { id: 'b', label: 'Option B', danger: true },
        ],
      });

      expect(result.options).toHaveLength(2);
      expect(result.options![0]).toEqual({
        id: 'a',
        label: 'Option A',
        description: 'First',
        danger: false,
        default: true,
      });
      expect(result.options![1].id).toBe('b');
      expect(result.options![1].danger).toBe(true);
    });

    it('registers callback for onConfirm', () => {
      const onConfirm = vi.fn(async () => makeSuccessResult({ message: 'Confirmed' }));

      const result = registry.serializeActionResult({
        type: 'confirm',
        message: 'Sure?',
        onConfirm,
      });

      expect(result.callbackId).toBeDefined();
      expect(typeof result.callbackId).toBe('string');
    });

    it('registered onConfirm callback is executable', async () => {
      const onConfirm = vi.fn(async () => makeSuccessResult({ message: 'Confirmed' }));

      const result = registry.serializeActionResult({
        type: 'confirm',
        message: 'Sure?',
        onConfirm,
      });

      const executed = await registry.execute(result.callbackId!);
      expect(executed.type).toBe('success');
      expect(executed.message).toBe('Confirmed');
    });

    it('keeps cleanup active when a callback returns another callback result', async () => {
      const result = registry.serializeActionResult({
        type: 'confirm',
        message: 'First?',
        onConfirm: async () => ({
          type: 'confirm',
          message: 'Second?',
          onConfirm: async () => makeSuccessResult({ message: 'Confirmed' }),
        }),
      });

      expect(vi.getTimerCount()).toBe(1);
      const next = await registry.execute(result.callbackId!);

      expect(next.callbackId).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);

      const executed = await registry.execute(next.callbackId!);
      expect(executed.type).toBe('success');
      expect(executed.message).toBe('Confirmed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('registers callback for onSelect', () => {
      const onSelect = vi.fn(async (value: string) =>
        makeSuccessResult({ message: `Selected: ${value}` }),
      );

      const result = registry.serializeActionResult({
        type: 'choice',
        message: 'Pick',
        options: [{ id: 'opt1', label: 'Option 1' }],
        onSelect,
      });

      expect(result.callbackId).toBeDefined();
    });

    it('registered onSelect callback passes value correctly', async () => {
      const onSelect = vi.fn(async (value: string) =>
        makeSuccessResult({ message: `Selected: ${value}` }),
      );

      const result = registry.serializeActionResult({
        type: 'choice',
        message: 'Pick',
        options: [{ id: 'opt1', label: 'Option 1' }],
        onSelect,
      });

      const executed = await registry.execute(result.callbackId!, 'opt1');
      expect(onSelect).toHaveBeenCalledWith('opt1');
      expect(executed.message).toBe('Selected: opt1');
    });

    it('registers callback for onSubmit', () => {
      const onSubmit = vi.fn(async (value: string) =>
        makeSuccessResult({ message: `Submitted: ${value}` }),
      );

      const result = registry.serializeActionResult({
        type: 'input',
        message: 'Enter value',
        onSubmit,
      });

      expect(result.callbackId).toBeDefined();
    });

    it('onConfirm takes priority over onSelect and onSubmit', () => {
      const result = registry.serializeActionResult({
        type: 'confirm',
        message: 'Test',
        onConfirm: async () => makeSuccessResult(),
        onSelect: async () => makeSuccessResult(),
        onSubmit: async () => makeSuccessResult(),
      });

      // Only one callbackId should be registered (for onConfirm)
      expect(result.callbackId).toBeDefined();
    });

    it('does not set callbackId when no callback is present', () => {
      const result = registry.serializeActionResult(makeSuccessResult());
      expect(result.callbackId).toBeUndefined();
    });

    it('omits optional fields when not present in input', () => {
      const result = registry.serializeActionResult(makeSuccessResult());
      expect(result.title).toBeUndefined();
      expect(result.confirmLabel).toBeUndefined();
      expect(result.cancelLabel).toBeUndefined();
      expect(result.placeholder).toBeUndefined();
      expect(result.defaultValue).toBeUndefined();
      expect(result.progress).toBeUndefined();
      expect(result.targetPaneId).toBeUndefined();
      expect(result.data).toBeUndefined();
      expect(result.dismissable).toBeUndefined();
      expect(result.options).toBeUndefined();
      expect(result.callbackId).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('clears all callbacks', async () => {
      const id = registry.register(async () => makeSuccessResult());
      registry.cleanup();

      const result = await registry.execute(id);
      expect(result.type).toBe('error');
    });
  });

  describe('purgeExpired', () => {
    it('removes callbacks older than 2 minutes', async () => {
      const id = registry.register(async () => makeSuccessResult());

      // Advance time past the 2-minute TTL
      vi.advanceTimersByTime(2 * 60 * 1000 + 1);

      // Trigger the periodic cleanup (runs every 60 seconds)
      vi.advanceTimersByTime(60_000);

      const result = await registry.execute(id);
      expect(result.type).toBe('error');
      expect(result.message).toBe('Callback expired or not found');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps callbacks younger than 2 minutes', async () => {
      const id = registry.register(async () => makeSuccessResult({ message: 'Still here' }));

      // Advance less than 2 minutes
      vi.advanceTimersByTime(1 * 60 * 1000);

      // Trigger periodic cleanup
      vi.advanceTimersByTime(60_000);

      const result = await registry.execute(id);
      expect(result.type).toBe('success');
      expect(result.message).toBe('Still here');
    });
  });
});
