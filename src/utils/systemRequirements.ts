import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parseTmuxVersion } from './tmuxVersion.js';

export interface TmuxRequirement {
  minimum: string;
  homebrewFormula: string;
  sourceUrl: string;
  sourceSha256: string;
}

export interface SystemRequirements {
  tmux: TmuxRequirement;
  git: { minimum: string };
}

const REQUIREMENTS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../config/system-requirements.json',
);

let cached: SystemRequirements | null = null;

function assertShape(value: SystemRequirements): SystemRequirements {
  const { tmux, git } = value;
  const validTmux = !!tmux
    && !!parseTmuxVersion(tmux.minimum)
    && typeof tmux.homebrewFormula === 'string'
    && typeof tmux.sourceUrl === 'string'
    && /^[0-9a-f]{64}$/.test(tmux.sourceSha256);
  const validGit = !!git && typeof git.minimum === 'string';
  if (!validTmux || !validGit) {
    throw new Error(`Malformed system requirements at ${REQUIREMENTS_PATH}`);
  }
  return value;
}

export function loadSystemRequirements(): SystemRequirements {
  if (cached) return cached;
  cached = assertShape(JSON.parse(readFileSync(REQUIREMENTS_PATH, 'utf8')) as SystemRequirements);
  return cached;
}
