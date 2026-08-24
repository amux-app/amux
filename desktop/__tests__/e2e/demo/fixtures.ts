// Staged data for the cinematic demo recordings — the "aurora-engine" project.
// Pure data only; no DOM/page interaction lives in this file.

export interface DemoFakePane {
  id: string;
  slug: string;
  title: string;
  branchName: string;
  prompt: string;
  paneId: string;
  agent: 'claude' | 'codex' | 'opencode';
  agentStatus: 'working' | 'analyzing' | 'waiting' | 'idle';
  worktreePath: string;
  projectName: string;
  projectRoot: string;
  agentSessionId: string;
  modelId?: string;
}

const PROJECT_NAME = 'aurora-engine';

function makePane(overrides: Partial<DemoFakePane> & Pick<DemoFakePane, 'id' | 'agent'>): DemoFakePane {
  return {
    id: overrides.id,
    slug: overrides.slug ?? overrides.id,
    title: overrides.title ?? overrides.id,
    branchName: overrides.branchName ?? `feat/${overrides.slug ?? overrides.id}`,
    prompt: overrides.prompt ?? '',
    paneId: overrides.paneId ?? `%${100 + Math.floor(Math.random() * 900)}`,
    agent: overrides.agent,
    agentStatus: overrides.agentStatus ?? 'working',
    worktreePath: overrides.worktreePath ?? `/tmp/aumx-demo/${overrides.id}`,
    projectName: PROJECT_NAME,
    projectRoot: overrides.projectRoot ?? '/tmp/aumx-demo-root',
    agentSessionId: overrides.agentSessionId ?? `session-${overrides.id}`,
    modelId: overrides.modelId,
  };
}

// Four panes, four status states, three agent engines — the fleet grid reads
// at a glance: working / analyzing / waiting-for-input / review-ready.
export const DEMO_PANES: DemoFakePane[] = [
  makePane({
    id: 'pane-auth',
    slug: 'refactor-auth-flow',
    title: 'Refactor auth flow',
    prompt: 'Refactor the auth flow to use the new token rotation strategy. Add tests.',
    agent: 'claude',
    agentStatus: 'working',
    modelId: 'claude-opus-4-8',
  }),
  makePane({
    id: 'pane-perf',
    slug: 'optimize-render-pipeline',
    title: 'Optimize render pipeline',
    prompt: 'Find the slow path in the render pipeline. Profile, fix, and benchmark.',
    agent: 'codex',
    agentStatus: 'analyzing',
    modelId: 'gpt-5-codex',
  }),
  makePane({
    id: 'pane-tests',
    slug: 'add-checkout-integration-tests',
    title: 'Add checkout integration tests',
    prompt: 'Add integration tests for the checkout flow, but confirm before touching CI config.',
    agent: 'claude',
    agentStatus: 'waiting',
    modelId: 'claude-opus-4-8',
  }),
  makePane({
    id: 'pane-docs',
    slug: 'generate-api-docs',
    title: 'Generate API docs',
    prompt: 'Generate OpenAPI documentation for every public endpoint.',
    agent: 'opencode',
    agentStatus: 'idle',
    modelId: 'sonnet',
  }),
];

export const ANTHROPIC_PROVIDER_STATUS = {
  provider: 'anthropic',
  level: 'degraded',
  quality: {
    score: 55,
    level: 'degraded',
    trend: 'stable',
    measuredAt: Date.now() - 1000 * 60 * 18,
    models: [
      {
        id: '4711',
        name: 'claude-opus-4-8',
        score: 55,
        status: 'warning',
        trend: 'stable',
        history: [58, 57, 59, 56, 55, 57, 55, 54, 55, 55, 56, 55],
      },
      {
        id: '4501',
        name: 'claude-sonnet-4-5-20250929',
        score: 63,
        status: 'good',
        trend: 'up',
        history: [60, 61, 62, 63, 63, 64, 63, 63, 63],
      },
      {
        id: '4502',
        name: 'claude-opus-4-5-20251101',
        score: 62,
        status: 'good',
        trend: 'stable',
        history: [62, 61, 62, 62, 63, 62, 62, 62, 62],
      },
      {
        id: '4601',
        name: 'claude-opus-4-6',
        score: 62,
        status: 'good',
        trend: 'stable',
        history: [60, 61, 62, 62, 62, 62, 63, 62, 62],
      },
    ],
  },
  operational: { level: 'ok', description: 'API all systems operational' },
  sparkline: [58, 57, 59, 56, 55, 57, 55, 54, 55, 55, 56, 55],
  updatedAt: Date.now() - 1000 * 60 * 18,
};

