import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeTmuxControlModeValue,
  parseTmuxControlModeLine,
  TmuxControlModeClient,
  type TmuxControlModeProcess,
} from '../../src/main/services/tmux-control-mode';

class FakeControlProcess extends EventEmitter implements TmuxControlModeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  emitExit(): void {
    this.emit('exit', 0, null);
  }
}

describe('tmux control mode parser', () => {
  it('decodes octal-escaped pane output bytes', () => {
    expect(decodeTmuxControlModeValue('hello\\012world\\015\\012\\134')).toBe('hello\nworld\r\n\\');
    expect(decodeTmuxControlModeValue('\\342\\234\\205')).toBe(Buffer.from([0xe2, 0x9c, 0x85]).toString('utf8'));
  });

  it('parses regular and extended output notifications', () => {
    expect(parseTmuxControlModeLine('%output %3 hello\\040world')).toEqual({
      type: 'output',
      paneId: '%3',
      data: 'hello world',
    });

    expect(parseTmuxControlModeLine('%extended-output %7 42 future : chunk\\012')).toEqual({
      type: 'output',
      paneId: '%7',
      data: 'chunk\n',
    });
  });

  it('ignores command blocks and unrelated notifications', () => {
    expect(parseTmuxControlModeLine('%begin 1363006971 2 1')).toEqual({ type: 'ignored' });
    expect(parseTmuxControlModeLine('%layout-change @1 layout visible *')).toEqual({ type: 'ignored' });
    expect(parseTmuxControlModeLine('%exit too far behind')).toEqual({
      type: 'exit',
      reason: 'too far behind',
    });
  });
});

describe('TmuxControlModeClient', () => {
  it('routes chunked pane output to the matching subscriber', async () => {
    const process = new FakeControlProcess();
    const client = new TmuxControlModeClient(() => process);
    const firstPaneOutput = vi.fn();
    const secondPaneOutput = vi.fn();

    await client.ensureStarted('aumx-test');
    client.subscribePane('%1', { onOutput: firstPaneOutput, onUnavailable: vi.fn() });
    client.subscribePane('%2', { onOutput: secondPaneOutput, onUnavailable: vi.fn() });

    process.stdout.write('%output %1 hel');
    process.stdout.write('lo\\012\n%output %2 bye\\012\n');

    expect(firstPaneOutput).toHaveBeenCalledWith('hello\n');
    expect(secondPaneOutput).toHaveBeenCalledWith('bye\n');
  });

  it('notifies subscribers when the control client exits', async () => {
    const process = new FakeControlProcess();
    const client = new TmuxControlModeClient(() => process);
    const onUnavailable = vi.fn();

    await client.ensureStarted('aumx-test');
    client.subscribePane('%1', { onOutput: vi.fn(), onUnavailable });

    process.emitExit();

    expect(onUnavailable).toHaveBeenCalledWith('tmux control mode exited with code 0');
  });

  it('writes control commands to tmux stdin', async () => {
    const process = new FakeControlProcess();
    const client = new TmuxControlModeClient(() => process);

    await client.ensureStarted('aumx-test');

    expect(client.sendCommand('refresh-client -C 120x40')).toBe(true);
    expect(process.stdin.read()?.toString('utf8')).toBe('refresh-client -C 120x40\n');
  });
});
