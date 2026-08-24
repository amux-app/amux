import { AGENT_CAPABILITIES, AGENT_IDS } from 'aumx/core';
import { validatePaneName } from 'aumx/pane-name';
import { z } from 'zod';
import { IPC } from '../../shared/ipc-channels.js';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/sidebar-metrics.js';

type IpcChannel = (typeof IPC)[keyof typeof IPC];
type IpcArgsSchema = z.ZodType<unknown>;

const agentSchema = z.enum(AGENT_IDS);
const agentCapabilitySchema = z.enum(AGENT_CAPABILITIES);
const complexitySchema = z.enum(['S', 'M', 'L']);
const settingsScopeSchema = z.enum(['global', 'project']);
const paneTypeSchema = z.enum(['agent', 'shell']);
const gitDiffModeSchema = z.enum(['working', 'branch', 'commit']);
const rendererLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const themeSchema = z.enum(['dark', 'light', 'colorful', 'dark-colorful', 'system']);
const cursorStyleSchema = z.enum(['block', 'underline', 'bar']);
const terminalOsc52ClipboardSchema = z.enum(['allow', 'off']);
const terminalThemeSchema = z.enum(['dark', 'follow']);
const terminalTransportSchema = z.enum(['classic', 'control', 'pty']);
const terminalScrollDirectionSchema = z.enum(['down', 'up']);
const terminalAlternateScreenModeSchema = z.enum(['arrow-keys', 'opencode']);
const sidebarOrganizeSchema = z.enum(['project', 'flat']);
const sidebarSortSchema = z.enum(['priority', 'updated', 'manual']);
const marketplaceInstallModeSchema = z.enum(['full', 'selected']);

// Model + effort: defense-in-depth on top of shQuote at the launch layer. The
// regex rejects shell metacharacters (`;`, `|`, backtick, `$`, spaces, newlines)
// and caps length so a curated dropdown OR a user-defined opencode model id
// (e.g. "openai/gpt-5.5-fast") can pass through cleanly. shQuote in the launch
// path is the actual injection boundary.
const modelSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._\-/]+$/);
const effortSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/);
const paneNameSchema = z.string().transform((value, context) => {
  const validation = validatePaneName(value);
  if (validation.ok) return validation.value;
  context.addIssue({ code: 'custom', message: validation.message });
  return z.NEVER;
});

const duelSideSchema = z.object({
  agent: agentSchema,
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
}).strict();

function duelSideKey(side: z.infer<typeof duelSideSchema>): string {
  return `${side.agent}|${side.model ?? ''}|${side.effort ?? ''}`;
}

const electronSettingValueSchemas = {
  theme: themeSchema,
  terminalFontFamily: z.string(),
  terminalFontSize: z.number().int().min(8).max(24),
  uiZoom: z.number().min(0.8).max(1.5),
  compactMode: z.boolean(),
  cursorStyle: cursorStyleSchema,
  cursorBlink: z.boolean(),
  scrollbackLines: z.number().int().min(500).max(200000),
  copyOnSelect: z.boolean(),
  opencodeMousePassthrough: z.boolean(),
  terminalBell: z.boolean(),
  terminalOsc52Clipboard: terminalOsc52ClipboardSchema,
  terminalPreferredLaunchCols: z.number().int().min(0).max(1000),
  terminalPreferredLaunchRows: z.number().int().min(0).max(500),
  terminalTheme: terminalThemeSchema,
  terminalTransport: terminalTransportSchema,
  sidebarCollapsed: z.boolean(),
  sidebarOrganize: sidebarOrganizeSchema,
  sidebarSort: sidebarSortSchema,
  sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  alwaysOnTop: z.boolean(),
  windowOpacity: z.number().min(0.1).max(1),
  debugLogging: z.boolean(),
  enableKanbanBoard: z.boolean(),
  enablePaneSummary: z.boolean(),
  enableTelemetryCostTracking: z.boolean(),
  costCurrency: z.enum(['USD', 'EUR-hai', 'EUR-market']),
  enableConversationTopics: z.boolean(),
  enableAgentLifecycleAdapters: z.boolean(),
  enableReviewAgent: z.boolean(),
  enableLanguageIntelligence: z.boolean(),
  pollingInterval: z.number().int().min(100).max(2000),
  showPerformanceMetrics: z.boolean(),
  showArenaScores: z.boolean(),
  showAgentHealthTracker: z.boolean(),
  disableExternalNetwork: z.boolean(),
} as const satisfies Record<string, z.ZodTypeAny>;

