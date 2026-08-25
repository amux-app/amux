/**
 * Embedded Hooks Documentation
 *
 * This file contains all documentation that gets written to .muxbase-hooks/
 * when the directory is initialized. The AGENTS_MD content is auto-generated
 * and imported from generated-agents-doc.ts
 */

import { AGENTS_MD } from './generated-agents-doc.js';

/**
 * Main documentation - gets written as both AGENTS.md and CLAUDE.md
 * Different agents look for different filenames, but content is identical
 */
export const HOOKS_DOCUMENTATION = AGENTS_MD;

/**
 * README for the .muxbase-hooks/ directory
 */
export const HOOKS_README = `# muxbase Hooks

This directory contains local hooks that run automatically at key lifecycle events in muxbase.

## Quick Start

1. **Read the documentation**:
   - \`AGENTS.md\` - Complete reference (for any AI agent)
   - \`CLAUDE.md\` - Same content (Claude Code looks for this filename)

2. **Check examples**:
   - \`examples/\` directory contains starter templates

3. **Create a hook**:
   \`\`\`bash
   touch worktree_created
   chmod +x worktree_created
   nano worktree_created
   \`\`\`

4. **Test it**:
   \`\`\`bash
   export MUXBASE_ROOT="\$(pwd)"
   export MUXBASE_WORKTREE_PATH="\$(pwd)"
   ./worktree_created
   \`\`\`

## Available Hooks

- \`before_pane_create\` - Before pane creation
- \`pane_created\` - After pane created
- \`pane_reopened\` - After preserved worktree reopened in a pane
- \`worktree_created\` - After worktree setup
- \`before_pane_close\` - Before closing
- \`pane_closed\` - After closed
- \`before_worktree_remove\` - Before worktree removal
- \`worktree_removed\` - After worktree removed
- \`pre_merge\` - Before merge
- \`post_merge\` - After merge
- \`run_test\` - When running tests
- \`run_dev\` - When starting dev server

## Documentation

See \`AGENTS.md\` or \`CLAUDE.md\` for complete documentation including:
- Environment variables
- Common patterns
- Best practices
- Testing strategies

## Note

This directory is gitignored by default. Hooks are local executable code and are not meant to be committed.
`;

/**
 * Example: worktree_created hook
 */
const EXAMPLE_WORKTREE_CREATED = `#!/bin/bash
# Example: worktree_created hook
#
# This hook runs after a new worktree is created and the agent is launched.
# Use it to set up the worktree environment (install deps, copy configs, etc.)

set -e  # Exit on error

echo "[Hook] Setting up worktree: $MUXBASE_SLUG"

cd "$MUXBASE_WORKTREE_PATH"

# Install dependencies in background (don't block muxbase)
if [ -f "pnpm-lock.yaml" ]; then
  echo "[Hook] Installing dependencies with pnpm..."
  pnpm install --prefer-offline &
elif [ -f "package-lock.json" ]; then
  echo "[Hook] Installing dependencies with npm..."
  npm install &
elif [ -f "yarn.lock" ]; then
  echo "[Hook] Installing dependencies with yarn..."
  yarn install &
fi

# Copy environment file if it exists
if [ -f "$MUXBASE_ROOT/.env.local" ]; then
  echo "[Hook] Copying .env.local"
  cp "$MUXBASE_ROOT/.env.local" "$MUXBASE_WORKTREE_PATH/.env.local"
fi

# Set custom git config for this worktree
echo "[Hook] Configuring git"
git config user.name "muxbase-agent/$MUXBASE_SLUG"
git config user.email "agent@muxbase.local"

# Create a log entry
echo "[\$(date)] Created worktree: $MUXBASE_SLUG | Agent: $MUXBASE_AGENT | Prompt: $MUXBASE_PROMPT" \\
  >> "$MUXBASE_METADATA_DIR/worktree_history.log"

echo "[Hook] Worktree setup complete!"
`;

/**
 * Example: run_dev hook
 */
const EXAMPLE_RUN_DEV = `#!/bin/bash
# Example: run_dev hook
#
# This hook starts a dev server and optionally creates a tunnel for sharing.

set -e

echo "[Hook] Starting dev server for $MUXBASE_SLUG"

cd "$MUXBASE_WORKTREE_PATH"

# Start dev server in background
# Adjust the command for your project (pnpm dev, npm run dev, vite, etc.)
LOG_FILE="/tmp/muxbase-dev-$MUXBASE_PANE_ID.log"
pnpm dev > "$LOG_FILE" 2>&1 &
DEV_PID=$!

# Wait for server to be ready
echo "[Hook] Waiting for dev server to start..."
sleep 5

# Detect port from log output
# Adjust the grep pattern for your dev server's output format
PORT=\$(grep -oP '(?<=localhost:)\\d+' "$LOG_FILE" | head -1)

if [ -z "$PORT" ]; then
  echo "[Hook] Warning: Could not detect port from logs, using default 3000"
  PORT=3000
fi

LOCAL_URL="http://localhost:$PORT"
echo "[Hook] Dev server running at $LOCAL_URL"

# Optional: Create a public tunnel (uncomment to enable)
# Requires ngrok, cloudflared, or another tunneling tool

# Example with cloudflared:
# TUNNEL_URL=\$(cloudflared tunnel --url "$LOCAL_URL" 2>&1 | \\
#   grep -oP 'https://[a-z0-9-]+\\.trycloudflare\\.com' | head -1)

# Example with ngrok:
# TUNNEL_URL=\$(ngrok http $PORT --log=stdout 2>&1 | \\
#   grep -oP 'url=https://[^"]+' | head -1 | cut -d= -f2)

# For now, just use local URL (uncomment tunnel code above to enable)
FINAL_URL="$LOCAL_URL"

echo "[Hook] Dev server ready at: $FINAL_URL"
echo "[Hook] Dev server PID: $DEV_PID"
echo "[Hook] Log file: $LOG_FILE"
`;

