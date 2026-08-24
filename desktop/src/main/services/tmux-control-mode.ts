import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { log } from './Logger.js';

export interface TmuxControlModeProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface TmuxControlModeSubscriber {
  onOutput(data: string): void;
  onUnavailable(reason: string): void;
}

export type TmuxControlModeNotification =
  | { type: 'output'; paneId: string; data: string }
  | { type: 'exit'; reason: string }
  | { type: 'ignored' };

export type TmuxControlModeSpawner = (sessionName: string) => TmuxControlModeProcess;

const EXTENDED_OUTPUT_PREFIX = '%extended-output ';
const OUTPUT_PREFIX = '%output ';
const EXIT_PREFIX = '%exit';
const OCTAL_RADIX = 8;
const UTF8 = 'utf8';

export function decodeTmuxControlModeValue(value: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < value.length;) {
    const char = value[index] ?? '';
    if (char === '\\') {
      const octal = value.slice(index + 1, index + 4);
      if (isOctalTriplet(octal)) {
        bytes.push(parseInt(octal, OCTAL_RADIX));
        index += 4;
        continue;
      }

      const escaped = value[index + 1];
      if (escaped) {
        pushUtf8(bytes, decodeEscapedCharacter(escaped));
        index += 2;
        continue;
      }
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const codePointText = String.fromCodePoint(codePoint);
    pushUtf8(bytes, codePointText);
    index += codePointText.length;
  }

  return Buffer.from(bytes).toString(UTF8);
}

export function parseTmuxControlModeLine(line: string): TmuxControlModeNotification {
  if (line.startsWith(OUTPUT_PREFIX)) {
    return parseOutputLine(line.slice(OUTPUT_PREFIX.length));
  }

  if (line.startsWith(EXTENDED_OUTPUT_PREFIX)) {
    return parseExtendedOutputLine(line.slice(EXTENDED_OUTPUT_PREFIX.length));
  }

  if (line.startsWith(EXIT_PREFIX)) {
    return {
      type: 'exit',
      reason: line.slice(EXIT_PREFIX.length).trim() || 'tmux control mode exited',
    };
  }

  return { type: 'ignored' };
}

export class TmuxControlModeClient {
  private decoder = new StringDecoder(UTF8);
  private lineBuffer = '';
  private process: TmuxControlModeProcess | null = null;
  private sessionName: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stoppingProcesses = new WeakSet<TmuxControlModeProcess>();
  private subscribers = new Map<string, Set<TmuxControlModeSubscriber>>();

  constructor(private readonly spawnProcess: TmuxControlModeSpawner = spawnTmuxControlMode) {}

  async ensureStarted(sessionName: string): Promise<void> {
    if (this.process && this.sessionName === sessionName) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start(sessionName).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  subscribePane(paneId: string, subscriber: TmuxControlModeSubscriber): () => void {
    const subscribers = this.subscribers.get(paneId) ?? new Set<TmuxControlModeSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(paneId, subscribers);

    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.subscribers.delete(paneId);
      }
    };
  }

  sendCommand(command: string): boolean {
    if (!this.process) return false;
    return this.process.stdin.write(`${command}\n`);
  }

  stop(): void {
    const process = this.process;
    if (!process) return;

    this.stoppingProcesses.add(process);
    this.process = null;
    this.sessionName = null;
    this.lineBuffer = '';
    this.decoder = new StringDecoder(UTF8);
    process.stdout.removeAllListeners('data');
    process.stderr.removeAllListeners('data');
    process.kill('SIGTERM');
  }

  private async start(sessionName: string): Promise<void> {
    this.stop();
    this.sessionName = sessionName;
    this.process = this.spawnProcess(sessionName);

    const process = this.process;
    process.stdout.on('data', (chunk: string | Buffer) => this.handleStdout(chunk));
    process.stderr.on('data', (chunk: string | Buffer) => {
      const message = Buffer.isBuffer(chunk) ? chunk.toString(UTF8) : chunk;
      log.debug('terminal:control-mode', 'tmux control mode stderr', {
        sessionName,
        message: message.trim(),
      });
    });
    process.on('error', (error) => this.handleUnavailable(`tmux control mode error: ${error.message}`, process));
    process.on('exit', (code, signal) => this.handleUnavailable(formatExitReason(code, signal), process));
  }

  private handleStdout(chunk: string | Buffer): void {
    this.lineBuffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, UTF8));

    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const notification = parseTmuxControlModeLine(line);

    if (notification.type === 'output') {
      this.notifyOutput(notification.paneId, notification.data);
      return;
    }

    if (notification.type === 'exit') {
      this.handleUnavailable(notification.reason);
    }
  }

  private handleUnavailable(reason: string, process?: TmuxControlModeProcess): void {
    if (process && (this.stoppingProcesses.has(process) || this.process !== process)) return;
    this.process = null;
    this.sessionName = null;
    this.lineBuffer = '';
    this.decoder = new StringDecoder(UTF8);

    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.onUnavailable(reason);
      }
    }
  }

  private notifyOutput(paneId: string, data: string): void {
    const subscribers = this.subscribers.get(paneId);
    if (!subscribers) return;

    for (const subscriber of subscribers) {
      subscriber.onOutput(data);
    }
  }
}

function spawnTmuxControlMode(sessionName: string): TmuxControlModeProcess {
  return spawn('tmux', ['-C', 'attach-session', '-t', sessionName], { stdio: 'pipe' });
}

function parseOutputLine(body: string): TmuxControlModeNotification {
  const spaceIndex = body.indexOf(' ');
  const paneId = spaceIndex >= 0 ? body.slice(0, spaceIndex) : body;
  const value = spaceIndex >= 0 ? body.slice(spaceIndex + 1) : '';

  if (!paneId) return { type: 'ignored' };
  return {
    type: 'output',
    paneId,
    data: decodeTmuxControlModeValue(value),
  };
}

function parseExtendedOutputLine(body: string): TmuxControlModeNotification {
  const valueSeparator = body.indexOf(' : ');
  if (valueSeparator < 0) return { type: 'ignored' };

  const metadata = body.slice(0, valueSeparator).trim().split(/\s+/);
  const paneId = metadata[0];
  if (!paneId) return { type: 'ignored' };

  return {
    type: 'output',
    paneId,
    data: decodeTmuxControlModeValue(body.slice(valueSeparator + 3)),
  };
}

function decodeEscapedCharacter(char: string): string {
  if (char === 'e') return '\x1b';
  if (char === 'n') return '\n';
  if (char === 'r') return '\r';
  if (char === 't') return '\t';
  return char;
}

function formatExitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `tmux control mode exited from signal ${signal}`;
  if (code !== null) return `tmux control mode exited with code ${code}`;
  return 'tmux control mode exited';
}

function isOctalTriplet(value: string): boolean {
  return value.length === 3 && /^[0-7]{3}$/.test(value);
}

function pushUtf8(bytes: number[], text: string): void {
  bytes.push(...Buffer.from(text, UTF8));
}
