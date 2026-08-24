import type { PaneStream } from './terminal-stream-state.js';
import { TmuxControlModeClient } from './tmux-control-mode.js';

export class TerminalControlClients {
  private clients = new Map<string, TmuxControlModeClient>();

  constructor(private readonly createClient: () => TmuxControlModeClient) {}

  get(sessionName: string): TmuxControlModeClient {
    const existing = this.clients.get(sessionName);
    if (existing) return existing;

    const client = this.createClient();
    this.clients.set(sessionName, client);
    return client;
  }

  refreshSize(stream: PaneStream): void {
    const client = this.clients.get(stream.sessionName);
    if (!client) return;

    const size = `${stream.cols}x${stream.rows}`;
    const targetSize = stream.windowId ? `${stream.windowId}:${size}` : size;
    client.sendCommand(`refresh-client -C ${targetSize}`);
  }

  stopIfIdle(sessionName: string, streams: Iterable<PaneStream>): void {
    for (const stream of streams) {
      if (stream.sessionName === sessionName && stream.mode === 'control') {
        return;
      }
    }

    const client = this.clients.get(sessionName);
    if (!client) return;
    client.stop();
    this.clients.delete(sessionName);
  }

  stopAll(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }
}
