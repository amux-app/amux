import { spawn } from 'node:child_process';
import type { RecapGenerateResponse } from '../../shared/recap-types.js';
import { log } from './Logger.js';

const MODELS = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];
const TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_CHARS = 12_000;

const SYSTEM_PROMPT =
  'You are a concise summarizer. Given a chunk of conversation between a user and an AI coding assistant, ' +
  'write 1-2 sentences summarizing what was accomplished or discussed. ' +
  'Focus on concrete outcomes (features built, bugs fixed, decisions made). ' +
  'Do not use filler phrases like "In this conversation..." — start directly with the substance.';

async function callClaudeCli(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', '--max-turns', '1'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, CLI_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        log.warn('recap', 'Claude CLI failed', { code, stderr: stderr.slice(0, 200) });
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log.warn('recap', 'Claude CLI spawn error', err);
      resolve(null);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function generateRecapViaOpenRouter(conversationText: string): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  for (const model of MODELS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: conversationText },
          ],
          max_tokens: 200,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.warn('recap', `${model} returned ${response.status}`);
        continue;
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      const content = data.choices[0]?.message?.content?.trim();
      if (content) return content;
      log.warn('recap', `${model} returned empty content`);
    } catch (error) {
      log.warn('recap', `${model} failed`, error);
    }
  }

  return null;
}

export async function generateRecap(messages: string[]): Promise<RecapGenerateResponse> {
  let conversationText = messages.join('\n---\n');
  if (conversationText.length > MAX_CONTEXT_CHARS) {
    conversationText = conversationText.slice(0, MAX_CONTEXT_CHARS) + '\n...(truncated)';
  }

  const openRouterResult = await generateRecapViaOpenRouter(conversationText);
  if (openRouterResult) return { summary: openRouterResult };

  const cliPrompt = `${SYSTEM_PROMPT}\n\nConversation:\n${conversationText}`;
  const cliResult = await callClaudeCli(cliPrompt);
  if (cliResult) return { summary: cliResult };

  return { summary: '', error: 'Failed to generate summary' };
}