type ElectronSettingKey = keyof typeof electronSettingValueSchemas;

export const electronSettingKeys = Object.keys(electronSettingValueSchemas) as ElectronSettingKey[];

const electronSettingKeySchema = z.enum(
  Object.keys(electronSettingValueSchemas) as [ElectronSettingKey, ...ElectronSettingKey[]],
);

const electronSettingUpdateSchema = z.object({
  key: electronSettingKeySchema,
  value: z.unknown(),
}).strict().superRefine((data, ctx) => {
  const valueSchema = electronSettingValueSchemas[data.key];
  const result = valueSchema.safeParse(data.value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: ['value', ...issue.path],
      });
    }
  }
});

const noArgs = z.tuple([]);
const stringValue = z.string();
const optionalStringValue = stringValue.optional();
const booleanValue = z.boolean();
const numberValue = z.number();
const positiveIntegerValue = z.number().int().positive();
const terminalColsValue = z.number().int().min(2).max(1000);
const terminalRowsValue = z.number().int().min(2).max(500);
const stringArray = z.array(stringValue);

function oneArg(schema: z.ZodType<unknown>): IpcArgsSchema {
  return z.tuple([schema]);
}

function optionalOneArg(schema: z.ZodType<unknown>): IpcArgsSchema {
  return z.union([z.tuple([]), z.tuple([schema.optional()])]);
}

const supportBundleArgs = oneArg(z.object({ includeTranscripts: booleanValue }).strict());
const paneIdRequestSchema = z.object({ paneId: stringValue }).strict();
const projectRootRequestSchema = z.object({ projectRoot: stringValue }).strict();
const projectSwitchRequestSchema = z.object({
  fresh: booleanValue.optional(),
  projectRoot: stringValue,
}).strict();
const rootPathRequestSchema = z.object({ rootPath: stringValue }).strict();
const backlogItemInputSchema = z.object({
  title: stringValue,
  prompt: stringValue,
  complexity: complexitySchema,
  sourceSlug: optionalStringValue,
  sourcePaneId: optionalStringValue,
  dependencies: stringArray.optional(),
  parallelGroup: optionalStringValue,
  agent: agentSchema.optional(),
  useWorktree: booleanValue.optional(),
  projectRoot: optionalStringValue,
  variants: numberValue.optional(),
}).strict();
const doneItemInputSchema = z.object({
  slug: stringValue,
  prompt: stringValue,
  sourceSlug: optionalStringValue,
  branchName: optionalStringValue,
  agent: agentSchema.optional(),
  cleanupFailed: booleanValue.optional(),
}).strict();
const backlogUpdateSchema = z.object({
  title: optionalStringValue,
  prompt: optionalStringValue,
  complexity: complexitySchema.optional(),
  agent: agentSchema.optional(),
  useWorktree: booleanValue.optional(),
  projectRoot: optionalStringValue,
  order: numberValue.optional(),
}).strict();

