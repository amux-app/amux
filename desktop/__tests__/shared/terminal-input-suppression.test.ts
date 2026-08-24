import { describe, expect, it } from 'vitest';
import {
  TerminalInputSuppressor,
  type TerminalWritable,
} from '../../src/renderer/lib/terminal-input-suppression';

class FakeTerminal implements TerminalWritable {
  onWrite: (() => void) | null = null;

  write(_data: string, callback?: () => void): void {
    this.onWrite?.();
    callback?.();
  }
}

class AsyncFakeTerminal implements TerminalWritable {
  readonly writes: string[] = [];
  private readonly callbacks: Array<() => void> = [];

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    if (callback) this.callbacks.push(callback);
  }

  flushNext(): void {
    this.callbacks.shift()?.();
  }
}

describe('TerminalInputSuppressor', () => {
  it('blocks terminal-generated responses while replay data is being written', () => {
    const suppressor = new TerminalInputSuppressor();
    const terminal = new FakeTerminal();
    const forwardedInput: string[] = [];

    terminal.onWrite = () => {
      if (suppressor.canForwardInput()) {
        forwardedInput.push('\x1b[6;1R');
      }
    };

    suppressor.write(terminal, '\x1b[6n', true);

    expect(forwardedInput).toEqual([]);
    expect(suppressor.canForwardInput()).toBe(true);
  });

  it('keeps live terminal output interactive', () => {
    const suppressor = new TerminalInputSuppressor();
    const terminal = new FakeTerminal();
    const forwardedInput: string[] = [];

    terminal.onWrite = () => {
      if (suppressor.canForwardInput()) {
        forwardedInput.push('\x1b[6;1R');
      }
    };

    suppressor.write(terminal, '\x1b[6n', false);

    expect(forwardedInput).toEqual(['\x1b[6;1R']);
  });

  it('serializes writes and suppresses input until replay parsing completes', () => {
    const suppressor = new TerminalInputSuppressor();
    const terminal = new AsyncFakeTerminal();
    const callbacks: string[] = [];

    suppressor.write(terminal, 'replay', true, {
      afterWrite: () => callbacks.push('after-replay'),
      beforeWrite: () => callbacks.push('before-replay'),
    });
    suppressor.write(terminal, 'live', false, {
      afterWrite: () => callbacks.push('after-live'),
      beforeWrite: () => callbacks.push('before-live'),
    });

    expect(terminal.writes).toEqual(['replay']);
    expect(callbacks).toEqual(['before-replay']);
    expect(suppressor.canForwardInput()).toBe(false);

    terminal.flushNext();

    expect(terminal.writes).toEqual(['replay', 'live']);
    expect(callbacks).toEqual(['before-replay', 'after-replay', 'before-live']);
    expect(suppressor.canForwardInput()).toBe(true);

    terminal.flushNext();

    expect(callbacks).toEqual(['before-replay', 'after-replay', 'before-live', 'after-live']);
  });

  it('invalidates pending input as soon as an authoritative replay is queued', () => {
    const suppressor = new TerminalInputSuppressor();
    const terminal = new AsyncFakeTerminal();
    const initialEpoch = suppressor.getSuppressionEpoch();

    suppressor.write(terminal, 'live', false);
    suppressor.write(terminal, 'queued-replay', true);

    expect(terminal.writes).toEqual(['live']);
    expect(suppressor.canForwardInput()).toBe(false);
    expect(suppressor.getSuppressionEpoch()).toBeGreaterThan(initialEpoch);

    terminal.flushNext();
    expect(terminal.writes).toEqual(['live', 'queued-replay']);
    expect(suppressor.canForwardInput()).toBe(false);

    terminal.flushNext();
    expect(suppressor.canForwardInput()).toBe(true);
  });

  it('drops queued callbacks after dispose', () => {
    const suppressor = new TerminalInputSuppressor();
    const terminal = new AsyncFakeTerminal();
    const callbacks: string[] = [];

    suppressor.write(terminal, 'replay', true, {
      afterWrite: () => callbacks.push('after-replay'),
      beforeWrite: () => callbacks.push('before-replay'),
    });
    suppressor.write(terminal, 'live', false, {
      afterWrite: () => callbacks.push('after-live'),
      beforeWrite: () => callbacks.push('before-live'),
    });
    suppressor.dispose();

    terminal.flushNext();
    suppressor.write(terminal, 'ignored', false, {
      beforeWrite: () => callbacks.push('before-ignored'),
    });

    expect(callbacks).toEqual(['before-replay']);
    expect(terminal.writes).toEqual(['replay']);
    expect(suppressor.canForwardInput()).toBe(true);
  });
});
