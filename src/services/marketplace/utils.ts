import { existsSync, readFileSync } from 'fs';
import path from 'path';

export function loadJson(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Resolve `value` relative to `root` and verify it stays within `root`.
// Returns the resolved absolute path or null if the value is unsafe.
export function safeResolveUnder(root: string, value: string): string | null {
  const resolved = path.resolve(root, value);
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

// Sanitise a name that will be used as a filesystem path component or config key.
// Rejects empty, absolute paths, path separators, traversal sequences, and leading dots.
export function safeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes(path.sep)) return null;
  if (trimmed.startsWith('.')) return null;
  if (trimmed.includes('..')) return null;
  // Reject characters that are unsafe in TOML keys, JSON keys, or shell args
  if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}
