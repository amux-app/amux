import {
  BrainCircuit,
  FilePenLine,
  FilePlus2,
  FileText,
  FolderSearch,
  Search,
  Terminal,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface ToolVisual {
  icon: LucideIcon;
  color: string;
}

export const SUBAGENT_COLOR = '#d8b4fe';
const FALLBACK_COLOR = '#71717a';
const ERROR_COLOR = 'var(--error)';

const TOOL_VISUALS: Record<string, ToolVisual> = {
  Read: { icon: FileText, color: '#93c5fd' },
  Edit: { icon: FilePenLine, color: '#fcd34d' },
  Write: { icon: FilePlus2, color: '#86efac' },
  Bash: { icon: Terminal, color: '#fdba74' },
  Task: { icon: BrainCircuit, color: SUBAGENT_COLOR },
  Grep: { icon: Search, color: '#f9a8d4' },
  Glob: { icon: FolderSearch, color: '#67e8f9' },
};

export function getToolVisual(name: string): ToolVisual {
  return TOOL_VISUALS[name] ?? { icon: Zap, color: FALLBACK_COLOR };
}

export function getToolColor(name: string, isError?: boolean): string {
  if (isError) return ERROR_COLOR;
  return getToolVisual(name).color;
}
