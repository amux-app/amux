DESKTOP_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))desktop
SCRIPTS_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))scripts
E2E_HEADED ?= 0

export NODE_OPTIONS := --import $(abspath $(SCRIPTS_DIR)/node24-crypto-fix.mjs) $(NODE_OPTIONS)

.PHONY: install install-deps build dev dev-worktree run start test unit-test run-test test-e2e test-e2e-stable test-e2e-live test-e2e-kanban test-e2e-pane test-e2e-multi-agent test-e2e-live-agent-terminal test-e2e-multi-agent-slow test-e2e-conflict test-e2e-conflict-slow typecheck clean help all core-build pack dist open release release-verify doctor bootstrap lint internal-refs-gate demo-record demo-assets demo

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install MuxBase.app from source (macOS only)
	@node $(SCRIPTS_DIR)/ensure-tmux.mjs --provision
	node scripts/install-local-app.mjs

install-deps: ## Install workspace dependencies (prefer 'make bootstrap' on a fresh clone)
	pnpm install

doctor: ## Verify the managed Node/pnpm toolchain, tmux, and git
	@command -v pnpm >/dev/null 2>&1 && echo "ok pnpm $$(pnpm -v)" || { echo 'pnpm missing - run: corepack enable && corepack prepare pnpm@11.22.0 --activate'; exit 1; }
	@pnpm exec node $(SCRIPTS_DIR)/check-managed-toolchain.mjs
	@node $(SCRIPTS_DIR)/ensure-tmux.mjs --check
	@command -v git  >/dev/null 2>&1 && echo "ok git $$(git --version | awk '{print $$3}')" || { echo 'git missing'; exit 1; }
	@echo 'ok all prerequisites satisfied'

bootstrap: ## Bootstrap a fresh clone: provision prerequisites + pnpm install + build core
	@command -v corepack >/dev/null 2>&1 && corepack enable && corepack prepare pnpm@11.22.0 --activate || echo 'corepack unavailable, assuming pnpm is on PATH'
	@node $(SCRIPTS_DIR)/ensure-tmux.mjs --provision
	pnpm install
	@$(MAKE) doctor
	$(MAKE) core-build
	@echo 'ok ready - try: make dev'

build: ## Build the Electron app (main + preload + renderer)
	cd $(DESKTOP_DIR) && pnpm exec electron-vite build

dev: core-build ## Start in development mode with hot reload
	cd $(DESKTOP_DIR) && pnpm exec electron-vite dev

