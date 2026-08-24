#!/usr/bin/env node
/**
 * Generate AGENTS.md documentation from TypeScript types
 *
 * This script extracts hook types, environment variables, and generates
 * comprehensive documentation that gets embedded in the aumx binary.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Read the hooks.ts file to extract types
const hooksFile = join(projectRoot, 'src/utils/hooks.ts');
const hooksContent = readFileSync(hooksFile, 'utf-8');

// Extract hook types
const hookTypesMatch = hooksContent.match(/export type HookType =\s*\|([\s\S]*?);/);
const hookTypes = hookTypesMatch
  ? hookTypesMatch[1]
      .split('|')
      .map(t => t.trim().replace(/['"]/g, ''))
      .filter(Boolean)
  : [];

console.log(`Found ${hookTypes.length} hook types`);

// Generate AGENTS.md content
const agentsMd = `# aumx Hooks System - Agent Reference

**Auto-generated documentation for AI agents**

This document contains everything an AI agent needs to create, modify, and understand aumx hooks. It is automatically generated from the aumx source code and embedded in the binary.

## What You're Working On

You are editing hooks for **aumx**, a tmux pane manager that creates AI-powered development workflows. Each pane runs in its own git worktree with an AI agent (Claude Code or opencode).

## Your Goal

Create executable bash scripts in \`.amux-hooks/\` that run automatically at key lifecycle events.

## Quick Start

1. **Create a hook file**: \`touch .amux-hooks/worktree_created\`
2. **Make it executable**: \`chmod +x .amux-hooks/worktree_created\`
3. **Add shebang**: Start with \`#!/bin/bash\`
4. **Use environment variables**: Access \`$AUMX_ROOT\`, \`$AUMX_WORKTREE_PATH\`, etc.
5. **Test it**: Set env vars manually and run the script

## Hook Execution Model

- **Non-blocking**: Hooks run in background (detached processes)
- **Silent failures**: Hook errors are logged but don't stop aumx
- **Environment-based**: All context passed via environment variables
- **Project-local**: Hooks in \`.amux-hooks/\` are gitignored by default and should not be committed
- **Priority resolution**: \`.amux-hooks/\` → \`.amux/hooks/\` → \`~/.aumx/hooks/\`

## Available Hooks

${generateHooksTable()}

## Environment Variables

### Always Available
\`\`\`bash
AUMX_ROOT="/path/to/project"           # Project root directory
AUMX_METADATA_DIR="/path/to/project/.amux" # Active project metadata directory (.amux or legacy .aumx)
AUMX_HOOKS_DIR="/path/to/project/.amux-hooks" # Active project hooks directory
\`\`\`

### Pane Context (most hooks)
\`\`\`bash
AUMX_PANE_ID="aumx-1234567890"         # aumx pane identifier
AUMX_SLUG="fix-auth-bug"               # Branch/worktree name
AUMX_PROMPT="Fix authentication bug"   # User's prompt
AUMX_AGENT="claude"                    # Agent type (claude|opencode)
AUMX_TMUX_PANE_ID="%38"                # tmux pane ID
\`\`\`

\`AUMX_PROMPT\` contains user-provided task text. Treat it as sensitive local context and do not send it to third-party services from hooks unless that is intentional.

### Worktree Context
\`\`\`bash
AUMX_WORKTREE_PATH="/path/.amux/worktrees/fix-auth-bug"
AUMX_BRANCH="fix-auth-bug"             # Same as slug
\`\`\`

### Merge Context
\`\`\`bash
AUMX_TARGET_BRANCH="main"              # Branch being merged into
\`\`\`

## Common Patterns

### Pattern 1: Install Dependencies
\`\`\`bash
#!/bin/bash
# .amux-hooks/worktree_created

cd "$AUMX_WORKTREE_PATH"

if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --prefer-offline &
elif [ -f "package-lock.json" ]; then
  npm install &
elif [ -f "yarn.lock" ]; then
  yarn install &
elif [ -f "Gemfile" ]; then
  bundle install &
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt &
elif [ -f "Cargo.toml" ]; then
  cargo build &
fi
\`\`\`

### Pattern 2: Copy Configuration
\`\`\`bash
#!/bin/bash
# .amux-hooks/worktree_created

# Copy environment file
if [ -f "$AUMX_ROOT/.env.local" ]; then
  cp "$AUMX_ROOT/.env.local" "$AUMX_WORKTREE_PATH/.env.local"
fi

# Copy other config files
for file in .env.development .npmrc .yarnrc; do
  if [ -f "$AUMX_ROOT/$file" ]; then
    cp "$AUMX_ROOT/$file" "$AUMX_WORKTREE_PATH/$file"
  fi
done
\`\`\`

### Pattern 3: Run Tests
\`\`\`bash
#!/bin/bash
# .amux-hooks/run_test

set -e
cd "$AUMX_WORKTREE_PATH"

if pnpm test; then
  echo "[Hook] Tests passed"
else
  echo "[Hook] Tests failed" >&2
  exit 1
fi
\`\`\`

### Pattern 4: Dev Server
\`\`\`bash
#!/bin/bash
# .amux-hooks/run_dev

set -e
cd "$AUMX_WORKTREE_PATH"

LOG_FILE="/tmp/aumx-dev-$AUMX_PANE_ID.log"
pnpm dev > "$LOG_FILE" 2>&1 &
DEV_PID=$!

sleep 5
PORT=$(grep -oP 'localhost:\\K\\d+' "$LOG_FILE" | head -1)
[ -z "$PORT" ] && PORT=3000

echo "[Hook] Dev server running at http://localhost:$PORT (PID: $DEV_PID)"
\`\`\`

### Pattern 5: Post-Merge Deployment
\`\`\`bash
#!/bin/bash
# .amux-hooks/post_merge

set -e
cd "$AUMX_ROOT"

# Only deploy from main/master
if [ "$AUMX_TARGET_BRANCH" != "main" ] && [ "$AUMX_TARGET_BRANCH" != "master" ]; then
  exit 0
fi

# Push to remote
git push origin "$AUMX_TARGET_BRANCH"

# Trigger deployment (example: Vercel)
if [ -n "$VERCEL_TOKEN" ]; then
  curl -s -X POST "https://api.vercel.com/v1/deployments" \\
    -H "Authorization: Bearer $VERCEL_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"name": "my-project"}' > /dev/null
fi

# Close GitHub issue if prompt contains #123
ISSUE=$(echo "$AUMX_PROMPT" | grep -oP '#\\K\\d+' | head -1)
if [ -n "$ISSUE" ] && command -v gh &> /dev/null; then
  gh issue close "$ISSUE" \\
    -c "Resolved in $AUMX_SLUG, merged to $AUMX_TARGET_BRANCH" \\
    2>/dev/null || true
fi
\`\`\`

## Best Practices

1. **Always start with shebang**: \`#!/bin/bash\`
2. **Set error handling**: \`set -e\` (exit on error)
3. **Make executable**: \`chmod +x .amux-hooks/hook_name\`
4. **Background long operations**: Append \`&\` to avoid blocking
5. **Check for required tools**: \`command -v tool &> /dev/null\`
6. **Log for debugging**: \`echo "[Hook] message" >> "$AUMX_METADATA_DIR/hooks.log"\`
7. **Handle missing vars gracefully**: \`[ -z "$VAR" ] && exit 0\`
8. **Use silent curl**: \`curl -s\` to avoid noise in logs
9. **Clean up temp files**: Remove files in \`/tmp/\`
10. **Test before committing**: Run hooks manually with mock env vars

## Testing Hooks

### Manual Testing
\`\`\`bash
# 1. Set environment variables
export AUMX_ROOT="$(pwd)"
export AUMX_PANE_ID="test-pane"
export AUMX_SLUG="test-branch"
export AUMX_WORKTREE_PATH="$(pwd)"
export AUMX_AGENT="claude"
export AUMX_PROMPT="Test prompt"

# 2. Run hook directly
./.amux-hooks/worktree_created

# 3. Check exit code
echo $?  # Should be 0 for success
\`\`\`

### Syntax Check
\`\`\`bash
# Check for syntax errors without running
bash -n ./.amux-hooks/worktree_created
\`\`\`

### Shellcheck (if available)
\`\`\`bash
shellcheck ./.amux-hooks/worktree_created
\`\`\`

## Project Context Analysis

Before creating hooks, analyze these files in the project:

### Package Manager Detection
\`\`\`bash
# Check which package manager is used
if [ -f "pnpm-lock.yaml" ]; then
  # Use: pnpm install, pnpm test, pnpm dev
elif [ -f "package-lock.json" ]; then
  # Use: npm install, npm test, npm run dev
elif [ -f "yarn.lock" ]; then
  # Use: yarn install, yarn test, yarn dev
fi
\`\`\`

### Test Command Discovery
\`\`\`bash
# Read package.json to find test command
cat package.json | grep '"test"'
# Or with jq:
jq -r '.scripts.test' package.json
\`\`\`

### Dev Command Discovery
\`\`\`bash
# Read package.json to find dev command
cat package.json | grep '"dev"'
# Or with jq:
jq -r '.scripts.dev' package.json
\`\`\`

### Environment Variables
\`\`\`bash
# Check for .env files to copy
ls -la | grep '\\.env'
\`\`\`

### Build System
\`\`\`bash
# Detect build system
if [ -f "vite.config.ts" ]; then
  # Vite project
elif [ -f "next.config.js" ]; then
  # Next.js project
elif [ -f "nuxt.config.ts" ]; then
  # Nuxt project
fi
\`\`\`

## Common Mistakes to Avoid

❌ **Blocking operations**: \`sleep 60\` (blocks aumx)
✅ **Background long tasks**: \`slow_operation &\`

❌ **Hardcoded paths**: \`/Users/me/project\`
✅ **Use variables**: \`"$AUMX_ROOT"\`

❌ **Assuming tools exist**: \`pnpm install\`
✅ **Check first**: \`command -v pnpm && pnpm install\`

❌ **No error handling**: Script fails silently
✅ **Set error mode**: \`set -e\` or check exit codes

❌ **Forgetting executable bit**: Hook won't run
✅ **Make executable**: \`chmod +x\`

❌ **Noisy output**: Clutters aumx logs
✅ **Silent operations**: \`curl -s\`, \`> /dev/null 2>&1\`

❌ **Not testing**: Deploy and hope
✅ **Test manually**: Run with mock env vars first

## Debugging

If a hook isn't working:

1. **Check if file exists**: \`ls -la .amux-hooks/\`
2. **Check permissions**: Should show \`x\` in \`rwxr-xr-x\`
3. **Check syntax**: \`bash -n .amux-hooks/hook_name\`
4. **Test manually**: Set env vars and run
5. **Check logs**: aumx logs to stderr with \`[Hooks]\` prefix
6. **Simplify**: Remove complex parts, test basic version
7. **Check tool availability**: \`command -v required_tool\`

### Debug Mode
\`\`\`bash
#!/bin/bash
# Add to top of hook for debugging
set -x  # Print each command before executing
set -e  # Exit on error

# Your hook logic here
\`\`\`

## Summary Checklist

When creating a new hook:

- [ ] Create file in \`.amux-hooks/\`
- [ ] Add shebang: \`#!/bin/bash\`
- [ ] Make executable: \`chmod +x\`
- [ ] Add \`set -e\` for error handling
- [ ] Use environment variables (never hardcode paths)
- [ ] Background long operations with \`&\`
- [ ] Check for required tools before using
- [ ] Test manually with mock env vars
- [ ] Add comments explaining what it does
- [ ] Commit to version control

## Getting Help

- **Full documentation**: See \`HOOKS.md\` in project root
- **Claude-specific tips**: See \`CLAUDE.md\` in \`.amux-hooks/\`
- **Examples**: Check \`.amux-hooks/examples/\` directory
- **aumx API**: See \`API.md\` for REST endpoints

---

*This documentation was auto-generated from aumx source code.*
*Version: ${new Date().toISOString().split('T')[0]}*
`;

// Write the generated markdown
const outputPath = join(projectRoot, 'src/utils/generated-agents-doc.ts');
const tsContent = `/**
 * Auto-generated AGENTS.md content
 * DO NOT EDIT MANUALLY - run 'pnpm generate:hooks-docs' to regenerate
 */

