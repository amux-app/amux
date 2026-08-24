#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rules are written so that this file never matches itself: an escaped `\.` in a pattern
// is not the literal `.` the pattern looks for, and every alternation is preceded by `:`.
const PUBLIC_RULES = [
  {
    label: 'internal-host',
    pattern: /(?:https?|ssh):\/\/[^\s/@]+(?:\.[^\s/:@]+)*(?:\.internal|\.corp)(?=[:/\s]|$)/i,
  },
  {
    // Self-hosted forge hostnames such as a GitHub Enterprise instance. Public forge hosts
    // are excluded structurally: they carry no label between the forge name and the TLD.
    label: 'enterprise-forge-host',
    pattern: /\b(?:bitbucket|gerrit|git|github|gitlab)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|corp|dev|internal|io|net|org)(?![a-z0-9-])/i,
  },
  {
    // Internal corporate domains, as a bare host or an e-mail domain. Extend the
    // alternation when another organisation namespace must stay out of the public tree.
    label: 'corporate-domain',
    pattern: /(?:\b[a-z0-9-]+\.|@)(?:[a-z0-9-]+\.)*(?:sap)(?![a-z0-9-])/i,
  },
  {
    label: 'credential-assignment',
    pattern: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i,
  },
];
const EXCLUDED_DIRECTORIES = new Set([
  '.amux',
  '.amux-hooks',
  '.aumx',
  '.aumx-hooks',
  '.claude',
  '.codex',
  '.git',
  '.idea',
  '.log',
  '.tmp',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);
// A NUL byte never belongs in these formats. Treating one as "binary" would let
// a single stray NUL hide every other match in the file, so the gate fails instead.
const SOURCE_LIKE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const BINARY_SNIFF_BYTES = 8_192;
const MAX_PRIVATE_PATTERNS = 256;
const MAX_PRIVATE_PATTERN_LENGTH = 512;
const DEFAULT_PRIVATE_PATTERN_FILE = '.internal-refs-patterns.json';
const SCRIPT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function parseRootArgument(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1) return SCRIPT_ROOT;
  const value = argv[rootIndex + 1];
  if (!value) throw new Error('--root requires a directory');
  return resolve(value);
}

function parsePrivatePatterns(rootDir) {
  const inlineValue = process.env.AUMX_PRIVATE_REF_PATTERNS?.trim();
  const configuredFile = process.env.AUMX_PRIVATE_REF_PATTERNS_FILE?.trim();
  const defaultFile = resolve(rootDir, DEFAULT_PRIVATE_PATTERN_FILE);
  const filePath = configuredFile
    ? (isAbsolute(configuredFile) ? configuredFile : resolve(rootDir, configuredFile))
    : existsSync(defaultFile) ? defaultFile : null;

  if (inlineValue && filePath) {
    throw new Error('Configure private reference patterns with either the environment or a file, not both');
  }

  const serialized = inlineValue || (filePath ? readFileSync(filePath, 'utf8') : '');
  if (!serialized) return [];

  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Private reference patterns must be a JSON array of strings');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRIVATE_PATTERNS) {
    throw new Error(`Private reference patterns must contain 1-${MAX_PRIVATE_PATTERNS} entries`);
  }

  const patterns = value.map((entry) => {
    if (
      typeof entry !== 'string'
      || entry.length < 3
      || entry.length > MAX_PRIVATE_PATTERN_LENGTH
      || /[\0\r\n]/.test(entry)
    ) {
      throw new Error('Each private reference pattern must be a 3-512 character single-line string');
    }
    return entry;
  });
  return [...new Set(patterns)];
}

function listCandidateFiles(rootDir) {
  const gitResult = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (gitResult.status === 0) {
    return gitResult.stdout.split('\0').filter(Boolean);
  }

  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(rootDir, path));
    }
  };
  walk(rootDir);
  return files;
}

function isExcluded(relativePath) {
  return relativePath.split(/[\\/]/).some((part) => EXCLUDED_DIRECTORIES.has(part));
}

