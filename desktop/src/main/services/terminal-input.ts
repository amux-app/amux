import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const TERMINAL_INPUT_BUFFER_PREFIX = 'aumx-terminal-input-';

// Keystroke-sized writes go via `send-keys -l` (literal), which delivers each
// byte to the target program as a real keypress. Longer or multi-line writes
// use a named tmux buffer so their bytes never pass through shell parsing or
// command-line escaping. `paste-buffer -r` preserves line feeds exactly; it
// does not add bracketed-paste control codes. The cutoff stays intentionally
// low so ordinary keystrokes retain their individual input timing.
const KEYSTROKE_MAX_BYTES = 8;

export interface TmuxInputRunner {
  run(args: readonly string[], input?: Buffer): Promise<void>;
}

class SpawnTmuxInputRunner implements TmuxInputRunner {
  async run(args: readonly string[], input?: Buffer): Promise<void> {
    await runTmux(args, input);
  }
}

const defaultRunner = new SpawnTmuxInputRunner();

export async function writeTerminalInput(
  tmuxPaneId: string,
  data: string,
  runner: TmuxInputRunner = defaultRunner,
): Promise<void> {
  if (!data) return;

  const input = Buffer.from(data, 'utf8');

  // Fast path for keystrokes: one tmux invocation, no buffer allocation, and —
  // critically for correctness — each renderer write stays a literal key
  // burst instead of being coalesced into a larger buffered input operation.
  if (input.length <= KEYSTROKE_MAX_BYTES && !data.includes('\n')) {
    await runner.run(['send-keys', '-l', '-t', tmuxPaneId, '--', data]);
    return;
  }

  await withTmuxInputBuffer(input, runner, (bufferName) => runner.run([
    'paste-buffer', '-d', '-r', '-b', bufferName, '-t', tmuxPaneId,
  ]));
}

/**
 * Deliver complete command text followed by a real Enter key as one tmux
 * command list. The list is processed consecutively by one tmux client, so
 * another tmux client cannot split the command text from its Enter key. The
 * caller remains responsible for ordering work that happens before delivery.
 */
export async function submitTerminalCommand(
  tmuxPaneId: string,
  command: string,
  runner: TmuxInputRunner = defaultRunner,
): Promise<void> {
  if (!command) {
    await runner.run(['send-keys', '-t', tmuxPaneId, 'Enter']);
    return;
  }

  await withTmuxInputBuffer(Buffer.from(command, 'utf8'), runner, (bufferName) => runner.run([
    'paste-buffer', '-d', '-r', '-b', bufferName, '-t', tmuxPaneId,
    ';',
    'send-keys', '-t', tmuxPaneId, 'Enter',
  ]));
}

async function withTmuxInputBuffer(
  input: Buffer,
  runner: TmuxInputRunner,
  consume: (bufferName: string) => Promise<void>,
): Promise<void> {
  const bufferName = `${TERMINAL_INPUT_BUFFER_PREFIX}${randomUUID()}`;
  let bufferLoaded = false;
  try {
    await runner.run(['load-buffer', '-b', bufferName, '-'], input);
    bufferLoaded = true;
    await consume(bufferName);
    bufferLoaded = false;
  } catch (error) {
    if (bufferLoaded) {
      await runner.run(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    }
    throw error;
  }
}

function runTmux(args: readonly string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', [...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tmux ${args[0]} failed with exit code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}