export const OPENAI_PROVIDER_STATUS = {
  provider: 'openai',
  level: 'ok',
  quality: {
    score: 71,
    level: 'ok',
    trend: 'up',
    measuredAt: Date.now() - 1000 * 60 * 9,
    models: [
      { id: 'oai1', name: 'gpt-5-codex', score: 71, status: 'good', trend: 'up', history: [66, 67, 68, 69, 70, 71, 71, 72, 71] },
      { id: 'oai2', name: 'gpt-5', score: 69, status: 'good', trend: 'stable', history: [69, 70, 69, 69, 70, 69, 69, 69] },
    ],
  },
  operational: { level: 'ok', description: 'API all systems operational' },
  sparkline: [66, 67, 68, 69, 70, 71, 71, 72, 71],
  updatedAt: Date.now() - 1000 * 60 * 9,
};

export function buildSession(pane: DemoFakePane) {
  const now = Date.now();
  const minute = 60 * 1000;
  const baseMessages = [
    {
      id: `${pane.id}-u1`,
      type: 'user',
      timestamp: now - 9 * minute,
      content: pane.prompt,
      toolCalls: [],
      toolResults: [],
    },
    {
      id: `${pane.id}-a1`,
      type: 'assistant',
      timestamp: now - 8 * minute,
      content: 'Scanning the workspace for relevant files…',
      toolCalls: [
        {
          id: `tc-${pane.id}-1`,
          name: 'Read',
          input: { file_path: 'src/index.ts' },
          status: 'completed',
          startedAt: now - 8 * minute,
          completedAt: now - 8 * minute + 200,
        },
        {
          id: `tc-${pane.id}-2`,
          name: 'Grep',
          input: { pattern: 'authenticate', path: 'src' },
          status: 'completed',
          startedAt: now - 8 * minute + 250,
          completedAt: now - 8 * minute + 410,
        },
      ],
      toolResults: [],
      tokens: { inputTokens: 1240, outputTokens: 280 },
      model: pane.modelId,
    },
    {
      id: `${pane.id}-a2`,
      type: 'assistant',
      timestamp: now - 6 * minute,
      content: 'Found the core path. Applying edits across three files.',
      toolCalls: [
        {
          id: `tc-${pane.id}-3`,
          name: 'Edit',
          input: { file_path: 'src/auth/rotate.ts' },
          status: 'completed',
          startedAt: now - 6 * minute,
          completedAt: now - 6 * minute + 320,
        },
        {
          id: `tc-${pane.id}-4`,
          name: 'Edit',
          input: { file_path: 'src/auth/index.ts' },
          status: 'completed',
          startedAt: now - 6 * minute + 400,
          completedAt: now - 6 * minute + 660,
        },
        {
          id: `tc-${pane.id}-5`,
          name: 'Write',
          input: { file_path: 'src/auth/__tests__/rotate.test.ts' },
          status: 'completed',
          startedAt: now - 6 * minute + 700,
          completedAt: now - 6 * minute + 990,
        },
      ],
      toolResults: [],
      tokens: { inputTokens: 3210, outputTokens: 1180 },
      model: pane.modelId,
    },
    {
      id: `${pane.id}-a3`,
      type: 'assistant',
      timestamp: now - 3 * minute,
      content: 'Running the test suite to confirm the rotation logic.',
      toolCalls: [
        {
          id: `tc-${pane.id}-6`,
          name: 'Bash',
          input: { command: 'pnpm test src/auth' },
          status: 'completed',
          startedAt: now - 3 * minute,
          completedAt: now - 3 * minute + 4200,
        },
      ],
      toolResults: [],
      tokens: { inputTokens: 4910, outputTokens: 540 },
      model: pane.modelId,
    },
    {
      id: `${pane.id}-a4`,
      type: 'assistant',
      timestamp: now - 1 * minute,
      content: 'All 14 tests pass. Tokens rotate on every request now and the suite covers expiry, replay, and revoke paths. Ready for review.',
      toolCalls: [],
      toolResults: [],
      tokens: { inputTokens: 5040, outputTokens: 620 },
      model: pane.modelId,
    },
  ];

  return {
    agent: pane.agent,
    sessionId: pane.agentSessionId,
    title: pane.title,
    aiTitle: pane.title,
    messages: baseMessages,
    metrics: {
      totalTokens: 14_490,
      inputTokens: 12_400,
      outputTokens: 2_090,
      cacheReadTokens: 8_900,
      cacheCreationTokens: 1_200,
      messageCount: baseMessages.length,
      toolCallCount: 6,
      costUSD: 0.42,
      costSource: 'estimate',
    },
    compactionEvents: [],
    subagents: [],
    isOngoing: pane.agentStatus !== 'idle',
    turnCompleted: pane.agentStatus === 'idle',
    awaitingUserInput: pane.agentStatus === 'waiting',
    startTime: now - 12 * minute,
    lastUpdateTime: now - 1 * minute,
    providerId: pane.agent === 'claude' ? 'anthropic' : pane.agent === 'codex' ? 'openai' : 'anthropic',
    modelId: pane.modelId,
  };
}