dev-worktree: core-build ## Run dev from a worktree on its own port + user-data dir (defaults to 5374; override MUXBASE_RENDERER_PORT for multiple worktrees)
	@case "$$(pwd)" in *.muxbase/worktrees/*) ;; *) echo "✗ dev-worktree must run from inside .muxbase/worktrees/<name>"; exit 1 ;; esac
	@WT_ROOT=$$(pwd); \
	 PORT="$${MUXBASE_RENDERER_PORT:-5374}"; \
	 USER_DATA="$$WT_ROOT/.muxbase-dev/userdata"; \
	 mkdir -p "$$USER_DATA"; \
	 echo "→ worktree=$$(basename $$WT_ROOT) port=$$PORT userdata=$$USER_DATA"; \
	 cd $(DESKTOP_DIR) && MUXBASE_RENDERER_PORT="$$PORT" MUXBASE_USER_DATA_DIR="$$USER_DATA" pnpm exec electron-vite dev

core-build: ## Build muxbase core (required for muxbase/core ESM exports)
	pnpm -w --filter muxbase build

run: core-build ## Start with hot reload (HMR for renderer, auto-restart for main)
	cd $(DESKTOP_DIR) && pnpm exec electron-vite dev

start: ## Quick start — just launch (skip build, assumes already built)
	cd $(DESKTOP_DIR) && pnpm exec electron .

test: ## Run unit and integration tests (desktop only)
	cd $(DESKTOP_DIR) && pnpm exec vitest run --config vitest.config.ts

unit-test: ## Run all unit tests (root + desktop, excludes E2E)
	pnpm exec vitest run --exclude '**/e2e/**'

run-test: ## Run tests in interactive watch mode (non-headless)
	cd $(DESKTOP_DIR) && pnpm exec vitest --config vitest.config.ts

test-e2e: core-build build ## Run all E2E tests hidden (set E2E_HEADED=1 to show Electron)
	cd $(DESKTOP_DIR) && MUXBASE_E2E_HEADED=$(E2E_HEADED) pnpm run test:e2e

test-e2e-stable: core-build build ## Run deterministic shell/UI E2E tests used by the release gate
	cd $(DESKTOP_DIR) && MUXBASE_E2E_HEADED=$(E2E_HEADED) pnpm run test:e2e:stable

test-e2e-live: core-build build ## Run live-agent E2E tests that depend on installed agent CLIs
	cd $(DESKTOP_DIR) && MUXBASE_E2E_HEADED=$(E2E_HEADED) pnpm run test:e2e:live

test-e2e-kanban: core-build build ## Run kanban board E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/kanban-board.e2e.test.ts

test-e2e-pane: core-build build ## Run multi-pane agent E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/multi-pane-agent.e2e.test.ts

test-e2e-multi-agent: core-build build ## Run multi-agent (Claude + OpenCode) conversation E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/multi-agent-conversation.e2e.test.ts

test-e2e-live-agent-terminal: core-build build ## Run live Claude/OpenCode terminal scroll fidelity E2E (starts hai proxy)
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_LIVE_AGENTS=1 MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism --testTimeout=1200000 __tests__/e2e/live-agent-terminal-scroll.e2e.test.ts

test-e2e-multi-agent-slow: core-build build ## Run multi-agent E2E in slow visual mode (pauses, on-screen overlays, UI-driven creation, holds window open at end)
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=1 MUXBASE_E2E_ALLOW_STORE_COERCE=1 MUXBASE_E2E_SLOW=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism --testTimeout=1200000 __tests__/e2e/multi-agent-conversation.e2e.test.ts

test-e2e-conflict: core-build build ## Run conflict resolution E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/conflict-resolution.e2e.test.ts

test-e2e-conflict-slow: core-build build ## Run conflict resolution E2E slowly (visual demo)
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=1 MUXBASE_E2E_SLOW=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/conflict-resolution.e2e.test.ts

demo-record: core-build build ## Record demo footage (hero.webm + full.webm) via the demo E2E test
	cd $(DESKTOP_DIR) && MUXBASE_DEMO_VIDEO=1 MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/demo-video.e2e.test.ts

demo-assets: ## Encode recorded demo footage into the committed hero WebP and full MP4
	node scripts/render-demo-assets.mjs

demo: demo-record demo-assets ## Record demo footage and encode it into release assets

typecheck: ## Run TypeScript type checking across both packages
	pnpm exec tsc --noEmit -p tsconfig.json
	cd $(DESKTOP_DIR) && pnpm exec tsc --noEmit -p tsconfig.main.json
	cd $(DESKTOP_DIR) && pnpm exec tsc --noEmit -p tsconfig.renderer.json

lint: ## Run ESLint over the workspace
	pnpm exec eslint --config eslint.config.js .

internal-refs-gate: ## Fail if internal hostnames or identifiers remain in tracked files
	node scripts/internal-refs-gate.mjs

release-verify: ## Run the canonical release verification gate
	pnpm release:verify

release: ## Trigger the release-please workflow (requires gh CLI auth)
	gh workflow run release-please.yml

clean: ## Remove build artifacts
	rm -rf $(DESKTOP_DIR)/out $(DESKTOP_DIR)/dist $(DESKTOP_DIR)/release dist src/utils/generated-agents-doc.ts

pack: release-verify ## Run the validated unpacked package flow

dist: release-verify ## Build a signed and notarized distributable DMG after the release gate passes
	cd $(DESKTOP_DIR) && pnpm run dist:release

open: pack ## Package and launch the app
	@open "$$(ls -d $(DESKTOP_DIR)/release/mac*/MuxBase.app | head -1)"

all: install ## Install MuxBase.app from source
