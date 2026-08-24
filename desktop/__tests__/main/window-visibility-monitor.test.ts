import { EventEmitter } from 'node:events';
import type { App, BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorWindowVisibility } from '../../src/main/services/WindowVisibilityMonitor';

class FakeWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  visible = true;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }
}

describe('monitorWindowVisibility', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes only real visibility transitions from window events', () => {
    const app = new EventEmitter();
    const window = new FakeWindow();
    const onVisibilityChange = vi.fn();

    monitorWindowVisibility(
      app as unknown as App,
      window as unknown as BrowserWindow,
      onVisibilityChange,
    );

    expect(onVisibilityChange).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    window.emit('focus');
    window.emit('show');
    expect(onVisibilityChange).toHaveBeenCalledOnce();

    window.visible = false;
    window.emit('hide');
    expect(onVisibilityChange).toHaveBeenCalledTimes(2);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });

  it('uses app activation as a deferred fallback and detaches on close', async () => {
    vi.useFakeTimers();
    const app = new EventEmitter();
    const window = new FakeWindow();
    const onVisibilityChange = vi.fn();

    monitorWindowVisibility(
      app as unknown as App,
      window as unknown as BrowserWindow,
      onVisibilityChange,
    );

    window.visible = false;
    app.emit('did-resign-active');
    expect(onVisibilityChange).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);

    window.destroyed = true;
    window.emit('closed');
    window.visible = true;
    app.emit('did-become-active');
    await vi.advanceTimersByTimeAsync(300);

    expect(onVisibilityChange).toHaveBeenCalledTimes(2);
    expect(app.listenerCount('did-become-active')).toBe(0);
    expect(app.listenerCount('did-resign-active')).toBe(0);
  });

  it('rechecks visibility after a window event emitted before native state settles', async () => {
    vi.useFakeTimers();
    const app = new EventEmitter();
    const window = new FakeWindow();
    const onVisibilityChange = vi.fn();

    monitorWindowVisibility(
      app as unknown as App,
      window as unknown as BrowserWindow,
      onVisibilityChange,
    );

    window.visible = false;
    window.emit('hide');
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);

    window.emit('show');
    window.visible = true;
    await vi.advanceTimersByTimeAsync(300);

    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  });

  it('keeps rechecking briefly while native application visibility settles', async () => {
    vi.useFakeTimers();
    const app = new EventEmitter();
    const window = new FakeWindow();
    const onVisibilityChange = vi.fn();

    monitorWindowVisibility(
      app as unknown as App,
      window as unknown as BrowserWindow,
      onVisibilityChange,
    );

    window.visible = false;
    window.emit('hide');
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);

    window.emit('show');
    setTimeout(() => {
      window.visible = true;
    }, 25);
    await vi.advanceTimersByTimeAsync(250);

    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  });

  it('detects native visibility drift even when Electron emits no window event', async () => {
    vi.useFakeTimers();
    const app = new EventEmitter();
    const window = new FakeWindow();
    const onVisibilityChange = vi.fn();

    monitorWindowVisibility(
      app as unknown as App,
      window as unknown as BrowserWindow,
      onVisibilityChange,
    );

    window.visible = false;
    await vi.advanceTimersByTimeAsync(250);

    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
});
