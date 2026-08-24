import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DecomposeGenerateRequest, DecomposeGenerateResponse, DecomposeTask } from '../../shared/kanban-types.js';
import { log } from './Logger.js';

const MODELS = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];
const MAX_CONTEXT_BYTES = 20_000;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MIN_TASKS = 3;
const MAX_TASKS = 8;
const TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

type GitRunner = (args: readonly string[]) => Promise<string>;

const TASK_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'decompose_tasks',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string' },
              complexity: { type: 'string', enum: ['S', 'M', 'L'] },
              definitionOfDone: { type: 'string' },
              dependencies: { type: 'array', items: { type: 'number' } },
              parallelGroup: { type: 'string' },
            },
            required: ['title', 'prompt', 'complexity', 'definitionOfDone', 'dependencies'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
};

async function runGit(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return stdout;
}

export async function gatherContext(
  request: DecomposeGenerateRequest,
  gitRunner: GitRunner = runGit,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`## Original Task\n${request.prompt}`);

  if (request.contextHint) {
    parts.push(`## Additional Context\n${request.contextHint}`);
  }

  try {
    let fileList: string;
    try {
      fileList = await gitRunner(['-C', request.projectRoot, 'diff', '--name-status', 'HEAD']);
    } catch {
      fileList = await gitRunner(['-C', request.projectRoot, 'status', '--porcelain']);
    }
    if (fileList.trim()) {
      parts.push(`## Changed Files\n${fileList.trim()}`);
    }
  } catch { /* no git context available */ }

  if (request.includeDiff) {
    try {
      let diff = await gitRunner(['-C', request.projectRoot, 'diff', 'HEAD']);
      if (diff.length > MAX_CONTEXT_BYTES) {
        diff = diff.slice(0, MAX_CONTEXT_BYTES) + '\n...(truncated)';
      }
      if (diff.trim()) {
        parts.push(`## Diff\n${diff.trim()}`);
      }
    } catch { /* no diff available */ }
  }

  return parts.join('\n\n');
}

function buildSystemPrompt(): string {
  return [
    'You are a task decomposition expert. Break down the given development task into smaller, parallelizable sub-tasks.',
    'Each sub-task should be independently executable by an AI coding agent in its own git worktree.',
    '',
    'Rules:',
    `- Generate ${MIN_TASKS}-${MAX_TASKS} tasks`,
    '- Each task should be completable in a single agent session (1-2 hours)',
    '- Minimize dependencies between tasks (prefer parallel execution)',
    '- Use dependencies array with 0-based indices only when task B strictly requires task A\'s output',
    '- Assign complexity: S (< 30 min), M (30-90 min), L (90+ min)',
    '- title: short kebab-case-friendly name (2-4 words)',
    '- prompt: detailed instruction the agent will receive (include file paths, expected behavior, edge cases)',
    '- definitionOfDone: concrete, verifiable completion criteria',
    '- parallelGroup: optional tag to group tasks that can run simultaneously',
  ].join('\n');
}

export function validateTasks(tasks: unknown[]): DecomposeTask[] {
  if (!Array.isArray(tasks) || tasks.length < MIN_TASKS || tasks.length > MAX_TASKS) {
    throw new Error(`Expected ${MIN_TASKS}-${MAX_TASKS} tasks, got ${Array.isArray(tasks) ? tasks.length : 0}`);
  }

  const validated: DecomposeTask[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] as Record<string, unknown>;
    if (!t.title || !t.prompt || !t.complexity || !t.definitionOfDone) {
      throw new Error(`Task ${i} missing required fields`);
    }
    if (!['S', 'M', 'L'].includes(t.complexity as string)) {
      throw new Error(`Task ${i} has invalid complexity: ${t.complexity}`);
    }
    const deps = Array.isArray(t.dependencies) ? t.dependencies.filter((d): d is number => typeof d === 'number') : [];
    for (const dep of deps) {
      if (dep < 0 || dep >= tasks.length || dep === i) {
        throw new Error(`Task ${i} has invalid dependency index: ${dep}`);
      }
    }
    validated.push({
      title: String(t.title),
      prompt: String(t.prompt),
      complexity: t.complexity as 'S' | 'M' | 'L',
      definitionOfDone: String(t.definitionOfDone),
      dependencies: deps,
      parallelGroup: t.parallelGroup ? String(t.parallelGroup) : undefined,
    });
  }

  // Acyclic check via topological sort
  const visited = new Set<number>();
  const visiting = new Set<number>();
  function dfs(node: number): boolean {
    if (visiting.has(node)) return false; // cycle
    if (visited.has(node)) return true;
    visiting.add(node);
    for (const dep of validated[node].dependencies) {
      if (!dfs(dep)) return false;
    }
    visiting.delete(node);
    visited.add(node);
    return true;
  }
  for (let i = 0; i < validated.length; i++) {
    if (!dfs(i)) {
      throw new Error('Circular dependency detected in tasks');
    }
  }

  return validated;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export async function decompose(request: DecomposeGenerateRequest): Promise<DecomposeGenerateResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { success: false, tasks: [], error: 'OPENROUTER_API_KEY not set' };
  }

  const context = await gatherContext(request);
  const systemPrompt = buildSystemPrompt();

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        log.info('decompose', `Calling ${model} (attempt ${attempt + 1})`, {
          contextLength: context.length,
          includeDiff: request.includeDiff,
        });

        const response = await fetchWithTimeout(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: context },
              ],
              max_tokens: 4000,
              temperature: 0.4,
              response_format: TASK_SCHEMA,
            }),
          },
        );

        if (!response.ok) {
          log.warn('decompose', `${model} returned ${response.status}`);
          break; // try next model
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };

        const content = data.choices[0]?.message?.content;
        if (!content) {
          log.warn('decompose', `${model} returned empty content`);
          continue; // retry same model
        }

        const parsed = JSON.parse(content) as { tasks: unknown[] };
        const tasks = validateTasks(parsed.tasks);

        log.info('decompose', `Success with ${model}`, { taskCount: tasks.length });
        return { success: true, tasks };
      } catch (error) {
        log.warn('decompose', `${model} attempt ${attempt + 1} failed`, error);
        if (attempt === 1) break; // tried twice, move to next model
      }
    }
  }

  return { success: false, tasks: [], error: 'All models failed to generate valid tasks' };
}