const ipcRequestSchemas = {
  [IPC.APP_BOOT_STATE_GET]: noArgs,
  [IPC.APP_FILE_FLUSH_RESULT]: oneArg(z.object({
    requestId: stringValue,
    success: booleanValue,
  }).strict()),
  [IPC.APP_QUIT]: noArgs,
  [IPC.APP_RELAUNCH]: noArgs,
  [IPC.UPDATE_STATE_GET]: noArgs,
  [IPC.UPDATE_CHECK]: noArgs,
  [IPC.UPDATE_INSTALL]: noArgs,
  [IPC.PANE_LIST]: optionalOneArg(z.object({ projectRoot: optionalStringValue }).strict()),
  [IPC.PANE_ACTIVITY_SNAPSHOT_GET]: noArgs,
  [IPC.PANE_CREATE]: oneArg(z.object({
    prompt: stringValue,
    agent: agentSchema.optional(),
    claudeRenderer: z.literal('classic').optional(),
    projectRoot: optionalStringValue,
    type: paneTypeSchema.optional(),
    useWorktree: booleanValue.optional(),
    paneName: optionalStringValue,
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
    resumeSessionId: optionalStringValue,
  }).strict()),
  [IPC.PANE_CLOSE]: oneArg(paneIdRequestSchema),
  [IPC.PANE_MERGE]: oneArg(paneIdRequestSchema),
  [IPC.PANE_RESUME_FULLSCREEN]: oneArg(paneIdRequestSchema),
  [IPC.PANE_RENAME]: oneArg(z.object({ paneId: stringValue, newName: paneNameSchema }).strict()),
  [IPC.PANE_ATTACH_WORKTREE]: oneArg(z.object({ paneId: stringValue, worktreePath: stringValue }).strict()),
  [IPC.PANE_JUMP]: oneArg(paneIdRequestSchema),
  [IPC.PANE_SEND_KEYS]: oneArg(z.object({ paneId: stringValue, command: stringValue }).strict()),
  [IPC.PANE_GET_CONTENT]: oneArg(paneIdRequestSchema),
  [IPC.PANE_CREATE_WORKTREE]: oneArg(paneIdRequestSchema),
  [IPC.PANE_DUPLICATE]: oneArg(paneIdRequestSchema),
  [IPC.PANE_START_REVIEW]: oneArg(z.object({ paneId: stringValue, agent: agentSchema.optional() }).strict()),
  [IPC.PANE_SEND_FIX]: oneArg(z.object({ reviewPaneId: stringValue }).strict()),
  [IPC.PANE_SESSION_LIST]: oneArg(z.object({
    agent: agentSchema,
    limit: positiveIntegerValue.max(100).optional(),
    projectRoot: stringValue,
  }).strict()),
  [IPC.PANE_DUEL_CREATE]: oneArg(z.object({
    claudeRenderer: z.literal('classic').optional(),
    prompt: stringValue.trim().min(1),
    sides: z.tuple([duelSideSchema, duelSideSchema]).refine(
      ([a, b]) => duelSideKey(a) !== duelSideKey(b),
      { message: 'Duel sides must differ in agent, model, or effort' },
    ),
    useWorktree: booleanValue.optional(),
    projectRoot: optionalStringValue,
    paneName: optionalStringValue,
  }).strict()),
  [IPC.PANE_DUEL_RESOLVE]: oneArg(z.object({
    winnerPaneId: stringValue.min(1),
  }).strict()),
  [IPC.ACTION_CALLBACK]: oneArg(z.object({
    callbackId: stringValue,
    value: optionalStringValue,
  }).strict()),
  [IPC.TERMINAL_ATTACH]: oneArg(z.object({
    cols: terminalColsValue.optional(),
    fixedCols: terminalColsValue.optional(),
    paneId: stringValue,
    rows: terminalRowsValue.optional(),
    sessionName: stringValue,
    skipScrollbackReplay: booleanValue.optional(),
    streamId: numberValue.optional(),
    transcriptPath: optionalStringValue,
  }).strict()),
  [IPC.TERMINAL_DETACH]: oneArg(paneIdRequestSchema),
  [IPC.TERMINAL_RESIZE]: oneArg(z.object({
    paneId: stringValue,
    cols: terminalColsValue,
    rows: terminalRowsValue,
  }).strict()),
  [IPC.TERMINAL_SELECTION_EXPAND]: oneArg(z.object({
    anchorText: z.string().min(1).max(5 * 1024 * 1024),
    currentText: z.string().min(1).max(5 * 1024 * 1024),
    direction: terminalScrollDirectionSchema,
    paneId: stringValue,
  }).strict()),
  [IPC.TERMINAL_SCROLL]: oneArg(z.object({
    alternateScreenMode: terminalAlternateScreenModeSchema.optional(),
    direction: terminalScrollDirectionSchema,
    lines: positiveIntegerValue,
    paneId: stringValue,
  }).strict()),
  [IPC.TERMINAL_WRITE]: oneArg(z.object({
    data: stringValue,
    paneId: stringValue,
    userInitiated: z.boolean().optional(),
  }).strict()),
  [IPC.TERMINAL_UNLOCK_STDIN]: oneArg(paneIdRequestSchema),
  [IPC.PROJECT_LIST]: noArgs,
  [IPC.PROJECT_SWITCH]: oneArg(projectSwitchRequestSchema),
  [IPC.SETTINGS_DEFINITIONS]: noArgs,
  [IPC.SETTINGS_GET]: optionalOneArg(z.object({ projectRoot: optionalStringValue }).strict()),
  [IPC.SETTINGS_UPDATE]: oneArg(z.object({
    key: stringValue,
    value: z.unknown(),
    scope: settingsScopeSchema,
  }).strict()),
  [IPC.GIT_DIFF]: oneArg(z.object({
    worktreePath: stringValue,
    diffMode: gitDiffModeSchema.optional(),
  }).strict()),
  [IPC.GIT_FILE_DIFF]: oneArg(z.object({
    worktreePath: stringValue,
    diffMode: gitDiffModeSchema.optional(),
    path: stringValue,
    oldPath: optionalStringValue,
  }).strict()),
  [IPC.GIT_STATUS]: oneArg(z.object({ worktreePath: stringValue }).strict()),
  [IPC.GIT_BRANCHES]: oneArg(projectRootRequestSchema),
  [IPC.AGENT_LIST]: optionalOneArg(z.object({ capability: agentCapabilitySchema.optional() }).strict()),
  [IPC.AGENT_REFRESH]: optionalOneArg(z.object({ capability: agentCapabilitySchema.optional() }).strict()),
  [IPC.AGENT_DEFAULTS_GET]: optionalOneArg(z.object({ projectRoot: optionalStringValue }).strict()),
  [IPC.LLM_STATUS]: noArgs,
  [IPC.AGENT_HEALTH]: noArgs,
  [IPC.SYSTEM_APP_INFO]: noArgs,
  [IPC.SYSTEM_CHECK]: noArgs,
  [IPC.SESSION_INFO]: noArgs,
  [IPC.ELECTRON_SETTINGS_GET]: noArgs,
  [IPC.ELECTRON_SETTINGS_UPDATE]: oneArg(electronSettingUpdateSchema),
  [IPC.ELECTRON_SETTINGS_RESET]: noArgs,
  [IPC.AGENT_SESSION_GET]: oneArg(paneIdRequestSchema),
  [IPC.AGENT_SESSION_SEARCH]: oneArg(z.object({ query: stringValue }).strict()),
  [IPC.TOPICS_LIST]: noArgs,
  [IPC.WORKSPACE_HISTORY_LIST]: noArgs,
  [IPC.WORKSPACE_HISTORY_TOUCH]: oneArg(z.object({
    name: stringValue,
    root: stringValue,
    paneCount: numberValue,
  }).strict()),
  [IPC.WORKSPACE_HISTORY_REMOVE]: oneArg(z.object({ root: stringValue }).strict()),
  [IPC.WORKSPACE_OPEN_FOLDER]: noArgs,
  [IPC.WORKSPACE_NEW_PROJECT]: noArgs,
  [IPC.WORKSPACE_CREATE_SESSION]: oneArg(z.object({ folderPath: stringValue }).strict()),
  [IPC.WORKTREE_ORPHAN_INSPECT]: oneArg(z.object({ worktreePath: stringValue }).strict()),
  [IPC.WORKTREE_ORPHANS_LIST]: noArgs,
  [IPC.WORKTREE_REMOVE]: oneArg(z.object({
    allowDataLoss: booleanValue,
    expectedState: z.object({
      branch: stringValue.nullable(),
      gitStatus: z.enum(['clean', 'dirty', 'unavailable', 'unchecked']),
      registration: z.enum(['registered', 'unregistered', 'unchecked']),
    }).strict(),
    worktreePath: stringValue,
  }).strict()),
  [IPC.WORKTREE_REOPEN]: oneArg(z.object({ worktreePath: stringValue }).strict()),
  [IPC.KANBAN_GET]: oneArg(projectRootRequestSchema),
  [IPC.KANBAN_BACKLOG_ADD]: oneArg(z.object({
    projectRoot: stringValue,
    items: z.array(backlogItemInputSchema),
  }).strict()),
  [IPC.KANBAN_BACKLOG_REMOVE]: oneArg(z.object({
    projectRoot: stringValue,
    itemIds: stringArray,
  }).strict()),
  [IPC.KANBAN_BACKLOG_UPDATE]: oneArg(z.object({
    projectRoot: stringValue,
    itemId: stringValue,
    updates: backlogUpdateSchema,
  }).strict()),
  [IPC.KANBAN_BACKLOG_REORDER]: oneArg(z.object({
    projectRoot: stringValue,
    orderedIds: stringArray,
  }).strict()),
  [IPC.KANBAN_DONE_ADD]: oneArg(z.object({
    projectRoot: stringValue,
    item: doneItemInputSchema,
  }).strict()),
  [IPC.KANBAN_DONE_CLEAR]: oneArg(projectRootRequestSchema),
  [IPC.KANBAN_BATCH_LAUNCH]: oneArg(z.object({
    projectRoot: stringValue,
    itemIds: stringArray,
  }).strict()),
  [IPC.SYSTEM_REVEAL_PATH]: oneArg(z.object({ path: stringValue }).strict()),
  [IPC.SYSTEM_OPEN_EXTERNAL]: oneArg(z.object({ url: stringValue }).strict()),
  [IPC.SYSTEM_OPEN_IN_EDITOR]: oneArg(z.object({
    path: stringValue,
    file: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
    // A detected editor id (resolved to a trusted command in main) — never a
    // raw command string, so the renderer can't name an arbitrary binary.
    editorId: z.string().max(64).optional(),
  }).strict()),
  [IPC.SYSTEM_LIST_EDITORS]: noArgs,
  [IPC.SYSTEM_PREVIEW_SUPPORT_BUNDLE]: supportBundleArgs,
  [IPC.SYSTEM_EXPORT_SUPPORT_BUNDLE]: supportBundleArgs,
  [IPC.SYSTEM_CLIPBOARD_WRITE]: oneArg(z.object({ text: stringValue }).strict()),
  [IPC.SYSTEM_CLIPBOARD_READ]: noArgs,
  [IPC.RENDERER_LOG]: oneArg(z.object({
    level: rendererLogLevelSchema,
    scope: stringValue,
    message: stringValue,
    data: z.unknown().optional(),
  }).strict()),
  [IPC.DECOMPOSE_GENERATE]: oneArg(z.object({
    projectRoot: stringValue,
    paneId: stringValue,
    prompt: stringValue,
    contextHint: optionalStringValue,
    includeDiff: booleanValue.optional(),
  }).strict()),
  [IPC.RECAP_GENERATE]: oneArg(z.object({
    messages: z.array(stringValue),
    paneId: stringValue,
    chunkIndex: z.number(),
  }).strict()),
  [IPC.PANE_SUMMARY_LOAD_ALL]: noArgs,
  [IPC.PANE_SUMMARY_REFRESH_ONE]: oneArg(z.object({
    paneId: stringValue,
    force: booleanValue,
  }).strict()),
  [IPC.PANE_SUMMARY_REFRESH_MANY]: oneArg(z.object({
    paneIds: stringArray,
    force: booleanValue,
  }).strict()),
  [IPC.PANE_SUMMARY_GENERATE_RECAP_ONE]: oneArg(z.object({
    paneId: stringValue,
    force: booleanValue,
  }).strict()),
  [IPC.PANE_SUMMARY_GENERATE_RECAP_MANY]: oneArg(z.object({
    paneIds: stringArray,
    force: booleanValue,
  }).strict()),
  [IPC.PANE_SUMMARY_REMOVE]: oneArg(z.object({
    paneId: stringValue,
  }).strict()),
  [IPC.PROJECT_FILE_SEARCH]: oneArg(z.object({
    query: stringValue,
    rootPath: optionalStringValue,
  }).strict()),
  [IPC.PROJECT_TEXT_SEARCH]: oneArg(z.object({
    query: stringValue,
    rootPath: optionalStringValue,
  }).strict()),
  [IPC.FILE_LIST]: oneArg(z.object({
    rootPath: stringValue,
    dirPath: optionalStringValue,
  }).strict()),
  [IPC.FILE_READ]: oneArg(z.object({
    rootPath: stringValue,
    relativePath: stringValue,
  }).strict()),
  [IPC.FILE_READ_BINARY]: oneArg(z.object({
    rootPath: stringValue,
    relativePath: stringValue,
  }).strict()),
  [IPC.FILE_CREATE]: oneArg(rootPathRequestSchema.extend({ relativePath: stringValue }).strict()),
  [IPC.FILE_CREATE_DIR]: oneArg(rootPathRequestSchema.extend({ relativePath: stringValue }).strict()),
  [IPC.FILE_WRITE]: oneArg(z.union([
    z.object({
      content: stringValue,
      documentVersion: z.number().int().nonnegative(),
      editorSessionId: stringValue,
      eol: z.enum(['lf', 'crlf', 'cr']),
      expectedContentVersion: z.null(),
      expectedMissing: z.literal(true),
      hasBom: booleanValue,
      relativePath: stringValue,
      rootPath: stringValue,
      saveSequence: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      content: stringValue,
      documentVersion: z.number().int().nonnegative(),
      editorSessionId: stringValue,
      eol: z.enum(['lf', 'crlf', 'cr']),
      expectedContentVersion: stringValue,
      expectedMissing: z.literal(false).optional(),
      hasBom: booleanValue,
      relativePath: stringValue,
      rootPath: stringValue,
      saveSequence: z.number().int().nonnegative(),
    }).strict(),
  ])),
  [IPC.FILE_FORMAT]: oneArg(z.object({
    content: stringValue,
    documentVersion: z.number().int().nonnegative(),
    editorSessionId: stringValue,
    eol: z.enum(['lf', 'crlf', 'cr']),
    fileKey: stringValue,
    relativePath: stringValue,
    requestId: stringValue,
    rootPath: stringValue,
  }).strict()),
  [IPC.FILE_FORMAT_CANCEL]: oneArg(z.object({ requestId: stringValue }).strict()),
  [IPC.LSP_ACQUIRE]: oneArg(z.object({
    editorSessionId: stringValue,
    relativePath: stringValue,
    rootPath: stringValue,
  }).strict()),
  [IPC.LSP_RELEASE]: oneArg(z.object({
    editorSessionId: stringValue,
    rootId: stringValue,
  }).strict()),
  [IPC.LSP_SEND]: oneArg(z.object({
    editorSessionId: stringValue,
    message: z.string().max(16 * 1024 * 1024),
    rootId: stringValue,
  }).strict()),
  [IPC.FILE_DELETE]: oneArg(rootPathRequestSchema.extend({ relativePath: stringValue }).strict()),
  [IPC.FILE_RENAME]: oneArg(rootPathRequestSchema.extend({
    oldPath: stringValue,
    newPath: stringValue,
  }).strict()),
  [IPC.FILE_COPY]: oneArg(z.object({
    sourceRootPath: stringValue,
    sourcePath: stringValue,
    destRootPath: stringValue,
    destDir: stringValue,
  }).strict()),
  [IPC.FILE_MOVE]: oneArg(rootPathRequestSchema.extend({
    sourcePaths: z.array(stringValue).min(1).max(500),
    destDir: stringValue,
    mode: z.enum(['move', 'copy']),
  }).strict()),
  [IPC.FILE_WATCH_ROOT]: oneArg(z.object({
    dirPaths: z.array(stringValue).optional(),
    rootPath: optionalStringValue,
  }).strict()),

  // Marketplace
  [IPC.MARKETPLACE_SOURCES_LIST]: noArgs,
  [IPC.MARKETPLACE_SOURCE_ADD]: oneArg(z.object({
    url: stringValue,
  }).strict()),
  [IPC.MARKETPLACE_SOURCE_REMOVE]: oneArg(z.object({
    url: stringValue,
  }).strict()),
  [IPC.MARKETPLACE_SOURCE_UPDATE]: oneArg(z.object({
    url: stringValue,
  }).strict()),
  [IPC.MARKETPLACE_BROWSE]: oneArg(z.object({
    sourceUrl: stringValue,
  }).strict()),
  [IPC.MARKETPLACE_PREVIEW]: oneArg(z.object({
    pluginId: stringValue,
    sourceUrl: stringValue,
    mode: marketplaceInstallModeSchema.optional(),
    selectedSkills: z.array(stringValue).optional(),
    selectedMcpServers: z.array(stringValue).optional(),
    selectedAgents: z.array(stringValue).optional(),
  }).strict()),
  [IPC.MARKETPLACE_INSTALL]: oneArg(z.object({
    pluginId: stringValue,
    sourceUrl: stringValue,
    previewDigest: stringValue,
    mode: marketplaceInstallModeSchema.optional(),
    selectedSkills: z.array(stringValue).optional(),
    selectedMcpServers: z.array(stringValue).optional(),
    selectedAgents: z.array(stringValue).optional(),
  }).strict()),
  [IPC.MARKETPLACE_UNINSTALL]: oneArg(z.object({
    pluginId: stringValue,
    sourceUrl: stringValue,
  }).strict()),
  [IPC.MARKETPLACE_INSTALLED_LIST]: noArgs,
} satisfies Record<IpcChannel, IpcArgsSchema>;

export function validateIpcInvokeArgs(channel: string, args: unknown[]): unknown[] {
  const schema = ipcRequestSchemas[channel as IpcChannel];
  if (!schema) {
    throw new Error(`No IPC request schema registered for ${channel}`);
  }

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid IPC payload for ${channel}: ${details}`);
  }

  if (!Array.isArray(parsed.data)) {
    throw new Error(`Invalid IPC payload for ${channel}: parsed payload is not an argument list`);
  }

  return parsed.data;
}
