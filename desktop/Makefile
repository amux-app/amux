DESKTOP_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
E2E_HEADED ?= 0

.PHONY: install build build-all dev run start test run-test test-e2e test-e2e-pane test-e2e-kanban typecheck clean rebuild help all

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install MuxBase.app from source
	cd $(DESKTOP_DIR)/.. && $(MAKE) install

build: ## Build the Electron app (main + preload + renderer)
	cd $(DESKTOP_DIR) && pnpm exec electron-vite build

build-all: ## Build core TypeScript + Electron app (needed for E2E)
	cd $(DESKTOP_DIR)/.. && pnpm build
	cd $(DESKTOP_DIR) && pnpm exec electron-vite build

dev: ## Start in development mode with hot reload
	cd $(DESKTOP_DIR) && pnpm exec electron-vite dev

run: ## Start with hot reload (HMR for renderer, auto-restart for main)
	cd $(DESKTOP_DIR) && pnpm dev

start: ## Quick start — just launch (skip build, assumes already built)
	cd $(DESKTOP_DIR) && pnpm exec electron .

test: ## Run unit and integration tests
	cd $(DESKTOP_DIR) && pnpm exec vitest run --config vitest.config.ts

run-test: ## Run tests in interactive watch mode (non-headless)
	cd $(DESKTOP_DIR) && pnpm exec vitest --config vitest.config.ts

test-e2e: build-all ## Run all E2E tests hidden (set E2E_HEADED=1 to show Electron)
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/

test-e2e-pane: build-all ## Run multi-pane agent E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/multi-pane-agent.e2e.test.ts

test-e2e-kanban: build-all ## Run kanban board E2E test only
	cd $(DESKTOP_DIR) && MUXBASE_E2E=1 MUXBASE_E2E_HEADED=$(E2E_HEADED) MUXBASE_E2E_ALLOW_STORE_COERCE=1 pnpm exec vitest run --config vitest.config.ts --no-file-parallelism __tests__/e2e/kanban-board.e2e.test.ts

typecheck: ## Run TypeScript type checking
	cd $(DESKTOP_DIR) && pnpm exec tsc --noEmit -p tsconfig.main.json
	cd $(DESKTOP_DIR) && pnpm exec tsc --noEmit -p tsconfig.renderer.json

rebuild: ## Rebuild native modules (node-pty) for Electron
	cd $(DESKTOP_DIR) && pnpm exec electron-rebuild -f -w node-pty

clean: ## Remove build artifacts
	rm -rf $(DESKTOP_DIR)/out $(DESKTOP_DIR)/dist $(DESKTOP_DIR)/release

all: build test ## Build and test