function readCandidateFile(path, relativePath) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  if (SOURCE_LIKE_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    return { content: buffer.toString('utf8'), hasNul: buffer.includes(0) };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { content: null, hasNul: false };
  return { content: buffer.toString('utf8'), hasNul: false };
}

function findLineNumber(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function scanFile(relativePath, content, privatePatterns) {
  const findings = [];
  for (const rule of PUBLIC_RULES) {
    const match = rule.pattern.exec(content);
    if (match?.index !== undefined) {
      findings.push({ label: rule.label, line: findLineNumber(content, match.index), path: relativePath });
    }
  }
  for (const pattern of privatePatterns) {
    const index = content.indexOf(pattern);
    if (index !== -1) {
      findings.push({ label: 'private-rule', line: findLineNumber(content, index), path: relativePath });
    }
  }
  return findings;
}

const AUTHOR_FIELDS = ['author-name', 'author-email', 'committer-name', 'committer-email'];

function scanAuthors(rootDir, privatePatterns) {
  const gitResult = spawnSync(
    'git',
    ['log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce'],
    { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (gitResult.status !== 0) return [];

  const findings = [];
  const seen = new Set();

  for (const record of gitResult.stdout.split('\n').filter(Boolean)) {
    const [hash, ...values] = record.split('\0');
    for (let i = 0; i < AUTHOR_FIELDS.length; i++) {
      const value = values[i] ?? '';
      const field = AUTHOR_FIELDS[i];
      const path = `<git-commit ${hash.slice(0, 7)} ${field}>`;
      for (const rule of PUBLIC_RULES) {
        const key = `${hash}:${field}:${rule.label}`;
        if (rule.pattern.test(value) && !seen.has(key)) {
          seen.add(key);
          findings.push({ label: rule.label, line: 0, path });
        }
      }
      for (const pattern of privatePatterns) {
        const key = `${hash}:${field}:private:${pattern}`;
        if (value.includes(pattern) && !seen.has(key)) {
          seen.add(key);
          findings.push({ label: 'private-rule', line: 0, path });
        }
      }
    }
  }
  return findings;
}

function collectFindings(rootDir, privatePatterns) {
  const findings = [];
  const nulFiles = [];
  for (const relativePath of listCandidateFiles(rootDir)) {
    if (isExcluded(relativePath)) continue;
    const candidate = readCandidateFile(resolve(rootDir, relativePath), relativePath);
    if (candidate === null) continue;
    const { content, hasNul } = candidate;
    if (content === null) continue;
    if (hasNul) nulFiles.push(relativePath);
    findings.push(...scanFile(relativePath, content, privatePatterns));
  }
  return { findings, nulFiles };
}

function reportNulFiles(nulFiles) {
  console.error('Internal-refs gate FAILED: raw NUL byte in source file. A NUL byte is never valid source and hides every other match in the file:');
  for (const path of nulFiles) {
    console.error(`  ${path} [raw-nul-in-source]`);
  }
  console.error('Remove the NUL byte before merging.');
}

function reportFindings(findings) {
  console.error('Internal-refs gate FAILED. Matches are redacted:');
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line} [${finding.label}]`);
  }
  console.error('Remove the references before merging.');
}

function main() {
  let rootDir;
  let privatePatterns;
  try {
    rootDir = parseRootArgument(process.argv.slice(2));
    privatePatterns = parsePrivatePatterns(rootDir);
  } catch (error) {
    console.error(`Internal-refs gate configuration error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (process.env.AUMX_REQUIRE_PRIVATE_REFS === '1' && privatePatterns.length === 0) {
    console.error('Internal-refs gate configuration error: private patterns are required for this job');
    return 2;
  }

  const { findings, nulFiles } = collectFindings(rootDir, privatePatterns);
  findings.push(...scanAuthors(rootDir, privatePatterns));

  if (nulFiles.length > 0) reportNulFiles(nulFiles);
  if (findings.length > 0) reportFindings(findings);
  if (nulFiles.length > 0 || findings.length > 0) return 1;

  const privateStatus = privatePatterns.length > 0 ? 'public and private rules' : 'public rules';
  console.log(`Internal-refs gate: clean (${privateStatus})`);
  return 0;
}

process.exitCode = main();
