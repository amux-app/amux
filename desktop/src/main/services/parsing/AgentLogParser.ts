import type { NormalizedSession, AgentType } from '../../../shared/agent-session-types.js';
import type { AumxPane } from 'aumx/core';
import { ClaudeLogParser } from './ClaudeLogParser.js';
import { CodexLogParser } from './CodexLogParser.js';
import { OpencodeLogParser } from './OpencodeLogParser.js';
import { PiLogParser } from './PiLogParser.js';

export interface AgentLogParser {
  readonly agent: AgentType;
  /**
   * True when one session file holds exactly one agent session, so a write to the
   * bound file proves the pane's session is still the live one and no replacement
   * can have taken its place. False for a store several sessions share — an
   * OpenCode project database changes whenever any session in the project does,
   * which says nothing about the session this pane is bound to.
   */
  readonly boundFileIsExclusive: boolean;
  findSessionFile(
    pane: AumxPane,
    projectRoot: string,
    excludePaths?: Set<string>,
    mode?: SessionDiscoveryMode,
  ): Promise<string | null>;
  /** Returns the directory where session files for this pane are expected, whether or not it exists yet. */
  getSessionDirectory(pane: AumxPane, projectRoot: string): string | null;
  /**
   * Pre-binding only, for parsers with no watchable session directory: a directory
   * whose writes mean discovery is worth re-running. Null until it can be resolved.
   */
  getDiscoveryWatchDirectory?(pane: AumxPane, projectRoot: string): string | null;
  /** Which filenames in that directory matter. Required alongside getDiscoveryWatchDirectory. */
  isDiscoveryFileName?(fileName: string): boolean;
  /**
   * Files whose changes can alter the bound session. Shared stores may include
   * sidecars such as SQLite's write-ahead log.
   */
  getSessionWatchPaths?(filePath: string): readonly string[];
  parseSession(filePath: string): Promise<NormalizedSession>;
}

export type SessionDiscoveryMode = 'initial' | 'replacement';

export function createParser(agent: AgentType): AgentLogParser {
  switch (agent) {
    case 'claude':
      return new ClaudeLogParser();
    case 'codex':
      return new CodexLogParser();
    case 'opencode':
      return new OpencodeLogParser();
    case 'pi':
      return new PiLogParser();
    default:
      throw new Error(`No parser available for agent: ${agent}`);
  }
}
