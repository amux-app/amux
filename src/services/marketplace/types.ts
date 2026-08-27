import type { AgentName } from '../../utils/agentLaunch.js';

export type MarketplaceFormat =
  | 'claude-marketplace'
  | 'codex-plugin'
  | 'opencode-skills'
  | 'opencode-plugins'
  | 'raw-skills'
  | 'mcp-servers';

export type InstallStatus = 'full' | 'partial' | 'not-installed';

export interface MarketplaceSource {
  url: string;
  name: string;
  clonePath: string;
  detectedFormat: MarketplaceFormat | null;
  headSha: string | null;
  lastUpdated: string | null;
  // Snapshot of item names seen the last time this source was checked, used to
  // detect newly added items on subsequent checks. Absent means never checked.
  lastSeenArtifacts?: SourceArtifactSnapshot;
}

// Keys of a plugin id → the items it exposed, per item type, each mapping an item
// name to a content hash. Grouping by plugin id keeps the diff stable when unrelated
// plugins in the same source change. A changed hash for a same-named item means the
// item was updated (not merely present). Legacy snapshots stored string[] (names only)
// and are migrated on the next check — see UpdateDiff.normalizeSnapshotEntry.
export interface SourceArtifactSnapshot {
  [pluginId: string]: {
    skills: Record<string, string>;
    mcpServers: Record<string, string>;
    agents: Record<string, string>;
    jsPlugins: Record<string, string>;
    hookEvents: Record<string, string>;
  };
}

export interface NewArtifact {
  type: 'skill' | 'mcpServer' | 'agent' | 'jsPlugin' | 'hook';
  name: string;
  description?: string;
  // 'new' = not present in the previous snapshot; 'updated' = present but content changed.
  changeType: 'new' | 'updated';
  // ISO timestamp of when the item changed. diffAgainstSnapshot stamps the detection
  // time; callers may overwrite it with the file's real commit date.
  changedAt: string;
}

export interface SourceUpdate {
  sourceUrl: string;
  sourceName: string;
  pluginId: string;
  pluginName: string;
  newArtifacts: NewArtifact[];
}

export interface InstalledPlugin {
  pluginId: string;
  sourceUrl: string;
  installedAt: string;
  agents: Partial<Record<AgentName, AgentInstallResult>>;
  selectedArtifacts?: {
    skills: string[];
    mcpServers: string[];
    agentNames: string[];
    // Hooks and JS plugins are installed as a unit — not individually selectable
    hookEvents: string[];
    jsPluginNames: string[];
    usedNativeRegistration: boolean;
  };
  /** Absent for installations created before ownership tracking. */
  ownershipManifest?: MarketplaceOwnershipManifest;
}

export interface MarketplaceOwnershipManifest {
  version: 1;
  transactionId: string;
  artifacts: MarketplaceOwnedArtifact[];
}

export type MarketplaceOwnedArtifact =
  | {
      type: 'file' | 'directory';
      agent: AgentName;
      path: string;
      installedDigest: string;
      /** Source-scoped artifacts are shared by sibling plugins from one marketplace. */
      scope?: 'plugin' | 'source';
    }
  | {
      type: 'config-entry';
      agent: AgentName;
      path: string;
      selector: string;
      installedDigest: string;
      /** Source-scoped entries are shared by sibling plugins from one marketplace. */
      scope?: 'plugin' | 'source';
    };

export interface MarketplaceRegistryData {
  version: 1;
  sources: MarketplaceSource[];
  installed: InstalledPlugin[];
}

export interface DetectedPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  skills: SkillEntry[];
  agents: AgentEntry[];
  hooks: HookEntry[];
  mcpServers: McpServerEntry[];
  jsPlugins: JsPluginEntry[];
}

export interface SkillEntry {
  name: string;
  path: string;
  description?: string;
}

export interface AgentEntry {
  name: string;
  path: string;
  description?: string;
}

export interface HookEntry {
  event: string;
  command?: string;
  jsPath?: string;
  matcher?: string;
  sourceFormat: 'claude' | 'codex' | 'opencode';
}

export interface McpServerEntry {
  name: string;
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args: string[];
  url?: string;
  env?: Record<string, string>;
  startupTimeoutSec?: number;
  description?: string;
}

export interface JsPluginEntry {
  name: string;
  path: string;
}

export interface AgentInstallResult {
  status: InstallStatus;
  skipped: string[];
}

export interface InstallResult {
  pluginId: string;
  agents: Partial<Record<AgentName, AgentInstallResult>>;
}

export interface MarketplacePreviewArtifact {
  name: string;
  sourcePaths: string[];
  destinationPaths: string[];
  contentHashes: string[];
  executable: boolean;
  detail?: string;
}

export interface MarketplacePreviewAgent {
  agent: AgentName;
  artifacts: MarketplacePreviewArtifact[];
}

export interface MarketplaceInstallPreview {
  pluginId: string;
  sourceUrl: string;
  sourceHeadSha: string;
  digest: string;
  mode: 'full' | 'selected';
  agents: MarketplacePreviewAgent[];
  environmentVariableNames: string[];
  generatedFiles: string[];
  introducesExecutableBehavior: boolean;
}

export interface TranslationResult {
  status: InstallStatus;
  path: string;
  skipped: string[];
}