/**
 * Example: run_test hook
 */
const EXAMPLE_RUN_TEST = `#!/bin/bash
# Example: run_test hook
#
set -e

echo "[Hook] Running tests for $MUXBASE_SLUG"

cd "$MUXBASE_WORKTREE_PATH"

echo "[Hook] Running test suite..."

# Capture test output
OUTPUT_FILE="/tmp/muxbase-test-$MUXBASE_PANE_ID.txt"

# Run tests (adjust command for your project)
# Examples:
#   - pnpm test
#   - npm test
#   - vitest run
#   - jest
#   - pytest
#   - cargo test
if pnpm test > "$OUTPUT_FILE" 2>&1; then
  echo "[Hook] Tests passed ✓"
else
  echo "[Hook] Tests failed ✗"
  rm -f "$OUTPUT_FILE"
  exit 1
fi

# Cleanup
rm -f "$OUTPUT_FILE"
echo "[Hook] Test run complete"
`;

/**
 * Example: post_merge hook
 */
const EXAMPLE_POST_MERGE = `#!/bin/bash
# Example: post_merge hook
#
# This hook runs after a successful merge into the target branch.
# Use it to trigger deployments, close issues, notify teams, etc.

set -e

echo "[Hook] Post-merge processing for $MUXBASE_SLUG → $MUXBASE_TARGET_BRANCH"

cd "$MUXBASE_ROOT"

# Push to remote if merging to main/master
if [ "$MUXBASE_TARGET_BRANCH" = "main" ] || [ "$MUXBASE_TARGET_BRANCH" = "master" ]; then
  echo "[Hook] Pushing to origin/$MUXBASE_TARGET_BRANCH"
  git push origin "$MUXBASE_TARGET_BRANCH"

  # Optional: Trigger deployment
  # if [ -n "$VERCEL_TOKEN" ]; then
  #   echo "[Hook] Triggering Vercel deployment..."
  #   curl -X POST "https://api.vercel.com/v1/deployments" \\
  #     -H "Authorization: Bearer $VERCEL_TOKEN" \\
  #     -H "Content-Type: application/json" \\
  #     -d '{
  #       "name": "my-project",
  #       "gitSource": {
  #         "type": "github",
  #         "ref": "main"
  #       }
  #     }'
  # fi
fi

# Close related GitHub issue (if prompt contains #123 format)
ISSUE_NUM=\$(echo "$MUXBASE_PROMPT" | grep -oP '#\\K\\d+' | head -1)
if [ -n "$ISSUE_NUM" ]; then
  echo "[Hook] Closing GitHub issue #$ISSUE_NUM"
  if command -v gh &> /dev/null; then
    gh issue close "$ISSUE_NUM" \\
      -c "Resolved in branch $MUXBASE_SLUG, merged to $MUXBASE_TARGET_BRANCH" \\
      2>/dev/null || echo "[Hook] Warning: Failed to close issue (maybe already closed?)"
  else
    echo "[Hook] GitHub CLI (gh) not found, skipping issue close"
  fi
fi

# Send notification to Slack
# if [ -n "$SLACK_WEBHOOK" ]; then
#   echo "[Hook] Sending Slack notification"
#   curl -s -X POST "$SLACK_WEBHOOK" \\
#     -H "Content-Type: application/json" \\
#     -d "{
#       \\"text\\": \\"Merged: $MUXBASE_SLUG → $MUXBASE_TARGET_BRANCH\\",
#       \\"blocks\\": [
#         {
#           \\"type\\": \\"section\\",
#           \\"text\\": {
#             \\"type\\": \\"mrkdwn\\",
#             \\"text\\": \\"*Branch Merged* :rocket:\\n\\n*From:* \\\`$MUXBASE_SLUG\\\`\\n*To:* \\\`$MUXBASE_TARGET_BRANCH\\\`\\n*Task:* $MUXBASE_PROMPT\\"
#           }
#         }
#       ]
#     }" > /dev/null
# fi

echo "[Hook] Post-merge processing complete"
`;

/**
 * All embedded examples for easy iteration
 */
export const EXAMPLE_HOOKS = {
  'worktree_created.example': EXAMPLE_WORKTREE_CREATED,
  'run_dev.example': EXAMPLE_RUN_DEV,
  'run_test.example': EXAMPLE_RUN_TEST,
  'post_merge.example': EXAMPLE_POST_MERGE,
};