export const AGENTS_MD = \`${agentsMd.replace(/`/g, '\\`')}\`;
`;

writeFileSync(outputPath, tsContent);

console.log('Generated AGENTS.md content');
console.log(`Written to: ${outputPath}`);
console.log(`${agentsMd.length} characters`);

function generateHooksTable() {
  const hookDescriptions = {
    before_pane_create: ['Before pane creation', 'Validation, notifications, pre-flight checks'],
    pane_created: ['After pane, before worktree', 'Configure tmux settings, prepare environment'],
    pane_reopened: ['After preserved worktree reopened', 'Reattach tools, refresh IDE state, notify integrations'],
    worktree_created: ['After full setup', 'Install deps, copy configs, setup git'],
    before_pane_close: ['Before closing', 'Save state, backup uncommitted work'],
    pane_closed: ['After closed', 'Cleanup resources, analytics, notifications'],
    before_worktree_remove: ['Before worktree removal', 'Archive worktree, save artifacts'],
    worktree_removed: ['After worktree removed', 'Cleanup external references'],
    pre_merge: ['Before merge operation', 'Run final tests, create backups'],
    post_merge: ['After successful merge', 'Deploy, close issues, notify team'],
    run_test: ['When tests triggered', 'Run test suite, report status via HTTP'],
    run_dev: ['When dev server triggered', 'Start dev server, create tunnel, report URL'],
  };

  let table = '### Pane Lifecycle Hooks\n\n';
  table += '| Hook | When | Common Use Cases |\n';
  table += '|------|------|------------------|\n';

  const paneHooks = ['before_pane_create', 'pane_created', 'pane_reopened', 'worktree_created', 'before_pane_close', 'pane_closed'];
  paneHooks.forEach(hook => {
    const [when, use] = hookDescriptions[hook] || ['', ''];
    table += `| \`${hook}\` | ${when} | ${use} |\n`;
  });

  table += '\n### Worktree Lifecycle Hooks\n\n';
  table += '| Hook | When | Common Use Cases |\n';
  table += '|------|------|------------------|\n';

  const worktreeHooks = ['before_worktree_remove', 'worktree_removed'];
  worktreeHooks.forEach(hook => {
    const [when, use] = hookDescriptions[hook] || ['', ''];
    table += `| \`${hook}\` | ${when} | ${use} |\n`;
  });

  table += '\n### Merge Lifecycle Hooks\n\n';
  table += '| Hook | When | Common Use Cases |\n';
  table += '|------|------|------------------|\n';

  const mergeHooks = ['pre_merge', 'post_merge'];
  mergeHooks.forEach(hook => {
    const [when, use] = hookDescriptions[hook] || ['', ''];
    table += `| \`${hook}\` | ${when} | ${use} |\n`;
  });

  table += '\n### Interactive Hooks\n\n';
  table += '| Hook | When | Common Use Cases |\n';
  table += '|------|------|------------------|\n';

  const interactiveHooks = ['run_test', 'run_dev'];
  interactiveHooks.forEach(hook => {
    const [when, use] = hookDescriptions[hook] || ['', ''];
    table += `| \`${hook}\` | ${when} | ${use} |\n`;
  });

  return table;
}
