export interface TerminalWritable {
  write(data: string, callback?: () => void): void;
}

interface TerminalWriteCallbacks {
  afterWrite?: () => void;
  beforeWrite?: () => void;
}

interface TerminalWriteRequest {
  callbacks: TerminalWriteCallbacks;
  data: string;
  suppressInput: boolean;
  terminal: TerminalWritable;
}

export class TerminalInputSuppressor {
  private disposed = false;
  private replayWrites = 0;
  private suppressionEpoch = 0;
  private writeQueue: TerminalWriteRequest[] = [];
  private writing = false;

  canForwardInput(): boolean {
    return this.replayWrites === 0;
  }

  getSuppressionEpoch(): number {
    return this.suppressionEpoch;
  }

  write(
    terminal: TerminalWritable,
    data: string,
    suppressInput: boolean,
    callbacks: TerminalWriteCallbacks = {},
  ): void {
    if (this.disposed) return;

    if (suppressInput) {
      // Count replay work as soon as it is accepted, not only once xterm starts
      // parsing it. Input must not slip between an earlier queued write and an
      // authoritative replay that is already waiting behind it.
      this.replayWrites += 1;
      this.suppressionEpoch += 1;
    }
    this.writeQueue.push({ callbacks, data, suppressInput, terminal });
    this.drainWriteQueue();
  }

  dispose(): void {
    this.disposed = true;
    this.replayWrites = 0;
    this.suppressionEpoch += 1;
    this.writeQueue = [];
  }

  private drainWriteQueue(): void {
    if (this.disposed) return;
    if (this.writing) return;

    const request = this.writeQueue.shift();
    if (!request) return;

    this.writing = true;
    request.callbacks.beforeWrite?.();
    request.terminal.write(request.data, () => {
      if (request.suppressInput) {
        this.replayWrites = Math.max(0, this.replayWrites - 1);
      }
      if (this.disposed) {
        this.writing = false;
        return;
      }
      request.callbacks.afterWrite?.();
      this.writing = false;
      this.drainWriteQueue();
    });
  }
}