export interface MockTerminalContent {
  paneId: string;
  agent: 'claude' | 'codex' | 'opencode';
  agentLabel: string;
  prompt: string;
  lines: Array<{ kind: 'system' | 'user' | 'assistant' | 'tool' | 'output' | 'status'; text: string }>;
}

export const MOCK_TERMINALS: Record<string, MockTerminalContent> = {
  'pane-auth': {
    paneId: 'pane-auth',
    agent: 'claude',
    agentLabel: 'Claude · opus-4-8',
    prompt: 'Refactor the auth flow to use the new token rotation strategy. Add tests.',
    lines: [
      { kind: 'system', text: '── claude code · 2.4.1 ──────────────────────────' },
      { kind: 'system', text: 'cwd: ~/aurora-engine · branch: feat/refactor-auth-flow' },
      { kind: 'user', text: '› Refactor the auth flow to use the new token rotation' },
      { kind: 'user', text: '  strategy. Add tests for expiry, replay, revoke.' },
      { kind: 'assistant', text: 'I\'ll scan the auth module and plan the changes.' },
      { kind: 'tool', text: '⏺ Read  src/auth/index.ts                       (412 lines)' },
      { kind: 'tool', text: '⏺ Grep  pattern="rotate|refresh" in src/auth     (8 hits)' },
      { kind: 'assistant', text: 'Found it. Applying edits across three files.' },
      { kind: 'tool', text: '⏺ Edit  src/auth/rotate.ts            +42 −18' },
      { kind: 'tool', text: '⏺ Edit  src/auth/index.ts             +12  −9' },
      { kind: 'tool', text: '⏺ Write src/auth/__tests__/rotate.test.ts  +118' },
      { kind: 'tool', text: '⏺ Bash  pnpm test src/auth' },
      { kind: 'output', text: '  PASS  src/auth/__tests__/rotate.test.ts (14 tests)' },
      { kind: 'output', text: '  Tests: 14 passed, 14 total · 1.42s' },
      { kind: 'assistant', text: 'All tests pass. Rotation handles expiry, replay, and' },
      { kind: 'assistant', text: 'revoke paths. Ready for review.' },
      { kind: 'status', text: '▎working ▸ analyzing diff ▸ idle' },
    ],
  },
  'pane-perf': {
    paneId: 'pane-perf',
    agent: 'codex',
    agentLabel: 'Codex · gpt-5-codex',
    prompt: 'Find the slow path in the render pipeline. Profile, fix, benchmark.',
    lines: [
      { kind: 'system', text: '── codex · 0.9.4 ────────────────────────────────' },
      { kind: 'system', text: 'cwd: ~/aurora-engine · branch: feat/optimize-render-pipeline' },
      { kind: 'user', text: '› Find the slow path in the render pipeline.' },
      { kind: 'user', text: '  Profile, fix, and benchmark.' },
      { kind: 'assistant', text: 'Starting with a CPU profile of the hot path.' },
      { kind: 'tool', text: '⏺ shell  node --prof bench/render.bench.js' },
      { kind: 'output', text: '  Top frame: layoutChildren   62.4% · 1284ms' },
      { kind: 'output', text: '  Top frame: measureText      17.8% · 366ms' },
      { kind: 'assistant', text: 'layoutChildren recomputes for every child. Memo' },
      { kind: 'assistant', text: 'the measure step keyed on font + content.' },
      { kind: 'tool', text: '⏺ apply_patch  src/render/layout.ts   +28 −11' },
      { kind: 'tool', text: '⏺ shell  pnpm bench:render' },
      { kind: 'output', text: '  before: 2058ms   after: 412ms   (5.0× speedup)' },
      { kind: 'status', text: '▎analyzing ▸ comparing baselines' },
    ],
  },
  'pane-tests': {
    paneId: 'pane-tests',
    agent: 'claude',
    agentLabel: 'Claude · opus-4-8',
    prompt: 'Add integration tests for the checkout flow, but confirm before touching CI config.',
    lines: [
      { kind: 'system', text: '── claude code · 2.4.1 ──────────────────────────' },
      { kind: 'system', text: 'cwd: ~/aurora-engine · branch: feat/add-checkout-integration-tests' },
      { kind: 'user', text: '› Add integration tests for the checkout flow, but' },
      { kind: 'user', text: '  confirm before touching CI config.' },
      { kind: 'assistant', text: 'Found the checkout flow. Drafting a Playwright suite.' },
      { kind: 'tool', text: '⏺ Read  src/checkout/flow.ts                    (238 lines)' },
      { kind: 'tool', text: '⏺ Write test/checkout.spec.ts                   +146' },
      { kind: 'assistant', text: 'Suite is ready. Wiring it into CI needs a new job —' },
      { kind: 'assistant', text: 'may I add `checkout-e2e` to .github/workflows/ci.yml?' },
      { kind: 'status', text: '⏸ waiting for input ▸ confirm CI change' },
    ],
  },
  'pane-docs': {
    paneId: 'pane-docs',
    agent: 'opencode',
    agentLabel: 'OpenCode · sonnet',
    prompt: 'Generate OpenAPI documentation for every public endpoint.',
    lines: [
      { kind: 'system', text: '── opencode · 0.18.0 ────────────────────────────' },
      { kind: 'system', text: 'cwd: ~/aurora-engine · branch: feat/generate-api-docs' },
      { kind: 'user', text: '› Generate OpenAPI documentation for every public' },
      { kind: 'user', text: '  endpoint.' },
      { kind: 'assistant', text: 'Indexing route handlers under src/api/...' },
      { kind: 'tool', text: '⏺ list_files  src/api  (38 files)' },
      { kind: 'tool', text: '⏺ read_many   *.controller.ts  (38)' },
      { kind: 'assistant', text: 'Detected 47 endpoints across 12 controllers.' },
      { kind: 'tool', text: '⏺ write  docs/openapi.yaml   +1284 lines' },
      { kind: 'tool', text: '⏺ shell  pnpm spectral lint docs/openapi.yaml' },
      { kind: 'output', text: '  ✔ 0 errors, 2 warnings (operationId casing)' },
      { kind: 'assistant', text: 'Spec validates. Auto-fixing the casing now.' },
      { kind: 'tool', text: '⏺ edit  docs/openapi.yaml   +47 −47' },
      { kind: 'output', text: '  ✔ 0 errors, 0 warnings' },
      { kind: 'status', text: '✓ done · 47 endpoints documented' },
    ],
  },
};
