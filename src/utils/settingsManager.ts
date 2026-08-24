import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { LogService } from '../services/LogService.js';
import type { AumxSettings, SettingsScope, SettingDefinition } from '../types.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { isValidBranchName } from './git.js';
import {
  CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY,
  parseStoredAumxSettings,
  type StoredAumxSettings,
} from './persistedStateValidation.js';
import { isSettingKey, validateSettingValue, validateSettingsPatch } from './settingsSchema.js';
import { getProjectMetadataPath } from './worktreePaths.js';

const GLOBAL_SETTINGS_PATH = join(homedir(), '.aumx.global.json');
const CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION = 1;

type ActivePermissionMode = '' | 'auto';
const PERMISSION_MODES = ['', 'auto'] as const;
function isPermissionMode(value: string): value is ActivePermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}
function normalizePermissionMode(permissionMode: unknown): ActivePermissionMode {
  if (permissionMode === 'auto' || permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions') {
    return 'auto';
  }
  return '';
}

function getPublicSettings(settings: StoredAumxSettings): AumxSettings {
  const publicSettings = { ...settings };
  delete publicSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY];
  return publicSettings;
}

function migrateLegacyClaudeFullscreenDefault(settings: StoredAumxSettings): {
  migrated: boolean;
  settings: StoredAumxSettings;
} {
  const resetVersion = settings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY];
  if (typeof resetVersion === 'number' && resetVersion >= CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION) {
    return { migrated: false, settings };
  }
  if (settings.claudeFullscreenRendering !== false) {
    return { migrated: false, settings };
  }

  const migratedSettings = { ...settings };
  delete migratedSettings.claudeFullscreenRendering;
  migratedSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
  return { migrated: true, settings: migratedSettings };
}
const DEFAULT_SETTINGS: AumxSettings = {
  permissionMode: 'auto',
  initGitIfMissing: true,
  useWorktree: false,
  claudeModel: 'opus',
  claudeEffort: 'ultracode',
  claudeFullscreenRendering: true,
  opencodeScrollbackMode: false,
};

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'permissionMode',
    label: 'Agent Permission Mode',
    description: 'Controls how much permission is granted to launched agents',
    type: 'select',
    options: [
      { value: '', label: 'Agent default' },
      { value: 'auto', label: 'Auto mode (safe workspace automation)' },
    ],
    section: 'General',
  },
  {
    key: 'defaultAgent',
    label: 'Default Agent',
    description: 'Skip agent selection and use this agent for all new panes',
    type: 'select',
    options: [
      { value: '', label: 'Ask each time' },
      { value: 'claude', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
      { value: 'codex', label: 'Codex' },
      { value: 'pi', label: 'Pi' },
    ],
    section: 'General',
  },
  {
    key: 'piThinking',
    label: 'Thinking',
    description: 'Pi thinking-level override. Empty uses Pi\'s configured default.',
    type: 'select',
    options: [
      { value: '', label: 'Use Pi default' },
      { value: 'off', label: 'Off' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
    ],
    section: 'Pi',
  },
  {
    key: 'claudeModel',
    label: 'Model',
    description: 'Model alias used when launching Claude Code. "opus" tracks the latest Opus release.',
    type: 'select',
    options: [
      { value: '', label: 'Claude default' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'haiku', label: 'Haiku (latest)' },
      { value: 'fable', label: 'Fable (latest)' },
    ],
    section: 'Claude Code',
  },
  {
    key: 'claudeEffort',
    label: 'Reasoning Effort',
    description: 'Extended thinking level. Higher means deeper reasoning, slower, more expensive. Ultracode = xhigh + harness orchestration hint.',
    type: 'select',
    options: [
      { value: '', label: 'Claude default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultracode (recommended)' },
    ],
    section: 'Claude Code',
  },
  {
    key: 'claudeFullscreenRendering',
    label: 'Fullscreen Rendering',
    description: 'Default: let Claude Code own conversation scrolling and selection in its fullscreen alternate-screen renderer. The composer stays pinned to the bottom. Classic compatibility mode uses native scrollback, but terminal history can be incomplete during tall redraws; use Activity for semantic conversation history. Existing panes keep the renderer they were launched with.',
    type: 'boolean',
    section: 'Claude Code',
  },
  {
    key: 'codexModel',
    label: 'Model',
    description: 'Model used when launching Codex. Empty defers to ~/.codex/config.toml.',
    type: 'select',
    options: [
      { value: '', label: 'Use config default' },
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'o4-mini', label: 'o4-mini' },
      { value: 'o3', label: 'o3' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    section: 'Codex',
  },
  {
    key: 'codexEffort',
    label: 'Reasoning Effort',
    description: 'Codex model_reasoning_effort override. Empty uses Codex\'s built-in default.',
    type: 'select',
    options: [
      { value: '', label: 'Use config default' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
    ],
    section: 'Codex',
  },
  {
    key: 'opencodeVariant',
    label: 'Reasoning Effort',
    description: 'OpenCode --variant (provider-specific reasoning effort). Empty defers to opencode.json. Model is read live from ~/.config/opencode/opencode.json.',
    type: 'select',
    options: [
      { value: '', label: 'Use config default' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
    ],
    section: 'OpenCode',
  },
  {
    key: 'opencodeScrollbackMode',
    label: 'Scrollback-Friendly Mode',
    description: 'Use OpenCode\'s compact --mini interface to preserve terminal scrollback and text selection. Off uses the standard full-screen OpenCode interface. Applies to newly started and resumed panes.',
    type: 'boolean',
    section: 'OpenCode',
  },
  {
    key: 'useTmuxHooks',
    label: 'Use Tmux Hooks',
    description: 'Use tmux hooks for event-driven updates (lower CPU). If disabled, uses polling in a worker thread.',
    type: 'boolean',
  },
  {
    key: 'baseBranch',
    label: 'Base Branch',
    description: 'Branch to create new worktrees from. Leave empty to use current HEAD.',
    type: 'text',
  },
  {
    key: 'branchPrefix',
    label: 'Branch Name Prefix',
    description: 'Prefix for new branch names (e.g. "feat/" produces branch "feat/fix-auth"). Leave empty for no prefix.',
    type: 'select',
    options: [
      { value: '', label: 'No prefix (default)' },
      { value: 'feat/', label: 'feat/' },
      { value: 'fix/', label: 'fix/' },
      { value: 'chore/', label: 'chore/' },
    ],
  },
  {
    key: 'useWorktree',
    label: 'Git Worktree Isolation',
    description: 'Create a separate git worktree for each pane, giving every agent its own branch and working directory',
    type: 'boolean',
  },
  {
    key: 'initGitIfMissing',
    label: 'Auto Initialize Git',
    description: 'When worktree isolation is enabled and no Git repository exists, run git init automatically.',
    type: 'boolean',
  },
  {
    key: 'hooks',
    label: 'Manage Hooks',
    description: 'View and edit aumx lifecycle hooks',
    type: 'action',
  },
];

export class SettingsManager {
  private static cache = new Map<string, { manager: SettingsManager; expiry: number }>();
  private static lastKnownGoodByPath = new Map<string, StoredAumxSettings>();
  private static CACHE_TTL = 5000;

  static getInstance(projectRoot?: string): SettingsManager {
    const root = projectRoot || process.cwd();
    const cached = SettingsManager.cache.get(root);
    if (cached && Date.now() < cached.expiry) {
      return cached.manager;
    }
    const manager = new SettingsManager(root);
    SettingsManager.cache.set(root, { manager, expiry: Date.now() + SettingsManager.CACHE_TTL });
    return manager;
  }

  static invalidateCache(projectRoot?: string): void {
    if (projectRoot) {
      SettingsManager.cache.delete(projectRoot);
    } else {
      SettingsManager.cache.clear();
    }
  }

  private globalPath: string;
  private projectPath: string;
  private globalSettings: StoredAumxSettings = {};
  private invalidSettingsScopes = new Set<SettingsScope>();
  private projectSettings: StoredAumxSettings = {};

  constructor(projectRoot?: string) {
    this.globalPath = GLOBAL_SETTINGS_PATH;
    this.projectPath = getProjectMetadataPath(projectRoot || process.cwd(), 'settings.json');
    this.loadSettings();
  }

  private loadSettings(): void {
    const globalMigration = migrateLegacyClaudeFullscreenDefault(
      this.loadStoredSettings(this.globalPath, 'global'),
    );
    this.globalSettings = globalMigration.settings;
    if (globalMigration.migrated) {
      try {
        this.saveGlobalSettings();
      } catch {
        // Saving already logged the error. Keep the safe in-memory value and
        // retry migration from the unchanged file on the next manager load.
      }
    }

    const projectMigration = migrateLegacyClaudeFullscreenDefault(
      this.loadStoredSettings(this.projectPath, 'project'),
    );
    this.projectSettings = projectMigration.settings;
    if (projectMigration.migrated) {
      try {
        this.saveProjectSettings();
      } catch {
        // See the global migration path above.
      }
    }
  }

  private loadStoredSettings(path: string, scope: SettingsScope): StoredAumxSettings {
    if (!existsSync(path)) return {};

    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      const settings = parseStoredAumxSettings(parsed);
      SettingsManager.lastKnownGoodByPath.set(path, settings);
      this.invalidSettingsScopes.delete(scope);
      return settings;
    } catch (error) {
      LogService.getInstance().error(`Failed to load ${scope} settings`, 'settingsManager', undefined, error);
      const lastKnownGood = SettingsManager.lastKnownGoodByPath.get(path);
      if (lastKnownGood) return { ...lastKnownGood };
      this.invalidSettingsScopes.add(scope);
      return {};
    }
  }

  /**
   * Get merged settings (project settings override global)
   */
  getSettings(): AumxSettings {
    const settings = {
      ...DEFAULT_SETTINGS,
      ...getPublicSettings(this.globalSettings),
      ...getPublicSettings(this.projectSettings),
    };
    const hasPersistedPermissionMode = Object.hasOwn(this.globalSettings, 'permissionMode')
      || Object.hasOwn(this.projectSettings, 'permissionMode');

    return {
      ...settings,
      claudeFullscreenRendering: settings.claudeFullscreenRendering !== false,
      opencodeScrollbackMode: settings.opencodeScrollbackMode === true,
      permissionMode: this.invalidSettingsScopes.size > 0 && !hasPersistedPermissionMode
        ? ''
        : normalizePermissionMode(settings.permissionMode),
    };
  }

  /**
   * Get a specific setting value (with project override)
   */
  getSetting<K extends keyof AumxSettings>(key: K): AumxSettings[K] {
    const merged = this.getSettings();
    return merged[key];
  }

  /**
   * Get global settings only
   */
  getGlobalSettings(): AumxSettings {
    return getPublicSettings(this.globalSettings);
  }

  /**
   * Get project settings only
   */
  getProjectSettings(): AumxSettings {
    return getPublicSettings(this.projectSettings);
  }

  /**
   * Update a setting at the specified scope
   */
  updateSetting<K extends keyof AumxSettings>(
    key: K,
    value: AumxSettings[K],
    scope: SettingsScope
  ): void {
    if (!isSettingKey(String(key)) || !validateSettingValue(String(key), value)) {
      throw new Error(`Invalid ${String(key)}`);
    }
    // Validate branch-related settings
    if ((key === 'baseBranch' || key === 'branchPrefix') && typeof value === 'string' && value !== '') {
      if (!isValidBranchName(value)) {
        throw new Error(`Invalid ${key}: contains characters not allowed in git branch names`);
      }
    }
    if (key === 'permissionMode' && typeof value === 'string' && !isPermissionMode(value)) {
      throw new Error(`Invalid permissionMode: "${value}"`);
    }
    if (key === 'claudeFullscreenRendering' && typeof value !== 'boolean') {
      throw new Error('Invalid claudeFullscreenRendering: expected a boolean');
    }
    if (key === 'opencodeScrollbackMode' && typeof value !== 'boolean') {
      throw new Error('Invalid opencodeScrollbackMode: expected a boolean');
    }

    if (scope === 'global') {
      this.globalSettings[key] = value;
      if (key === 'claudeFullscreenRendering') {
        this.globalSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveGlobalSettings();
      SettingsManager.cache.clear();
    } else {
      this.projectSettings[key] = value;
      if (key === 'claudeFullscreenRendering') {
        this.projectSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveProjectSettings();
      SettingsManager.cache.clear();
    }
  }

  updateSettings(settings: Partial<AumxSettings>, scope: SettingsScope): void {
    validateSettingsPatch(settings as Record<string, unknown>);
    if (typeof settings.permissionMode === 'string' && !isPermissionMode(settings.permissionMode)) {
      throw new Error(`Invalid permissionMode: "${settings.permissionMode}"`);
    }
    if (typeof settings.baseBranch === 'string' && settings.baseBranch !== '' && !isValidBranchName(settings.baseBranch)) {
      throw new Error('Invalid baseBranch: contains characters not allowed in git branch names');
    }
    if (typeof settings.branchPrefix === 'string' && settings.branchPrefix !== '' && !isValidBranchName(settings.branchPrefix)) {
      throw new Error('Invalid branchPrefix: contains characters not allowed in git branch names');
    }
    if (settings.claudeFullscreenRendering !== undefined && typeof settings.claudeFullscreenRendering !== 'boolean') {
      throw new Error('Invalid claudeFullscreenRendering: expected a boolean');
    }
    if (settings.opencodeScrollbackMode !== undefined && typeof settings.opencodeScrollbackMode !== 'boolean') {
      throw new Error('Invalid opencodeScrollbackMode: expected a boolean');
    }

    if (scope === 'global') {
      this.globalSettings = { ...this.globalSettings, ...settings };
      if (typeof settings.claudeFullscreenRendering === 'boolean') {
        this.globalSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveGlobalSettings();
      SettingsManager.cache.clear();
    } else {
      this.projectSettings = { ...this.projectSettings, ...settings };
      if (typeof settings.claudeFullscreenRendering === 'boolean') {
        this.projectSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveProjectSettings();
      SettingsManager.cache.clear();
    }
  }

  /**
   * Remove a setting from the specified scope
   */
  removeSetting(key: keyof AumxSettings, scope: SettingsScope): void {
    if (scope === 'global') {
      delete this.globalSettings[key];
      if (key === 'claudeFullscreenRendering') {
        this.globalSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveGlobalSettings();
    } else {
      delete this.projectSettings[key];
      if (key === 'claudeFullscreenRendering') {
        this.projectSettings[CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY] = CLAUDE_FULLSCREEN_DEFAULT_RESET_VERSION;
      }
      this.saveProjectSettings();
    }
    SettingsManager.cache.clear();
  }

  private saveGlobalSettings(): void {
    try {
      const dir = dirname(this.globalPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      atomicWriteJsonSync(this.globalPath, this.globalSettings);
      SettingsManager.lastKnownGoodByPath.set(this.globalPath, { ...this.globalSettings });
      this.invalidSettingsScopes.delete('global');
    } catch (error) {
      LogService.getInstance().error('Failed to save global settings', 'settingsManager', undefined, error);
      throw error;
    }
  }

  private saveProjectSettings(): void {
    try {
      const dir = dirname(this.projectPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      atomicWriteJsonSync(this.projectPath, this.projectSettings);
      SettingsManager.lastKnownGoodByPath.set(this.projectPath, { ...this.projectSettings });
      this.invalidSettingsScopes.delete('project');
    } catch (error) {
      LogService.getInstance().error('Failed to save project settings', 'settingsManager', undefined, error);
      throw error;
    }
  }

  /**
   * Check if a setting is overridden at the project level
   */
  isProjectOverride(key: keyof AumxSettings): boolean {
    return key in this.projectSettings;
  }

  /**
   * Get the effective scope for a setting (where it's currently defined)
   */
  getEffectiveScope(key: keyof AumxSettings): SettingsScope | null {
    if (key in this.projectSettings) return 'project';
    if (key in this.globalSettings) return 'global';
    return null;
  }
}
