# Local Changelog

## MuxBase clean-break namespace rename

- **Date/time:** 2026-08-25 08:24 UTC (completion)
- **Impact:** High — intentionally breaking product, package, runtime, filesystem, Electron API, tmux, agent-environment, renderer, packaging, release-workflow, documentation, and test namespace change.
- **What:** Renamed the active Amux/aumx/dmux namespace to MuxBase/muxbase. The workspace packages are now `muxbase` and `muxbase-desktop`; core imports, exported types/functions, `MuxBaseBridge`, preload API, renderer globals, CSS/DOM selectors, tmux sessions/options/pane IDs, `MUXBASE_*` variables, project metadata, settings, journals, logs, support bundles, build metadata, macOS bundle identity, release artifacts, CI, Homebrew workflow, documentation, fixtures, and generated hook documentation use the canonical namespace. The app bundle is `MuxBase.app` with bundle ID `app.muxbase.desktop`.
- **Why:** The repository is making a fresh-install clean break. New installations must have one coherent MuxBase namespace, with no compatibility aliases, migration reads, old-variable fallbacks, or cleanup of old user data.
- **How:** Applied reviewed mechanical namespace batches across tracked source/tests/scripts/docs/workflows, used `git mv` for tracked branded files, regenerated hook documentation, removed the former metadata-path selection logic, moved global settings to `~/.muxbase/settings.json` with mode-700 parent creation, and updated the packaged dependency and release identity. Added `scripts/check-brand-namespace.mjs` plus regression tests; `pnpm run verify:static` now runs the guard. Added fresh-path and old-resource-negative coverage, regenerated the three branding-sensitive visual baselines, and updated the public and local engineering documentation.
- **Risk/compatibility:** This is intentionally not backward compatible. MuxBase only reads `.muxbase`, `muxbase.config.json`, `.muxbase-hooks`, and `~/.muxbase`; old resources are ignored and were not deleted or modified. The guard explicitly reports the two historical changelog files as an allowlist, while rejecting old active references and tracked filenames everywhere else. Existing old tmux sessions and old application data on this workstation were left untouched. The current checkout has no tracked `packaging/homebrew/Casks/amux.rb` or `packaging/` tree, so the existing Homebrew generator/workflow was renamed and verified but no artificial committed cask was created. GitHub repository/tap cutover, release version/email approval, signing, notarization, and optional live-agent qualification remain release-owner/external work.
- **Validation:** `pnpm install --frozen-lockfile`; `make doctor`; `pnpm run check:brand`; namespace guard tests (2/2); `pnpm run verify:static`; `pnpm test` (126 files passed, 1 skipped; 1,077 tests passed, 2 skipped); `cd desktop && pnpm typecheck`; `cd desktop && pnpm test` (352 files passed, 22 skipped; 3,579 tests passed, 167 skipped); `node scripts/ci/tmux-command-smoke.mjs`; `cd desktop && pnpm build`; `cd desktop && pnpm package:smoke` (x64/arm64 ASARs clean, 1,540 entries each, packaged arm64 launch and TypeScript 7 LSP handshake passed); `make demo` (MuxBase hero/full recording and encoding passed, then tracked demo media was refreshed); deterministic feature E2E (marketplace 1/1, Duel 3/3, Pi 1/1); stable E2E (app 17 active/1 skipped, quit 1/1, file browser 17/17, terminal resilience 22/22, sidebar resize 5/5, hidden-tab detach 2/2); UI/release E2E 24/24; updater E2E 2/2; smoke E2E 17 active/1 skipped; scoped `MUXBASE_INSTALL_DIR`/`MUXBASE_INSTALL_NO_LAUNCH=1 make install` (temporary `MuxBase.app` install verified); and the complete `pnpm run release:verify` gate, including audit, static checks, builds, all unit tests, deterministic E2E, smoke, and package verification, passed.

## Remove file-completion visual baseline artifacts

- **Date/time:** 2026-08-25 06:22 UTC (completion)
- **Impact:** Low — removes two committed PNG baseline artifacts and their direct file-browser references; editor/runtime behavior is unchanged.
- **What:** Safely removed `file-completion-dark.png` and `file-completion-light.png` from `code_compl`. Replaced the file-browser baseline dependency with a dark/light popup availability and computed-color smoke assertion so the E2E suite remains runnable without missing artifacts.
- **Why:** The requested branch cleanup explicitly removes both completion baseline files while preserving meaningful popup coverage and avoiding broken missing-baseline failures.
- **How:** Deleted only the two exact tracked PNG paths, removed the unused visual-baseline import/calls, and retained the existing seeded 12-option dark/light popup flow.
- **Risk/compatibility:** The dedicated pixel baselines are no longer part of this branch’s file-browser E2E gate; the existing app visual baselines remain unchanged. The removed files remain recoverable from Git history, including commit `52bdd1d`.
- **Validation:** The focused file-browser E2E and changed-file lint/type checks are rerun before commit; `git diff --check` is verified on staged changes. The unrelated `.gitignore` working-tree change, if present, is not staged.

## Triple-check completion hot-path allocation

- **Date/time:** 2026-08-25 06:17 UTC (completion)
- **Impact:** Low — removes an avoidable full-document allocation from the file-editor Enter command; behavior and public contracts are unchanged.
- **What:** Changed `acceptCompletionIfDocumentChanges` to retain the existing `Text` document and compare with `Text.eq()` after completion acceptance instead of calling `sliceDoc()` before and after every Enter keypress.
- **Why:** Plain Enter is a hot path even when no completion is active; copying a full document up to the editor’s 150 KB full-tier limit was unnecessary.
- **How:** Reused the same `Text.eq()` approach already used by the no-op completion history suppressor. No new abstraction or test surface was needed.
- **Risk/compatibility:** This is comparison-only; completion acceptance, no-op newline behavior, indentation, and Undo semantics are unchanged. Existing local `.gitignore` edits were preserved and not included in this commit.
- **Validation:** Focused completion, path, editor-support, and Enter regression tests passed 35/35; focused ESLint passed. `git diff --check` is blocked only by the pre-existing user-modified `.gitignore` trailing whitespace at line 105.

## Triple-check editor Enter correction

- **Date/time:** 2026-08-25 05:38 UTC (completion)
- **Impact:** Medium — restores existing CodeMirror editor Enter behavior while preserving completion acceptance; no new IPC, dependency, or persisted-data change.
- **What:** Removed the completion DOM-level Enter interceptor and direct newline fallback that preempted CodeMirror’s default keymap. Enter now only attempts completion acceptance and falls through to the existing `defaultKeymap` for normal indentation, brace-pair splitting, modifier behavior, and multiple selections. Restored the default completion interaction guard and kept permanent regressions for opening-brace indentation and brace-pair splitting.
- **Why:** The triple-check scratch reproduction failed all three plain-Enter checks on the committed implementation. The first two were genuine editor-wide regressions; the multi-cursor assertion was rejected because the implementation inserted both newlines and CodeMirror correctly applied indentation.
- **How:** Reduced `acceptCompletionIfDocumentChanges` to the approved document-comparison command, removed the `Prec.highest` DOM handler and direct newline helper, removed `interactionDelay: 0`, and converted the valid scratch cases into `enter-regression.test.ts`. No file-size refactor was made because the repository guidance requires extraction only when ownership or testability improves; no keyword removal was made because the keyword table remains used by exported/test-file completion behavior.
- **Risk/compatibility:** Existing completion Tab/Enter behavior remains covered by the focused EditorView tests and file-browser E2E. Plain Enter now delegates to CodeMirror’s established indentation and multi-selection semantics. The review’s visual-list, leading-dot, and AGENTS claims were verified as non-blocking or already covered.
- **Validation:** The scratch test first failed 3/3 before the correction; permanent Enter regressions pass 2/2. Focused completion/path/editor tests pass 35/35; full desktop tests pass 3,579 with 167 skips; desktop typecheck, `lint:ci`, and build pass; file-browser Electron E2E passes 17/17; `git diff --check` passes.

## CodeMirror completion experience v3

- **Date/time:** 2026-08-24 21:28 UTC (completion)
- **Impact:** Medium — changes the user-facing desktop file-editor completion workflow across renderer source composition, keyboard behavior, filesystem assistance, accessibility styling, and Electron E2E coverage; no new dependency, IPC channel, or persisted-data format was added.
- **What:** Implemented the approved v3 completion plan: one CodeMirror autocomplete host with composable language-data sources, direct LSP `serverCompletionSource` registration, explicit JS/TS source policy, deterministic Tab/Enter/Escape/navigation behavior with one-step Undo, literal path completion for the six reviewed ignore-file names with nested-directory semantics and directory chaining, bounded listing caching and abort/error handling, popup icon/match/detail/scroll styling, and reviewed dark/light visual baselines.
- **Why:** The previous global completion override bypassed language-package and LSP sources, Enter and Tab could accept or indent unpredictably, ignore files had no filesystem completion, and the popup lacked the required visual and accessibility polish.
- **How:** Added `pathCompletion.ts` with renderer-safe `path-browserify` normalization and `file.api.ts` listing calls; moved Amux and LSP sources into `EditorState.languageData`; threaded `rootPath`/`relativePath` through `CodeMirrorEditor`; made the completion keymap and no-op history ownership explicit; and extended the existing file-browser Electron suite rather than creating a parallel E2E surface. Added focused EditorView, parser/cache, policy, accessibility, LSP, and visual-regression coverage.
- **Risk/compatibility:** Literal path completion intentionally does not interpret glob, escape, range, or `**` gitignore syntax. The cache is five seconds and 50 directory listings per editor source. Existing JS/TS language-package completions remain available during LSP startup/failure, while normal JS/TS no longer receives duplicate Amux document-word/keyword noise. `AGENTS.md` was updated with the new completion ownership invariant.
- **Validation:** `pnpm --dir desktop exec vitest run --config vitest.config.ts __tests__/completion-keymap.test.ts __tests__/path-completion.test.ts __tests__/file-editor-support.test.ts` passed 33/33; the new dot-segment regression first failed against cached `.`/`..` reuse and passed after the `validFor` fix. `pnpm --dir desktop typecheck`, `pnpm lint:ci`, and `pnpm --dir desktop build` passed. Full `pnpm --dir desktop test` passed 3,577 tests with 167 environment-gated skips. The file-browser E2E passed 17/17 with root/nested completion, keyboard/ARIA/focus, LSP, and dark/light visual baselines. `pnpm --dir desktop test:e2e:stable` passed app 17 active plus 1 skip, quit 1/1, file-browser 17/17, terminal-resilience 22/22, sidebar-resize 5/5, and hidden-tab detach 2/2. `git diff --check` passed.

## Desktop coverage gate v3

- **Date/time:** 2026-08-24 20:17 UTC (completion)
- **Impact:** Medium — raises the desktop coverage gate from 68% to 82% and adds high-value boundary, persistence, orchestration, renderer workflow, and isolated Electron E2E coverage; production runtime behavior and persisted data formats are unchanged.
- **What:** Implemented the v3 desktop coverage plan: narrowed coverage exclusions to entrypoint/development-only files, added runtime payload validation cases, renderer API fallback contracts, agent-default and rollout readers, pane-summary/worktree/search/decomposition/recap/tmux resilience tests, IPC authorization and cleanup cases, bridge lifecycle regressions, store and hook workflows, command-palette/Kanban/backlog UI interactions, and the permanent 82/80/78 statements-lines/functions-branches thresholds.
- **Why:** The desktop suite was measured at 78.31% before scope correction and 78.67% after the approved narrow exclusions. The new tests protect untrusted input, path safety, persistence consistency, concurrency/cleanup, fallback behavior, and user-visible workflows instead of adding low-signal render smokes or changing code to make coverage easier.
- **How:** Extended existing owning tests where they already existed and added focused files only for missing boundaries. Tests use real filesystem/tmux-isolated or in-memory implementations where practical, fake only external APIs/processes, restore environment/module/timer/singleton state, and assert observable results. No network, real agent CLI, or user configuration is used by the unit/coverage additions.
- **Risk/compatibility:** Test-only change plus coverage configuration. The three exclusions are `src/renderer/main.tsx`, development terminal instrumentation, and the formatter worker entrypoint; `src/main/index.ts` remains included. The stable Electron E2E runner uses its existing isolated tmux/temp-home setup. Credentialed live-agent E2E, signing, and notarization remain outside this task.
- **Validation:** `pnpm run lint:ci` passed with zero warnings; `pnpm build` passed; `pnpm test` passed 125 files with 1,078 tests and 2 intentional skips; `cd desktop && pnpm typecheck` passed; `cd desktop && pnpm test:coverage` passed 348 files with 3,550 tests and 164 intentional E2E skips at **82.21% lines/statements (51,216/62,295), 82.94% functions, and 81.58% branches**; `cd desktop && pnpm test:e2e:stable` passed app 17/17 active, quit 1/1, file-browser 14/14, terminal-resilience 22/22, sidebar-resize 5/5, and hidden-tab detach 2/2; `git diff --check` passed.

## Release Please organization permission recovery

- **Date/time:** 2026-08-24 14:42 UTC (completion)
- **Impact:** Medium — restores the GitHub-side permission required for the automated release pull-request workflow and documents the repository bootstrap prerequisite; application code, release workflow YAML, dependencies, tags, releases, and Git history are unchanged.
- **What:** Enabled the `amux-app` organization policy that allows explicitly authorized GitHub Actions workflows to create pull requests, while preserving read-only default `GITHUB_TOKEN` permissions. Added the policy requirement and failed-run recovery procedure to `AGENTS.md`.
- **Why:** Release Please successfully calculated `0.1.0`, created `release-please--branches--main`, and committed the generated release changes, but GitHub rejected the final pull-request API call because both the organization and repository effective `can_approve_pull_request_reviews` setting were false. Repository-level correction returned HTTP 409 because the organization policy controlled the setting.
- **How:** Read the effective repository and organization workflow-permission APIs using the existing GitHub.com credential, changed only the organization `can_approve_pull_request_reviews` switch, retained `default_workflow_permissions: read`, and verified that the repository inherited the corrected effective value. The failed workflow was deliberately not rerun, so no pull request or other publication action was created.
- **Risk/compatibility:** GitHub combines workflow PR creation and approval in one policy switch. The organization currently contains `amux` and `homebrew-amux`; neither receives general write access because the default remains read-only, and a workflow must still request an explicit write scope. The already-created release branch remains available for a manual rerun to reuse. No secret value was read into output or persisted.
- **Validation:** GitHub's authenticated API reported organization and repository effective settings as `default_workflow_permissions: read` and `can_approve_pull_request_reviews: true`. Public refs still show `main` at `3ebb2fc` and the generated release branch at `3eb6a1d`; no workflow rerun, pull request, commit, tag, release, push, staging operation, or submission was performed. Documentation was checked with `git diff --check`.

## One-time release bootstrap and updater install-path proof

- **Date/time:** 2026-08-24 12:49 UTC (completion)
- **Impact:** High — corrects public release versioning and strengthens the packaged desktop updater acceptance path; application runtime code, IPC, persisted data, and dependencies are unchanged.
- **What:** Removed the persistent `release-as: 0.1.0` setting from Release Please, protected the configuration with a contract test, and extended the packaged Electron updater E2E from the dismiss-only path through **Restart and update** to the disabled installing state. The first `0.1.0` target is carried once by this change's `Release-As` commit footer; later releases return to normal Conventional Commit versioning.
- **Why:** A persistent `release-as` is deprecated and could keep forcing later release pull requests back to `0.1.0`. The existing updater E2E proved discovery, download, global visibility, and **Later**, but did not prove that the user-facing restart action entered the guarded shutdown/install flow.
- **How:** Added a red/green release contract that forbids `release-as`, removed the sticky configuration field, drove the existing fake packaged updater through the real renderer control and main-process preparation path, and documented the one-time footer convention in `AGENTS.md`. No new workflow, release stage, dependency, or updater abstraction was added.
- **Risk/compatibility:** Release Please will request `0.1.0` from this commit only, then derive routine versions from `fix`, `feat`, and breaking-change commits. The deterministic E2E intentionally uses a fake updater and therefore proves the guarded handoff but not a signed macOS replacement and relaunch. Public GitHub execution, Developer ID signing/notarization, and real arm64/x64 `N → N+1` rehearsals remain external release gates and are not claimed as complete.
- **Validation:** The new contract first failed 1/5 against the sticky configuration, then passed 5/5 after removal. Release/update workflow and macOS artifact-verifier contracts passed 10/10; focused desktop updater component, service, adapter, and shared-contract tests passed 27/27; packaged updater E2E passed 2/2 including the new install action; and `pnpm run verify:static` passed internal-reference and version gates, TypeScript, zero-warning ESLint, and Knip. Scoped `git diff --check` passed.

## Simple, fast public GitHub automation

- **Date/time:** 2026-08-24 12:36 UTC (completion)
- **Impact:** High — simplifies pull-request CI, scheduled compatibility/security automation, dependency updates, and the signed release workflow; application runtime behavior, IPC, persisted data, and package dependencies are unchanged.
- **What:** Reduced the repository from 11 GitHub Actions workflows to 9 and removed duplicated work within the remaining jobs. Pull requests now run one Linux quality job with static checks plus single-pass core/desktop coverage, one focused macOS build-and-smoke job, and the existing title/security checks. Exact-floor tmux compatibility now runs weekly or when relevant files change instead of running both floor and stable jobs every day. CodeQL and Scorecard use the current CodeQL v4 action, Dependabot has one workspace-aware npm configuration plus grouped GitHub Actions updates, and redundant custom dependency-audit and secret-scan workflows were removed. Releases now verify the tagged commit directly and no longer depend on a prior nightly run for the exact SHA.
- **Why:** The previous automation repeated root/desktop tests, uploaded unused coverage artifacts, scanned the same pnpm workspace twice, ran redundant dependency and secret checks, executed tmux coverage more often than its compatibility risk justified, and coupled publication to a nightly run that could make a valid first public release impossible. The goal is a small, understandable public-repository pipeline that gives fast PR feedback while retaining full deterministic assurance at night and immediately before publication.
- **How:** Split the canonical validation scripts into a reusable static gate and single-pass test gates; kept pnpm dependency caching on every Node job; narrowed macOS PR work to a real production build plus the established smoke suite; retained one exact-floor tmux matrix; updated SHA-pinned CodeQL actions to v4; consolidated Dependabot at the workspace root; relied on GitHub's public-repository secret scanning; and made the publish workflow self-contained while leaving release-please as the single release entry point. Updated workflow contract tests, upstream-version tests, README guidance, and repository engineering conventions to lock in the simpler topology.
- **Risk/compatibility:** CodeQL continues to skip while the repository is private and activates on the next eligible event after it becomes public. GitHub's native secret scanning becomes available with public visibility; no repository setting was changed locally. Existing Dependabot pull requests created by the old duplicate configuration are not rewritten retroactively. Pull requests intentionally run focused macOS smoke coverage rather than the complete Electron release suite; nightly and tagged publication still run the canonical full gate. Signing, notarization, public-repository Actions execution, and branch-protection settings require GitHub-side credentials or the planned visibility change and were not claimed here.
- **Validation:** The new workflow contract tests first failed in 6 expected places against the old topology, then the final workflow/publish/upstream suites passed 22/22. Every remaining workflow and Dependabot YAML file parsed successfully. `pnpm run verify:static` passed internal-reference and version gates, TypeScript, zero-warning ESLint, and Knip. The first `pnpm run release:verify` passed both zero-vulnerability audits, the static gate, root tests (125 files passed, 1 skipped; 1,076 tests passed, 2 skipped), the desktop production build and unit suite (335 files passed, 22 skipped; 3,449 tests passed, 164 skipped), and all hermetic feature E2E before two untouched terminal splitter cases failed because the isolated tmux panes disappeared mid-run; both cases passed immediately in isolation (2/2). A complete stable rerun reproduced the existing local flake in three different terminal-resilience cases, while the remaining stable files passed. The UI release group passed 23/24 before one untouched focus-return case flaked and then passed immediately in isolation. Updater E2E passed 2/2, desktop smoke passed 17 tests with 1 intentional skip, both x64 and arm64 package contents were clean, the arm64 packaged app launched stably, and its TypeScript 7 LSP handshake passed. Signing and notarization were intentionally skipped locally. `git diff --check` passed before journaling and is rerun during final closeout.

## Bounded live terminal transcripts

- **Date/time:** 2026-08-24 11:33 UTC (completion)
- **Impact:** Medium — bounds disk growth for live tmux ANSI transcripts and changes how active terminal readers follow an atomic file replacement; no IPC, persisted-data, agent-session, or chat-history contract changed.
- **What:** Live pane transcripts are now checked once per minute and rolled over after exceeding the existing 64 MiB reuse cap. The canonical transcript path remains stable, piping continues on a fresh inode, active terminal and OSC 52 readers follow the replacement without replaying stale history, and panes hidden during rollover resume from the new file's end. This affects terminal scrollback only; structured agent conversation/session history remains intact.
- **Why:** Restart-time reuse already rejected transcripts above 64 MiB, but a pane that stayed alive could append to the same `.ansi` file without a bound. Long-running or noisy panes could therefore consume disk indefinitely. A plain unlink/recreate sequence was rejected because readers and the old `cat` writer could temporarily disagree about which inode owned the canonical path.
- **How:** Added a focused rollover service that checks only oversized transcripts belonging to live panes, isolates per-pane failures, and uses a sibling exclusive-create replacement. The tmux `pipe-pane` handoff closes the old pipe before its shell atomically renames the fresh file and starts `cat` on the same canonical path; if rename fails, `cat` still resumes against the existing path. `AumxBridge` owns one unreferenced, overlap-coalesced sweep interval and awaits any in-flight sweep during project teardown. Transcript readers now track device/inode identity, drain stable old-descriptor bytes when visible, reopen the replacement at offset zero, reinstall their watcher, and preserve split UTF-8/OSC 52 decoding across the boundary. Added unit, lifecycle, hidden-pane, failure-isolation, split-OSC, and real isolated-tmux coverage.
- **Risk/compatibility:** The intended tradeoff is that terminal scrollback persisted before a rollover is discarded; in-flight bytes from the closed pipe may correctly land in the fresh transcript, while output accumulated while a pane is hidden remains suppressed. The file can exceed 64 MiB until the next one-minute sweep. A crash can leave an unreferenced `.rollover-*.ansi` sibling, which the existing orphan transcript reaper recognizes and removes after retention. No new dependency, setting, migration, public API, or repository workflow was introduced, so `AGENTS.md` required no update.
- **Validation:** The new tests first failed for the missing service and for replacement-unaware terminal, lifecycle, and split-OSC paths. After implementation, the affected 10-file surface passed 256/256 tests, including real tmux and PTY integration; the final focused rerun after handoff hardening passed 112/112. Desktop `pnpm typecheck` passed. Root `pnpm lint:ci` completed with zero warnings. Full desktop `pnpm test` passed 3,449 tests with 164 environment-gated E2E skips, and root `pnpm test` passed 1,074 tests with 2 intentional skips. `git diff --check` passed.

## Public README release-readiness rewrite

- **Date/time:** 2026-08-24 10:48 UTC (completion)
- **Impact:** Medium — changes the public GitHub landing page, installation guidance, capability expectations, and privacy disclosures without changing application behavior, dependencies, IPC, or persisted data.
- **What:** Reworked the README into a user-first release document with a concise product promise, release and CI trust badges, Homebrew/DMG/source installation paths, an actionable quick start, outcome-focused feature groups, an explicit agent compatibility matrix, transparent local-first/network behavior, separate runtime and source-build requirements, and corrected CI/release-gate documentation.
- **Why:** The previous README was visually strong but overstated default worktree isolation, described five pane views when six exist, implied review agents launch automatically, used an unqualified "no cloud" claim despite optional external services, mixed end-user and build-time requirements, and described the pull-request and audit gates inaccurately. Those mismatches could undermine trust during the first public release.
- **How:** Cross-checked every revised claim against the pane-launch defaults, agent capability contract, review workflow, provider-status and OpenRouter services, Electron settings, package metadata, Make targets, and CI workflows. Worktree isolation is now described as optional, review as user-initiated, pane views and Pi support match current contracts, and external network behavior names both background and user-invoked paths. Contributor material remains concise and links to the existing contribution, security, conduct, and license documents.
- **Risk/compatibility:** Documentation only. Homebrew and GitHub Release links become usable when the canonical repositories and first signed release are public; the source-build path remains the fallback. The static preview badge should be revisited when the project leaves preview. No architecture or contributor workflow changed, so `AGENTS.md` required no update.
- **Validation:** `node scripts/internal-refs-gate.mjs` passed. A local reference scan checked 23 README links and assets with none missing. `pnpm exec vitest --run __tests__/scripts/workflow-upstream-versions.test.ts` passed 13/13 tests, including the documented Node-runtime requirements. `git diff --check` passed. The README was formatted and then passed `pnpm --dir desktop exec prettier --check ../README.md`; the append-only engineering journal retains its established historical formatting.

## Silent macOS Electron E2E execution

- **Date/time:** 2026-08-24 09:48 UTC (completion)
- **Impact:** Medium — changes the local macOS Electron E2E launch and test-window visibility workflow without changing product behavior, test assertions, IPC, or persisted data.
- **What:** Headless Electron E2E runs no longer take over the macOS foreground application, switch Spaces, expose the desktop, or add a transient Dock/menu-bar application. Explicit headed runs remain visible and focused exactly as before.
- **Why:** The existing transparent window and `showInactive()` startup prevented the Amux pixels from appearing, but Electron still launched as a normal macOS application and shared E2E visibility helpers later called focus-taking `show()` and `app.focus({ steal: true })`. That could displace Outlook or any other application the developer was using even though the E2E command was described as headless.
- **How:** Resolve the headless macOS launch to Electron's `accessory` activation policy synchronously during main-process startup, retain the existing transparent real `BrowserWindow` for Playwright rendering, and route headless helper-driven show/restore transitions through `showInactive()` without explicit application or window focus. The same helpers preserve their original `show()`/focus path when `AUMX_E2E_HEADED=1`. Added focused red/green coverage for activation-policy selection and both visibility paths, and documented the macOS runner convention in `AGENTS.md`.
- **Risk/compatibility:** Product launches and explicitly headed E2E are unchanged. Headless tests still create, paint, resize, hide, show, screenshot, and inspect real Electron windows; only native application activation is suppressed. Verification covered the current macOS host with foreground polling at roughly 100 ms; Windows and Linux behavior was not runtime-tested because their execution path is unchanged.
- **Validation:** The new focused regression suite failed first with 4 expected failures before implementation, then passed 12/12. Desktop main-process and root TypeScript checks passed, focused ESLint completed with zero warnings, `pnpm build` completed successfully, and `git diff --check` passed. A real hermetic Pi Electron E2E passed 1/1 with Google Chrome remaining frontmost for the entire sampled run (`focus changed: 0`). The full file-browser Electron E2E passed 14/14, including its shared window-restore helper, with the foreground again unchanged. The focused PTY hide/show lifecycle E2E passed 1/1 (21 unrelated cases skipped) and likewise recorded no foreground change.

## Credential-free release verification and E2E reliability closeout

- **Date/time:** 2026-08-24 08:59 UTC (completion)
- **Impact:** High — changes release automation, security scanning, Electron E2E lifecycle behavior, and the canonical desktop test configuration without changing product APIs or persisted data.
- **What:** Removed the two credential-dependent live-agent test files, their API-key preflight, their package scripts, and the nightly third-party CLI matrix. Nightly now runs the repository's deterministic, credential-free `release:verify` gate, while publishing still requires a successful nightly run for the exact release SHA. Optional local `test:e2e:live` coverage remains for developers whose agent CLIs are already authenticated. Added a narrowly scoped Gitleaks allowlist for known-fake fixtures, limited desktop Vitest to 50% of host workers, hardened Electron shutdown to fail if SIGKILL does not terminate the child, retained caller ownership of explicitly supplied E2E user-data directories, and made the terminal-resize E2E derive its drag from measured layout headroom.
- **Why:** The project does not intend to provision OpenAI or Anthropic API keys to CI. Deterministic release assurance should therefore be hermetic and must not silently lose its exact-SHA publication gate. The worker cap fixes reproducible full-suite worker-fetch and timeout failures caused by host oversubscription; each reported test passed serially before the cap, and the complete suite passed after it. The remaining lifecycle and geometry changes turn silent cleanup or layout assumptions into bounded, diagnostic failures.
- **How:** Simplified `nightly-e2e.yml` to one least-privilege job invoking the root canonical release gate (including audits, core checks, desktop E2E, and packaging); updated publish and structural workflow tests to reject credential, issue-write, third-party installer, and desktop-only gate regressions; removed only direct credentialed test surfaces; updated repository guidance; and kept product-level OpenRouter configuration untouched. Gitleaks uses one rule/path/value AND-scoped allowlist rather than excluding test directories.
- **Risk/compatibility:** No public API, IPC, persisted-data, or runtime agent contract changed. Removing hosted live-provider tests intentionally trades automatic provider-CLI compatibility sampling for a credential-free release pipeline; hermetic fake-agent lifecycle E2E and optional local authenticated live-agent E2E remain. Signing and notarization were intentionally not exercised by the unsigned package verification command. Public source authorization, asset provenance, remote CI availability, and signed/notarized distribution remain external release gates. The configured GitHub CLI account cannot access the canonical GitHub.com repository (Actions query returned 404), so no remote run was claimed.
- **Validation:** `gitleaks git --redact --exit-code 1 --config .gitleaks.toml` scanned 109 commits and found no leaks. `pnpm run verify:ci` passed internal-reference and version checks, typecheck, zero-warning lint, Knip, and root tests (125 files passed, 1 skipped; 1,074 tests passed, 2 skipped). The full `pnpm release:verify` passed both dependency audits, all preceding static/unit gates, the production desktop build, desktop unit tests (334 files passed, 22 E2E files intentionally skipped; 3,432 tests passed, 164 skipped), hermetic marketplace/Duel/Pi feature E2E, the complete stable Electron suite including 22/22 terminal-resilience cases, 24/24 UI/accessibility cases, 2/2 update cases, smoke/visual baselines, clean x64 and arm64 package contents, arm64 packaged launch, and the packaged TypeScript 7 LSP handshake. The initial uncapped desktop run's four contention failures all passed serially (64/64) before the worker cap; the capped full suite then passed twice, once standalone and once inside `release:verify`. Focused workflow tests passed again after changing nightly to the root canonical gate. Both split branch tips remain ancestors of `main`. `codex review --uncommitted` inspected the diff, reran TypeScript and workflow checks, then recursively launched itself through the installed closeout skill; only the nested reviewer processes were terminated, so no clean independent verdict is claimed and no review finding was emitted before termination.

## Safe publication of final terminal E2E hardening

- **Date/time:** 2026-08-24 06:44 UTC (completion)
- **Impact:** High — reconciled a test-only terminal E2E hardening commit with 20 newer remote-main commits and prepared the combined, fully verified history for publication without rewriting remote history.
- **What:** Integrated local commit `cd80ff1` with remote `main` at `9259c1d`, preserving the remote anti-slop stack and the exact hardened alternate-screen selection E2E. The only merge overlap was the engineering journal, whose histories were retained additively; one inherited private absolute workstation path found during closeout review was sanitized.
- **Why:** Remote `main` advanced after the final E2E fix was committed locally. A normal merge was required so neither the verified local fix nor the already-published remote work would be lost.
- **How:** Fetched and audited the 20/1 divergence, created backup branch `codex/backup-main-before-e2e-push-cd80ff1`, performed a non-force `--no-commit` merge, resolved the journal conflict additively, proved the terminal-resilience blob still matched `cd80ff1`, and ran the complete release gate before creating the merge commit. No production terminal file was changed by the local E2E hardening.
- **Risk/compatibility:** The local delta remains test-only; the combined remote changes retain their existing contracts and verification. Publication uses a normal push with both prior tips as ancestors. Signing/notarization and credentialed live-agent canaries were not run because their credentials were unavailable. GitHub-hosted workflows remain externally blocked by the repository account's billing/spending-limit state until an account owner corrects it.
- **Validation:** `pnpm run release:verify` passed end to end: zero audit findings; clean public/private internal-reference gates, versions, typecheck, zero-warning lint, Knip, and builds; 1,074 core tests passed with 2 intentional skips; 3,432 desktop tests passed with 169 intentional skips; feature E2E passed marketplace 1/1, Duel 3/3, and Pi 1/1; stable E2E passed 61 with 1 skip, including all 22 terminal-resilience stories and the hardened native-selection case; UI/accessibility passed 24/24; updater passed 2/2; smoke/visual baselines passed 17 with 1 skip. Both x64 and arm64 packages were clean with 1,539 entries; the arm64 packaged launch and TypeScript 7 LSP handshake passed. Independent staged-merge review verified conflict resolution and parent-tree preservation, found only the sanitized private path, and then passed cleanly on rerun with no actionable findings.

## Main integration re-verification and E2E drag hardening

- **Date/time:** 2026-08-23 20:17 UTC (completion)
- **Impact:** Low — test-harness reliability only; production terminal behavior, IPC, persistence, and public interfaces are unchanged.
- **What:** Re-verified that both the InteractiveTerminal and AumxBridge split tips are fully contained in `main`, then hardened the existing mouse-reporting alternate-screen selection E2E against Chromium dropping stationary edge-drag events under a loaded release run.
- **Why:** A second full release verification reached the stable Electron stage with all preceding gates green, but one inherited selection test stopped around fixture line 43 while waiting for line 90. The same case passed immediately in isolation and three additional independent reproductions, showing a bounded interaction race rather than a split regression; leaving the passive wait unchanged would still make the release gate unnecessarily timing-sensitive.
- **How:** Replaced the test's single bottom-edge mouse move plus passive text poll with the file's existing `continueSelectionDragUntilTextVisible` helper. That helper preserves the real held-mouse selection path and applies one-pixel pointer jitter specifically to keep Chromium mousemove delivery active. No timeout, production scroll policy, fixture, or assertion was weakened.
- **Risk/compatibility:** Test-only and narrowly scoped. The case still requires the newest marker, agent-input wheel evidence, exact clipboard contents, alternate-buffer state, and fixture wheel logging. Both split worktrees remain clean. Signing and notarization were skipped because release credentials were not configured; x64 package contents were inspected and the arm64 package was launched.
- **Validation:** Ancestry checks proved `codex/split-interactive-terminal` and `codex/split-aumx-bridge` are ancestors of `main`; branch-touched path comparison found only the intentional combined Duel test and additive changelog differences. `git diff --check`, zero-vulnerability audits, internal-reference/version gates, typecheck, zero-warning lint, Knip, production build, 1,069 core tests with 2 skips, and 3,427 desktop tests with 169 intentional E2E skips passed. The complete integration `codex review --base bfcb2848b2612871e65ecf8c76318cb629b87e1c` returned clean with no findings. Feature E2E passed marketplace 1/1, Duel 3/3, and Pi 1/1. The full stable Electron group passed 61 tests with 1 skip on rerun; after the test-only hardening, the affected case passed 3/3 consecutively and the complete terminal-resilience file passed 22/22. UI/accessibility passed 24/24, updater 2/2, and smoke 17 with 1 skip. Both x64 and arm64 ASARs were clean with 1,538 entries and 23,507,273 bytes; the arm64 packaged launch and TypeScript 7 LSP handshake passed. The final narrow reviewer found no actionable issue and independently passed typecheck plus the exact E2E; three required same-model `codex review --uncommitted` attempts were blocked before review by the account usage limit and emitted no findings.
## Anti-slop integration onto current main

- **Date/time:** 2026-08-23 20:21 UTC (completion)
- **Impact:** High — reconciled the verified anti-slop work with the independently landed InteractiveTerminal and AumxBridge architecture changes before publishing remote `main`.
- **What:** Merged `origin/main` at `4d98043` into `codex/anti-slop-hardening`. The final delta from that main revision contains only the missing accessibility, deterministic visual-regression, pane-creation tmux allocation, marketplace E2E shutdown, public-text cleanup, and obsolete proof-image removal changes.
- **Why:** Remote main advanced after the anti-slop branch was verified and included a newer terminal-session ownership split. Blindly choosing the older branch implementation would have discarded its atomic boot reset, reset-epoch timer ownership, facade/session boundary, and expanded regression coverage.
- **How:** Resolved nine overlaps semantically. Kept the newer `origin/main` versions byte-for-byte for all terminal implementation/tests and the incidental prose test, because main's `useTerminalBoot` already handles pre-existing waiting sessions atomically and directly tests lifecycle resets. Combined the unique anti-slop journal entries with all main history. Confirmed the post-resolution tree differs from pre-merge main in exactly 18 expected paths and contains no terminal conflict-path delta.
- **Risk/compatibility:** No public API or persisted-data contract changed. The unrelated dirty primary checkout was not modified. The feature branch was backed up to `origin/codex/anti-slop-hardening` before integration. macOS signing/notarization and credentialed live-agent canaries were not run because their credentials were not configured. GitHub-hosted workflows could not start because the repository account reports failed recent payments or an exhausted spending limit; this external billing state must be corrected by an account owner before remote CI can execute.
- **Validation:** Before the merge commit, focused integration checks passed 19/19 core cases, 134/134 desktop terminal/theme/visual cases, and root typecheck. On merge commit `9d644bb`, `pnpm release:verify` passed end to end: zero production/full audit findings; clean internal references, versions, typecheck, lint, Knip, and builds; 1,060 core tests passed with 2 intentional skips; 3,432 desktop tests passed with 169 intentional skips; feature E2E, stable Electron E2E, 22 terminal-resilience stories, 24 UI accessibility/release stories, update E2E, smoke/visual baselines, and x64/arm64 package-content checks all passed. The arm64 packaged executable and packaged TypeScript 7 LSP handshake passed; x64 launch was correctly skipped on the arm64 host. After publication, the local HEAD, fetched `origin/main`, and live remote `refs/heads/main` matched exactly with no tree diff, and the original verified commit remained an ancestor. CI, Secret Scan, Scorecard, and release-please each failed before executing any step with the same GitHub billing/spending-limit annotation; CodeQL was skipped for the same push.

## Triple-checked anti-slop review corrections

- **Date/time:** 2026-08-23 18:26 UTC (completion)
- **Impact:** High — independently revalidated the full hardening diff and corrected only findings with reproducible behavior, measurable quality impact, or demonstrably stale publication content.
- **What:** Restored a distinct accessible muted-text tier in all four themes; fixed terminal boot reconciliation after both asynchronous initial setup and later lifecycle rebuilds; removed a test-only config-reader injection seam from tmux allocation; corrected stale/raw publication text and a private-handle fixture; removed one branch-only work-session spec and two unreferenced root proof images; restored the established unreferenced quit timer after disproving the proposed timer-reference fix; and aligned the marketplace E2E hook with the cleanup helper's documented maximum shutdown duration.
- **Why:** The review correctly identified semantic color collapse, a remaining lifecycle reset path, test-only production API surface, and publication debris. It incorrectly treated `Timeout.unref()` as cancellation and also proposed broad changes without demonstrated value, including Git-history rewriting, package-author policy changes, naming normalization across intentional current/legacy identifiers, metric-driven file splitting, and removal of the narrowly evidenced Pi test timeout.
- **How:** Added black-box regressions for distinct theme hierarchy and the already-waiting terminal lifecycle rebuild, then made the smallest production corrections. Pane-allocation tests now use real temporary JSON config files instead of production dependency injection. The marketplace hook now uses the same 30-second shutdown convention as other Electron suites because its helper can spend 10 seconds awaiting graceful exit and another 10 seconds after SIGTERM. Unsupported findings were documented and left unchanged rather than adding abstractions or churn.
- **Risk/compatibility:** No public API or persisted-data contract changed. The removed PNGs and spec remain recoverable from Git history. The final branch has no production diff from the base for the quit-deadline experiment. Git authorship/history, private-package author metadata, intentional `aumx`/`Amux`/`.amux`/legacy `.aumx` distinctions, large pre-existing owners, the explicit visual-baseline update gate, and the focused Pi timeout were deliberately preserved.
- **Validation:** The new theme test failed against all four interim aliases before the distinct AA colors were applied, and the new terminal test failed with `data-booting=true` before the lifecycle reconciliation fix. Focused suites passed 138/138 desktop cases and 19/19 core cases; the real forced-quit E2E passed three consecutive isolated runs with `unref()` restored; marketplace E2E passed three consecutive isolated runs; and the full `pnpm release:verify` completed successfully. The canonical gate reported zero audit findings, clean references/versions/typecheck/lint/Knip/builds, 1,060 core tests passed (2 intentional skips), 3,369 desktop tests passed (169 intentional skips), feature/stable/accessibility/update/smoke/visual E2E green, clean x64/arm64 package contents, a stable arm64 packaged launch, and a successful packaged TypeScript 7 LSP handshake. Signing/notarization and credentialed live-agent canaries were not exercised. One preceding canonical run exposed and motivated the marketplace hook-timeout correction; one isolated stateful duel rerun failed on its pre-existing viewport sequence, while the unchanged duel suite subsequently passed all three phases inside the final canonical gate. `codex review --uncommitted` independently reran and passed the same 157 focused cases and reported no finding before recursively invoking itself through its installed closeout skill; the tooling loop was terminated rather than counted as a clean review result.

## Anti-slop hardening closeout

- **Date/time:** 2026-08-23 17:43 UTC (completion)
- **Impact:** High — cross-layer hardening of accessibility, maintainability, terminal correctness, and visual release assurance, with shutdown behavior independently revalidated.
- **What:** Completed the double-checked, high-value repository hardening scope: made muted semantic text readable in every theme, separated cohesive terminal and tmux-allocation responsibilities, added stable golden-image release checks, preserved terminal boot reconciliation, and narrowly stabilized three filesystem-backed Pi prompt tests under full-suite contention. A later triple-check determined that keeping the quit timer referenced was not causal and reverted that experiment without weakening the process-level deadline test.
- **Why:** The repository audit intentionally excluded speculative style complaints and broad rewrites. These items were retained because each had reproducible evidence, a concrete production or maintenance impact, and a simple fix that improves professional quality without adding architectural machinery.
- **How:** Reused existing services and contracts; introduced focused hooks/components for terminal model, overlays, visibility, search, boot, and resize ownership; delegated `createPane` tmux topology work to one internal module; added three deterministic Electron visual baselines with explicit update tooling; and added targeted regression tests around every behavior change. Closeout review found a React effect-order regression in the extracted boot lifecycle; the subsequent triple-check extended that correction through asynchronous initial setup and lifecycle rebuilds.
- **Risk/compatibility:** No public API or persisted-data format changed. The terminal and pane-creation work is behavior-preserving except for the documented boot-order correction; visual baselines now require deliberate review when stable UI changes. Credentialed live-agent canaries were not run, and macOS signing/notarization were not exercised because release credentials were unavailable; the packaged artifacts themselves were verified.
- **Validation:** Before the later triple-check corrections, two consecutive `pnpm release:verify` runs completed successfully. Each passed zero-vulnerability production/full audits, internal-reference and version gates, typecheck, lint, Knip, builds, 1,060 core tests (2 intentional skips), 3,367 desktop tests (169 intentional skips), feature E2E, all stable Electron E2E groups (including 22 terminal-resilience, 14 file-browser, quit, hidden-detach, sidebar, and visual-baseline checks), 24 UI release stories, update E2E, smoke E2E, and clean x64/arm64 package-content checks. The arm64 packaged executable and TypeScript 7 LSP handshake passed; x64 launch was correctly skipped on the arm64 host. Final post-triple-check verification is recorded in the entry above.

## Pi prompt test timeout isolation

- **Date/time:** 2026-08-23 17:24 UTC (completion)
- **Impact:** Low — stabilizes a filesystem-backed core test under full-suite contention; production behavior is unchanged.
- **What:** Gave only the three syntax-sensitive Pi prompt-file cases a 15-second timeout instead of Vitest's 5-second unit default.
- **Why:** Two canonical release runs reproduced timeouts at 5.0–5.2 seconds while the same 35-test file passed in isolation and the affected cases completed in 8–17 ms without suite contention. These cases create, inspect, and recursively remove real temporary directories, so the global unit timeout was not a reliable boundary during parallel filesystem-heavy runs.
- **How:** Applied Vitest's per-table timeout to the existing three-case test. No global timeout, retry, production code, or assertion was changed.
- **Risk/compatibility:** Test-only and narrowly scoped. A real hang still fails after 15 seconds, while all behavioral assertions remain identical.
- **Validation:** The focused `paneAgentLaunch` suite passed 35/35, root ESLint completed cleanly, and `git diff --check` passed. Canonical release verification is recorded separately after closeout.

## Boot-state reconciliation order

- **Date/time:** 2026-08-23 17:17 UTC (completion)
- **Impact:** Medium — fixes an initial-mount terminal boot-overlay regression introduced by the lifecycle extraction; no public API or persisted data changed.
- **What:** Ensured a pre-existing agent waiting/idle signal reconciles boot state after the terminal lifecycle resets for a new pane mount.
- **Why:** Closeout review identified that moving activity reconciliation into `useTerminalBoot` changed React effect order. On initial mount, the hook could dismiss the overlay for a waiting session before the parent lifecycle effect reset it back to booting.
- **How:** Kept boot-state rules in `useTerminalBoot`, but exposed a narrow `reconcileActivity` callback and invoked it from a parent effect declared after the terminal lifecycle effect. This restores the original reset-then-reconcile ordering without coupling the hook to terminal creation.
- **Risk/compatibility:** Low. Activity changes still reconcile immediately, soft/hard boot timers are unchanged, and the existing waiting-session restart behavior remains intact.
- **Validation:** A new public-component regression reproduced the failure first (`data-booting` was `true` instead of `false`). After the fix, boot-hook, InteractiveTerminal, attach-retry, and hidden-detach suites passed 135/135; desktop typecheck, focused ESLint with zero warnings, and `git diff --check` passed.

## Deterministic visual regression gate

- **Date/time:** 2026-08-23 17:08 UTC (completion)
- **Impact:** Medium — the stable Electron E2E release path now fails on material regressions in three representative renderer states; application runtime behavior and dependencies are unchanged.
- **What:** Replaced the screenshot-exists smoke assertion with pixel comparisons for the empty Fleet in dark and light themes and the Appearance settings surface in dark mode.
- **Why:** Merely writing a screenshot cannot detect visual regressions, while the existing opt-in 60-cell capture matrix was intentionally observational and too broad to make a reliable release gate.
- **How:** Added three reviewed PNG baselines and a small Playwright helper that uses Chromium's native image/canvas decoding, avoiding a new framework or image dependency. Comparisons require identical dimensions and enforce both changed-area and mean-color budgets. Fonts, animations, caret rendering, viewport, pane state, view, and theme are normalized; only the transient toast layer is hidden. Failures preserve the actual screenshot under `desktop/out/visual-regression`, and `AUMX_UPDATE_VISUAL_BASELINES=1` is the explicit update path.
- **Risk/compatibility:** Low. The gate deliberately covers stable non-terminal content and excludes live terminal pixels, notifications, sidebar project identity, and host metrics. The 1% changed-pixel and 1.5 mean-channel budgets tolerate minor rasterization noise but reject material layout or palette changes.
- **Validation:** The threshold unit test failed first because the helper did not exist, then passed 4/4. The first E2E comparison correctly rejected transient toast content at 3.41% changed pixels; normalization was narrowed to that ephemeral layer. Baselines were regenerated and visually inspected, and two consecutive non-update app E2E runs passed 17/17 active tests each. Desktop typecheck/build, focused ESLint with zero warnings, and `git diff --check` passed.

## Focused tmux allocation for pane creation

- **Date/time:** 2026-08-23 17:01 UTC (completion)
- **Impact:** Medium — behavior-preserving architecture refactor of pane creation's tmux control-pane resolution, allocation fallback, and stale-pane recovery; no public API, persisted format, or user-visible workflow changed.
- **What:** Extracted the control-pane/config resolution and tmux pane allocation state machine from `createPane` into a focused `paneCreationTmux` module, reducing the main orchestrator by 99 lines.
- **Why:** `createPane` mixed worktree provisioning, tmux topology recovery, agent launch, persistence, hooks, and rollback in one deeply nested function. Tmux allocation is a cohesive responsibility with independent invariants and failure modes.
- **How:** Kept `createPane` as the public linear orchestrator and added two narrow functions: `resolveControlPane` owns configured-pane validation and fallback, while `allocateTmuxPane` owns sidebar/window selection, no-space fallback, stale-control repair, and one retry. Existing services and config mutation primitives are reused; no generic framework or new abstraction layer was introduced.
- **Risk/compatibility:** Low. Call order, log messages, session inference, layout decisions, config writes, and thrown errors are preserved. The new module is internal and uses narrow service interfaces.
- **Validation:** The new test failed first because the extraction module did not exist. After implementation, direct allocation tests and existing pane lifecycle/worktree strategy suites passed 48/48. `pnpm build`, focused ESLint with zero warnings, and `git diff --check` passed.

## Accessible semantic muted text

- **Date/time:** 2026-08-23 16:56 UTC (completion)
- **Impact:** Medium — all renderer surfaces using the shared muted-text role became more legible across every theme; no component API or layout changed.
- **What:** Made `--text-muted` meet the same WCAG AA text floor as `--text-secondary` and added it to the existing all-theme/all-backdrop contrast lock.
- **Why:** The repository inventory classified nearly every muted-text use as required content, while the token measured as low as 2.09:1. Editing hundreds of call sites would retain an inaccurate semantic distinction and create unnecessary churn.
- **How:** Assigned one distinct muted gray per theme at the dimmest practical AA boundary, preserving the existing token contract and avoiding component migration. A dedicated test now prevents `--text-muted` from collapsing into `--text-secondary` again.
- **Risk/compatibility:** Required metadata and controls remain readable while the three-tier text hierarchy is preserved. Layout, focus, interaction, and color-role APIs are unchanged.
- **Validation:** The original expanded contrast test failed with all 16 muted-text theme/backdrop pairs below 4.5:1. The triple-check's hierarchy assertion then failed against the interim aliases in all four themes and passed with distinct AA-compliant values; focused visual baselines remained within their reviewed budgets.

## Application quit deadline experiment (superseded)

- **Date/time:** 2026-08-23 16:55 UTC (completion)
- **Impact:** None in the final branch — a shutdown hypothesis was tested and later reverted after deeper lifecycle validation.
- **What:** Temporarily removed `unref()` from the global graceful-shutdown deadline and asserted its ref state. The triple-check restored the original unreferenced timer and removed the implementation-detail assertion.
- **Why:** The initial change correlated one full-suite quit timeout with timer ref state, but that did not establish causality. Electron's prevented `before-quit` flow retains the application/window lifecycle independently, and `unref()` does not cancel the timer.
- **How:** Restored the established main-process timer convention while retaining the real process-level E2E that blocks resource cleanup and requires `app.exit(0)` after approximately five seconds.
- **Risk/compatibility:** No final production diff remains for this experiment. The unexplained historical suite timeout is not relabeled as fixed.
- **Validation:** With `unref()` restored, the focused unit suite passed 13/13 and the real isolated `app-quit.e2e.test.ts` passed three consecutive runs, each forcing process exit in approximately 5.1 seconds.
## InteractiveTerminal and AumxBridge split integration

- **Date/time:** 2026-08-23 19:57 UTC (completion)
- **Impact:** High — two independently reviewed architectural splits and their final failure-boundary hardening are now combined on `main`; terminal lifecycle, pane/worktree cleanup, historical-session validation, and real Electron synchronization paths are affected.
- **What:** Integrated `codex/split-interactive-terminal` and the latest `codex/split-aumx-bridge` changes into `main` and pushed the reconciled history to `origin/main`. The only runtime/test conflict was the Duel E2E, whose independently added improvements were combined so the test uses the real Electron content size and a bounded containment poll while preserving asynchronous loser-branch cleanup polling; the engineering changelog merged additively. No PR or force-push was used.
- **Why:** The splits had each passed focused review in isolation, but production readiness requires proof that their shared terminal, pane-launch, worktree, and Electron E2E surfaces remain compatible after integration.
- **How:** Preserved the pre-reconciliation merge on a temporary backup ref, merged the remote hardening commit without rewriting history, combined the Duel test's structured diagnostics with the reviewed 10-second settle bound, and validated the combined index before concluding the merge. No production conflict or API redesign was needed. The combined tree preserves the terminal facade/session-hook boundaries and the bridge's guarded cleanup/publication behavior.
- **Risk/compatibility:** Public IPC, persistence schemas, and exported facade signatures remain unchanged. Cleanup still avoids killing published panes, monitor refresh failures remain best-effort after publication, terminal boot ownership remains atomic, and malformed OpenCode rows are filtered individually. The integration was published as a normal fast-forward without rewriting remote history. Signing and notarization were skipped because no usable release credentials were configured; x64 contents were inspected but its executable was not launched on the arm64 host.
- **Validation:** `git diff --check --cached`, desktop typecheck, 35/35 pane-agent launch tests, and 150/150 focused InteractiveTerminal/model/hook/overlay tests passed. `pnpm run release:verify` completed successfully: zero-vulnerability production/full audits; internal-reference, version, typecheck, zero-warning lint, Knip, and production-build gates; 1,069 core tests passed with 2 skips; 3,418 desktop tests passed with 169 intentional E2E skips; feature E2E passed marketplace 1/1, Duel 3/3, and Pi 1/1; stable E2E passed 61 with 1 skip; UI/accessibility passed 24/24; updater passed 2/2; smoke passed 17 with 1 skip. Both x64 and arm64 ASARs were clean with 1,538 entries and 23,505,329 bytes; the arm64 packaged launch and TypeScript 7 LSP handshake passed. An additional combined `codex review --uncommitted` produced no actionable finding before recursively launching itself and was stopped; the already completed independent multi-agent reviews plus the complete release gate provide the closeout evidence.

## AumxBridge split deep-review hardening

- **Date/time:** 2026-08-23 18:06 UTC (completion)
- **Impact:** High — pane creation/reopen failure semantics, tmux resource cleanup, and external session-data validation changed at runtime; public IPC, persistence schemas, and facade signatures remain unchanged.
- **What:** Completed three independent post-split reviews covering architecture, concurrency/lifecycle safety, and test quality/simplicity. Fixed four confirmed failure-boundary defects: control-pane preparation can no longer leave creation progress active; a monitor refresh failure after pane publication no longer reports the committed pane as failed; terminal and reopened-worktree panes are killed when setup fails before publication; and malformed OpenCode array elements are filtered without discarding valid sessions. The Duel E2E now gives the unchanged 800x600 containment assertion an explicit layout-settle budget under loaded release runs.
- **Why:** The architecture and concurrency reviews found no split-introduced regressions, but the test-quality review identified inherited monolith behavior that could cause a stuck progress indicator, duplicate panes after a false-negative response, leaked untracked tmux panes, or loss of valid session results from one malformed CLI row. A full release run also reproduced a test-only timing failure before Duel pane creation while the exact suite passed in isolation.
- **How:** Moved control-pane preparation inside the existing workflow transaction and made one guarded `finally` block own watcher/progress balancing. Added narrow `killPane` ports and allocation/publication flags so only uncommitted resources are removed, with cleanup errors logged without replacing the original failure. Wrapped post-publication monitor refreshes as best-effort diagnostics. Added a local OpenCode row type guard. All runtime fixes were preceded by failing regression tests; the nine new cases failed against the reviewed implementation and passed after the minimal changes. The same three reviewers re-reviewed the corrective diff and reported no remaining findings.
- **Risk/compatibility:** Committed panes remain available even if monitor restart fails, preventing retry-created duplicates. Cleanup never kills a pane after state publication. Project mutation coordination, project-switch exclusion, persistence ordering, callback ownership, activity lifecycle, and public response shapes remain intact. The OpenCode total now counts only structurally valid rows. Signing and notarization remain intentionally disabled in package-smoke, and the x64 executable is not launched on the arm64 host.
- **Validation:** Focused red/green suites passed 37/37 after reproducing 9/9 new failures. Three independent reviewers completed both initial and post-fix reviews with no remaining findings; their focused checks covered up to 253 architecture tests, 114 lifecycle tests, and 98 post-fix lifecycle tests. Zero-vulnerability production/full audits, internal-reference and version gates, core/main/renderer typecheck, zero-warning lint, Knip, build, and `git diff --check` passed. Core passed 1,055 tests with 2 skips; desktop passed 3,401 tests with 169 intentional E2E skips. Coverage passed 3,393 tests with 169 skips at 78.17% statements/lines, 80.95% branches, and 80.22% functions, above the pre-split 77.76%/80.68%/79.53% baseline. Extracted-domain statement/function coverage is AgentCatalog 98%/100%, DuelWorkflow 95.18%/100%, PaneActionWorkflow 92.79%/100%, PaneLaunchWorkflow 91.83%/100%, PaneSessionCatalog 95.92%/100%, ReviewWorkflow 95.18%/100%, and WorktreeWorkflow 91.26%/100%. Feature E2E passed marketplace 1/1, Duel 3/3, and Pi 1/1; stable E2E passed 61 with 1 skip; UI release passed 24/24; update passed 2/2; smoke passed 17 with 1 skip. Both x64 and arm64 packages contained 1,538 clean entries and 23,504,625 bytes; the arm64 packaged launch and TypeScript 7 LSP handshake passed. One additional back-to-back monolithic release repetition, after multiple full coverage/E2E/package cycles, timed out in the shared file-browser fixture and cascaded into six dependent cases; the exact isolated file-browser suite then passed 14/14 in 14.45 seconds, matching the earlier complete stable-suite pass. No runtime file-browser code was changed.

## AumxBridge split coverage and release-gate hardening

- **Date/time:** 2026-08-23 17:44 UTC (completion)
- **Impact:** Medium — test-only hardening of extracted bridge contracts and deterministic release verification; production behavior, IPC, persistence, and public APIs are unchanged.
- **What:** Expanded direct tests for pane launch, pane actions, historical sessions, and preserved worktrees so every extracted bridge domain now has more than 92% statement coverage and 100% function coverage. Stabilized the duel feature E2E by resizing the real Electron `BrowserWindow` content area, waiting for two layout frames, and polling the explicitly background branch cleanup. Increased only the real-subprocess Pi prompt table's test timeout from 5 to 15 seconds after two loaded full-suite runs exceeded 5 seconds on different rows while the isolated case completed in milliseconds.
- **Why:** Aggregate coverage was green, but the final audit found unexercised rollback/callback/default-adapter paths. Repeated release runs also exposed two test-contract races: Playwright viewport emulation did not resize Electron's native window, and the duel test checked branch deletion immediately after worktree deletion even though `WorktreeCleanupService` documents both as sequential background steps. The Pi table's original timeout was below observed loaded-suite execution time.
- **How:** Added success/failure/lock-release coverage for worktree inspect, remove, reopen, and attach; early emit/rollback, agent-choice, terminal failure, and duplicate coverage for pane launch; nested choice/input coverage for pane actions; and real default OpenCode CLI/parser-adapter coverage for session listing. The E2E keeps all existing geometry and destructive-cleanup assertions and changes only their synchronization boundary.
- **Risk/compatibility:** Test-only. No assertion was removed or weakened. Native-window resize now verifies the actual 800x600 product constraint instead of an emulated renderer viewport. Branch cleanup retains the same 20-second bound. One monolithic release attempt encountered an unrelated pre-existing pane-session watcher timing miss under sustained host contention; that exact 20-test suite and the complete 3,392-test desktop suite both passed immediately in fresh runs, and every remaining release stage was then completed independently.
- **Validation:** Focused bridge-domain suites passed 35/35 and desktop typecheck passed. Final desktop coverage passed 3,384 tests with 169 skips at 78.16% statements/lines, 80.94% branches, and 80.26% functions. Extracted-domain statement/function coverage was: AgentCatalog 98%/100%, DuelWorkflow 95.18%/100%, PaneActionWorkflow 92.79%/100%, PaneLaunchWorkflow 92.81%/100%, PaneSessionCatalog 95.51%/100%, ReviewWorkflow 95.18%/100%, and WorktreeWorkflow 92.45%/100%. Audits found zero vulnerabilities; internal references, versions, typecheck, zero-warning lint, Knip, and production build passed. Core passed 1,055/1,057 with 2 skips; desktop passed 3,392/3,561 with 169 E2E skips; the isolated pane-session watcher suite passed 20/20. The hermetic feature group passed twice consecutively (marketplace 1/1, duel 3/3, Pi 1/1). Stable E2E passed 61 tests with 1 skip (app 17/18, quit 1/1, file browser 14/14, terminal resilience 22/22, sidebar 5/5, hidden detach 2/2); UI release passed 24/24; update passed 2/2; smoke passed 17/18 with 1 skip. Dual-architecture package inspection reported 1,538 clean entries and 23,502,681 bytes for each app, a stable arm64 packaged launch, and a passing packaged TypeScript 7 LSP handshake; x64 launch was correctly skipped on the arm64 host. Signing and notarization remained intentionally disabled by package-smoke configuration.

## AumxBridge split production verification

- **Date/time:** 2026-08-23 17:07 UTC (completion)
- **Impact:** High — production-readiness verification and final audit of the complete bridge domain split.
- **What:** Ran the repository CI, coverage, release, Electron E2E, smoke, and package verification matrix on the committed `codex/split-aumx-bridge` worktree. No runtime correction was required after the final extraction.
- **Why:** The split changes ownership around pane launch/actions, Git worktrees, review handoff, and persisted pane state. Focused unit tests are insufficient evidence for release; real Electron, tmux, packaging, and built-application checks must also remain green.
- **How:** Verified the complete commit range against `main`, ran the configured no-vulnerability audits and deterministic release workflow, and checked source constraints and worktree cleanliness. The final release process exercised both macOS architectures and the packaged arm64 application.
- **Risk/compatibility:** No known regression or compatibility change remains. Code signing and notarization were intentionally disabled by the repository's package-smoke configuration; package contents and local packaged execution were still verified. The x64 packaged launch was correctly skipped on the arm64 host, while its archive contents were inspected.
- **Validation:** `pnpm verify:ci` passed internal-reference/version gates, typecheck, zero-warning lint, Knip, and 1,055 core tests with 2 skips. `pnpm --filter aumx-desktop test:coverage` passed 3,345 tests with 169 E2E skips at 78.06% statements/lines, 80.91% branches, and 80.07% functions. Final `pnpm run release:verify` found zero audit vulnerabilities and passed typecheck, lint, Knip, production build, 1,055 core tests/2 skips, 3,380 desktop tests/169 skips, feature E2E (marketplace 1/1, duel 3/3, Pi 1/1), stable E2E (61 passed/1 skipped), UI release 24/24, update 2/2, smoke 17 passed/1 skipped, clean x64 and arm64 package contents, stable arm64 packaged launch, and packaged TypeScript 7 LSP handshake. `git diff --check main...HEAD` passed.

## AumxBridge domain-split architecture closeout

- **Date/time:** 2026-08-23 16:58 UTC (completion)
- **Impact:** High — final ownership documentation and bounded lifecycle decision for the main-process bridge refactor.
- **What:** Updated the approved split specification and repository architecture guide with the implemented facade/domain boundaries. `AumxBridge` now delegates seven cohesive domains and remains the project lifecycle, mutation coordination, persistence, callback registry, and pane-activity runtime owner.
- **Why:** The final architecture must state both what moved and what deliberately did not. Pane activity was evaluated and retained because moving its service, three intervals, journal/liveness/transcript readers, boot registration, event publication, and teardown together would require a broad lifecycle redesign outside the behavior-preserving scope.
- **How:** Marked each implementation task complete, recorded final ownership and line-count outcome, and updated `AGENTS.md` so future changes route to the correct domain. No runtime code changed in this closeout entry.
- **Risk/compatibility:** Documentation only. The bounded activity deferral avoids splitting lifecycle ownership or changing interval/teardown ordering. `AumxBridge` decreased from 3,326 to 2,052 lines without using an arbitrary line target as a success condition.
- **Validation:** The post-extraction full desktop unit gate passed 3,353 tests with 169 explicit E2E skips. The post-extraction coverage gate passed 3,345 tests with 169 skips at 78.06% statements/lines, 80.91% branches, and 80.07% functions, improving all global ratios from the verified baseline of 77.76%, 80.68%, and 79.53%. Source scans confirmed no extracted domain imports `AumxBridge`, no production `any` or dynamic imports were introduced, and `git diff --check` passed.

## Pane-launch workflow extraction

- **Date/time:** 2026-08-23 16:55 UTC (completion)
- **Impact:** High — behavior-preserving extraction of agent-pane, terminal-pane, and duplicate-pane launch orchestration across agent discovery, Git bootstrap, tmux, early publication, persistence, and session tracking.
- **What:** Added `bridge/PaneLaunchWorkflow.ts`; `AumxBridge.createPane` still acquires `ProjectOperationCoordinator` and delegates only its unlocked body, while terminal creation and duplication remain stable facade methods. The workflow owns launch preflight, agent/default resolution, Git bootstrap, core pane creation inputs, watcher suspension, early emit/rollback callbacks, final publication, monitor refresh, hooks, and terminal-only launch.
- **Why:** Pane launch is the bridge's largest cohesive runtime transaction. Extracting the unlocked work behind an explicit port makes its preflight and rollback ordering directly testable without changing mutation ownership, nested coordinator behavior, config publication helpers, activity registration, tmux/session ownership, or title/session services.
- **How:** Injected domain-specific reads and callbacks for catalog/cache state, control/session/project identity, early/final pane publication, monitor and session tracking, transcript/title setup, watcher control, progress/toasts, lifecycle-adapter state, and experimental titles. Core launch, settings/profile resolution, Git bootstrap, and lifecycle hooks moved with the workflow. Duel and review continue to call the coordinated bridge facade.
- **Risk/compatibility:** High but controlled. Fullscreen and Git preflights still occur before watcher suspension; config/state publication still precedes watcher resume; core early rollback uses the same bridge persistence routine; agent-choice responses and Claude preflight flags are unchanged; terminal panes retain transcript and project metadata. Public method signatures and IPC contracts are unchanged.
- **Validation:** The six-case direct workflow suite was observed failing 6/6 against the typed skeleton, then passed 6/6 after implementation. The launch/project-switch/review/duel/pane-handler/IPC/runtime gate passed 311/311, desktop core/main/renderer typecheck passed, focused ESLint passed, and `git diff --check` passed.

## Pane-action workflow extraction

- **Date/time:** 2026-08-23 16:51 UTC (completion)
- **Impact:** High — behavior-preserving extraction of close, merge, rename, and registered-Claude fullscreen-resume action orchestration.
- **What:** Added `bridge/PaneActionWorkflow.ts`; the four public `AumxBridge` action methods now delegate and keep `ActionCallbackRegistry` serialization in the bridge. The workflow owns interactive-result decoration, post-close cleanup, merge-to-kanban completion, rename delegation, fullscreen eligibility, project revalidation, renderer-profile persistence, and exact-session resume.
- **Why:** Pane actions share an `ActionResult` transaction model and callback recursion but were interleaved with bridge lifecycle code. A dedicated workflow makes terminal success, callback chaining, cleanup timing, and fullscreen persistence ordering directly testable while leaving callback IDs and IPC serialization at the facade boundary.
- **How:** Injected action-context construction, pane/config/project reads, duel cleanup, transcript cleanup, tmux eligibility probes, transactional pane persistence, and the existing kanban completion callback. The fullscreen in-flight set remains shared with the bridge so project-switch/shutdown cleanup is unchanged.
- **Risk/compatibility:** High but controlled. Missing-pane errors still serialize with the same IPC `error` field; close cleanup waits for the terminal interactive result; kanban completion occurs only after the final merge success; fullscreen revalidates the project and session before mutation; and profile persistence still precedes agent resume. Public callback IDs and response shapes are unchanged.
- **Validation:** The six-case direct workflow suite was observed failing 6/6 against the typed skeleton, then passed 6/6 after implementation. The pane-action/project-switch/review/pane-handler/IPC gate passed 261/261, including the existing fullscreen concurrency and project-switch cases. Desktop core/main/renderer typecheck passed, focused ESLint passed, and `git diff --check` passed.

## Preserved-worktree workflow extraction

- **Date/time:** 2026-08-23 16:47 UTC (completion)
- **Impact:** High — behavior-preserving extraction of preserved-worktree discovery, inspection, removal, reopen, creation, and attachment paths that mutate Git, tmux, pane state, and persisted configuration.
- **What:** Added `bridge/WorktreeWorkflow.ts`; the six existing `AumxBridge` worktree methods remain stable facades and delegate. The workflow owns orphan filtering, IPC mapping, normalized-path concurrency guards, Git worktree creation/removal/inspection, reopen orchestration, pane metadata attachment, and live tmux directory changes.
- **Why:** Worktree operations form a cohesive high-integrity domain whose normalized-path lock and watcher/tmux ordering need direct tests. Extraction keeps project lifecycle, atomic config behavior, monitor ownership, transcript setup, and IPC mutation coordination in the bridge while making the transaction flow independently testable.
- **How:** Injected narrow callbacks for project/pane snapshots, best-effort pane replacement, reopen persistence, control-pane validation, watcher suspension, tmux operations, monitor restart, transcript/title setup, progress, and toasts. The workflow shares the bridge's existing `worktreeMutationPaths` set so switch/shutdown clearing and cross-operation exclusion are unchanged.
- **Risk/compatibility:** High but controlled. Path normalization and expected-state removal checks are unchanged; reopen still suspends the watcher only after discovery and always resumes it; create/attach still deliver `cd` directly to tmux and treat chdir failure as non-fatal; reopened panes still use the bridge's existing atomic-or-best-effort persistence routine. Public IPC and response contracts are unchanged.
- **Validation:** The six-case direct workflow suite was observed failing 6/6 against the typed skeleton, then passed 6/6 after implementation. Before extraction, the full desktop unit checkpoint passed 3,335 tests with 169 explicit E2E skips. After delegation, worktree/project-switch/review/pane-handler/IPC characterizations passed 261/261, desktop core/main/renderer typecheck passed, focused ESLint passed, and `git diff --check` passed.

## Review and fix-handoff workflow extraction

- **Date/time:** 2026-08-23 16:41 UTC (completion)
- **Impact:** High — behavior-preserving extraction of review snapshot launch and author fix-handoff transactions, including readiness revalidation and findings-file rollback.
- **What:** Added `bridge/ReviewWorkflow.ts`; `AumxBridge.startReviewAction` and `AumxBridge.startFixHandoffAction` now remain stable facade methods and delegate. The workflow owns review eligibility, in-flight deduplication, snapshot/diff preparation, reviewer launch, source/reviewer readiness revalidation, findings parsing/publication, prompt delivery, and durable handoff metadata.
- **Why:** Review is a cohesive transaction domain with security- and integrity-sensitive boundaries that were obscured inside the bridge. Moving it behind a narrow port makes readiness, file rollback, and commit ordering directly testable without moving IPC mutation locks, pane launch internals, project lifecycle, or persistence policy.
- **How:** Injected only cached agents, pane/session/activity reads, readiness-token capture/revalidation, pane launch, prompt delivery, best-effort pane replacement, progress, and project-root access. The bridge and workflow share the existing in-flight sets so project switch and shutdown retain their exact stale-lock cleanup. Git snapshot/diff and review artifact helpers moved with the domain.
- **Risk/compatibility:** High but controlled. IPC/shared response types are unchanged. Source and review panes are revalidated immediately before mutation, a recreated pane remains rejected, prompt delivery still precedes `handedOffAt` persistence, unpublished findings are deleted on send failure, no-issues reviews send no command, and legacy `.aumx` metadata-path resolution remains intact.
- **Validation:** The first five direct workflow cases were observed failing 5/5 against the typed skeleton, then passed after implementation; a sixth direct case covers concurrent-launch slot ownership. All 42 pre-existing bridge review/duel/command characterizations stayed green. The broader review/project coordinator/project-switch/pane-handler/terminal-handler/IPC gate passed 304/304 before the additional direct-only concurrency case; the final direct-plus-facade gate passed 48/48. Desktop typecheck rebuilt core and passed main/renderer, focused ESLint passed, and `git diff --check` passed.

## Duel workflow extraction

- **Date/time:** 2026-08-23 16:35 UTC (completion)
- **Impact:** Medium — behavior-preserving extraction of paired pane creation, linking, failure cleanup, and winner resolution from the main-process bridge.
- **What:** Added `bridge/DuelWorkflow.ts` and retained `AumxBridge.createDuelPanes` and `AumxBridge.resolveDuel` as facade methods. The workflow now owns request validation, Claude fullscreen preflight, paired launch metadata, survivor cleanup, linked-loser resolution, and duel metadata removal.
- **Why:** Duel orchestration is a cohesive transaction with explicit pane-launch, close-action, persistence, progress, and transcript-cleanup boundaries. Isolating it reduces bridge responsibilities while keeping project lifecycle and the lower-level pane launcher in the composition root.
- **How:** Injected narrow typed dependencies for pane creation/closure, action context, state snapshots, best-effort pane replacement, progress, project context, and transcript cleanup. Existing close-pane cleanup now calls the same workflow-owned metadata operation, so manual close and winner resolution retain one policy.
- **Risk/compatibility:** Medium. The public IPC and bridge contracts are unchanged, pane A remains usable without duel metadata if pane B fails, a loser-close failure still preserves both panes, and Claude fullscreen capability is still checked before either pane is launched. Progress calls and error response fields preserve their prior ordering and values.
- **Validation:** The five-case direct workflow suite was observed failing 5/5 against the typed skeleton, then passed 5/5 after implementation. The focused duel/review/project-switch/pane-handler/IPC/runtime gate passed 191/191; desktop typecheck passed for main and renderer; focused ESLint passed after removing the now-unused bridge slug import; and `git diff --check` passed.

## Historical pane-session catalog extraction

- **Date/time:** 2026-08-23 16:29 UTC (completion)
- **Impact:** Medium — behavior-preserving extraction of Claude, Codex, OpenCode, and Pi historical session listing from the main-process bridge.
- **What:** Added `bridge/PaneSessionCatalog.ts` and made `AumxBridge.listPaneSessions` a facade delegation. The catalog owns agent routing, OpenCode CLI listing, limit handling, placeholder-title rescue, and error normalization.
- **Why:** Historical session discovery is a cohesive stateless domain with its own external process and parser boundaries. Moving it removes child-process and four-agent parser knowledge from the bridge without touching live session boot or project lifecycle.
- **How:** Default dependencies retain the existing listers, OpenCode command/timeout/environment, parser rescue, title truncation, total count, and `formatError` response. Tests inject typed fakes for deterministic routing and failure coverage.
- **Risk/compatibility:** Low. The public bridge and IPC contracts are unchanged. OpenCode malformed or empty output still produces an empty successful list, and lister exceptions still produce the existing error response.
- **Validation:** The five-case catalog suite was observed red against the typed skeleton, then passed 5/5 after implementation; one intermediate red exposed an invalid placeholder fixture and was corrected to OpenCode's real timestamped placeholder format. The focused catalog/project-switch/pane-handler/IPC gate passed 218/218, desktop typecheck passed for core/main/renderer, focused ESLint passed, and `git diff --check` passed.

## Installed-agent catalog extraction

- **Date/time:** 2026-08-23 16:26 UTC (completion)
- **Impact:** Medium — behavior-preserving extraction of installed-agent cache, discovery coalescing, refresh, and project-switch reset from the main-process bridge.
- **What:** Added `bridge/AgentCatalog.ts` as the sole owner of cached agent identities and the in-flight executable probe. `AumxBridge` retains its public agent methods and delegates them to the catalog.
- **Why:** Agent availability is a cohesive stateful domain with concurrency and retry semantics that can be isolated without moving project lifecycle, persistence, or pane mutation boundaries.
- **How:** Preserved the existing cache reuse, explicit identity refresh, coalesced concurrent discovery, defensive result copies, capability filtering, and cache clearing during boot/project switch. Pane creation takes one stable catalog snapshot for agent selection and core launch; review checks read the current catalog.
- **Risk/compatibility:** Low to medium. Public facade and IPC methods are unchanged. The project-switch reset still clears only cached identity state and does not cancel an already-running global executable probe, matching prior behavior.
- **Validation:** The new five-case catalog suite was observed red against the typed unimplemented skeleton, then passed 5/5 after implementation. The focused bridge/IPC gate passed 268/268 across catalog, project coordinator, project switch, review, agent handlers, pane handlers, and IPC contracts. Desktop typecheck passed for core/main/renderer, focused ESLint passed, and `git diff --check` passed.

## Narrow bridge consumer ports

- **Date/time:** 2026-08-23 16:23 UTC (completion)
- **Impact:** Medium — behavior-preserving main-process dependency-boundary refactor; terminal activity and pane-summary runtime behavior are unchanged.
- **What:** `TerminalStreamService` and `PaneSummaryService` no longer depend on the full `AumxBridge` type. Each now declares the smallest local structural port it consumes.
- **Why:** These two reverse dependencies would otherwise make extracted bridge domains import the facade and create a type-level cycle. Narrow local ports establish the dependency direction used by the remaining split.
- **How:** Terminal streaming accepts only current-window lookup and terminal-activity recording. Pane summaries accept only pane lookup, activity snapshots, and normalized sessions; pane lookup now uses the bridge's existing `getPanes` facade rather than exposing `StateManager`.
- **Risk/compatibility:** Low. Runtime calls and callback ordering are unchanged, and no IPC, persistence, or lifecycle path moved. The production `AumxBridge` structurally satisfies both ports.
- **Validation:** Added characterization coverage for terminal activity forwarding and activity-derived pane start times. The pane-summary contract test was observed red against the old `getStateManager` dependency, then green after the port change. `pnpm exec vitest run --config vitest.config.ts __tests__/main/terminal-stream-service.test.ts __tests__/services/pane-summary.test.ts` passed 10/10; `pnpm typecheck` passed for core, desktop main, and renderer.

## AumxBridge domain-split specification

- **Date/time:** 2026-08-23 16:17 UTC (completion)
- **Impact:** Medium — approved architecture and test-first execution contract for a behavior-preserving split of the Electron main-process bridge; no runtime code, IPC contract, persisted data, or user-visible behavior changed.
- **What:** Added the repository specification for decomposing `AumxBridge` into cohesive agent, session, duel, review, worktree, pane-action, pane-launch, and activity domains while retaining the bridge as facade and project-lifecycle composition root.
- **Why:** `AumxBridge.ts` currently combines 3,326 lines of lifecycle orchestration and workflow logic. A written boundary and verification contract is required before moving high-risk project, tmux, persistence, and callback behavior.
- **How:** Recorded the current public and mutation-lock boundaries, persistence and teardown invariants, narrow dependency-port style, incremental extraction order, test-first cycle, rollback rules, and exact final verification commands in `docs/refactors/aumx-bridge-domain-split.md`.
- **Risk/compatibility:** Documentation only. The specification explicitly rejects a big-bang lifecycle move, a central god interface, an arbitrary line target, persistence redesign, and unproven race-policy changes.
- **Validation:** Verified the source worktree was clean before creating the isolated `codex/split-aumx-bridge` worktree. Pre-spec evidence from the source checkout was green: bridge-focused tests passed 255/255, desktop typecheck passed, and the full desktop coverage gate passed 3,331 tests with 77.76% statements/lines, 80.67% branches, and 79.53% functions.
## InteractiveTerminal split deep review and production closeout

- **Date/time:** 2026-08-23 18:22 UTC (completion)
- **Impact:** Medium — independently reviewed and hardened the timing-sensitive terminal split and its release verification without changing IPC, persistence, public imports, or successful terminal behavior.
- **What:** Three independent reviewers audited the branch for lifecycle correctness, test sufficiency, React quality, and unnecessary abstraction. The review found two related boot-reset defects: an already-waiting agent session could be overwritten by a later lifecycle reset during mount, and a reset while already booting could inherit the previous pane's soft, hard, and phase timers. It also identified brittle source-text overlay assertions and duplicate narrow-terminal text. Follow-up release gates exposed two unrelated test-infrastructure limits: the Duel viewport assertion allowed only Vitest's implicit one-second settle window, and real temporary-project Pi prompt cases inherited the generic five-second unit timeout.
- **Why:** The split moved a large imperative React lifecycle behind focused module boundaries. Production readiness required proving that effect ordering, pane changes, reconnects, timers, input locks, stream ownership, selection, resize serialization, and teardown remained correct under both direct tests and real Electron/tmux workloads, including loaded-machine timing.
- **How:** `useTerminalBoot` now performs an atomic reset against a synchronously tracked waiting-session ref and advances a reset epoch so every lifecycle reset restarts and re-evaluates its timer and activity effects. Red-first hook and public-component regressions cover initial waiting state and timer restart. Overlay styling assertions now render their real component, the narrow-terminal message has one model owner, and an unused pane parameter was removed. The Duel E2E keeps the exact 800x600 containment predicate but uses a bounded five-second poll that reports measured bounds; the Pi table uses a bounded 15-second timeout per filesystem-backed case. The split spec launches the hermetic runner through `pnpm exec node`, preserving the workspace binary path after the runner isolates `HOME`.
- **Risk/compatibility:** Runtime risk remains medium because boot/input timing is safety-sensitive, but the accepted fixes are renderer-internal and preserve the stable callback, attach, IPC, DOM, and public component contracts. The test hardening changes no assertions, skips, retries, cleanup, or production code. One full-gate terminal run encountered an unrelated transient modal intercept; the exact resize matrix then passed 3/3 and the complete terminal file passed 22/22 twice from the unchanged commit, so no masking workaround was added. Combined split-surface coverage improved over the pre-split baseline: statements/lines 93.41% (2,509/2,686) versus 92.16%, branches 86.95% (833/958) versus 85.60%, and functions 92.77% (77/83) versus 90.78%.
- **Validation:** Focused terminal validation passed 157/157 with TypeScript, focused ESLint, and `git diff --check` clean. Full coverage passed 3,357 tests with 169 skipped; repository totals were 77.87% statements/lines, 80.76% branches, and 79.60% functions. The Duel suite passed four consecutive fresh-home stress runs plus the final gate, and the 35-test Pi launch file passed three consecutive focused runs; the final loaded gate demonstrated Pi cases at 8.41 and 6.16 seconds, validating the bounded timeout. `codex review --base main`, two specialist lifecycle/simplicity reviews, and the final uncommitted follow-up review reported no remaining actionable findings. The final uninterrupted `pnpm run release:verify` passed: both audits found no known vulnerabilities; internal-reference, version, typecheck, ESLint, and Knip gates were clean; core passed 1,055 tests with 2 skipped; desktop passed 3,365 tests with 169 skipped; feature E2E passed 5/5; stable Electron E2E passed 61 with 1 intentional skip, including terminal resilience 22/22 and hidden detach 2/2; UI release passed 24/24; updater passed 2/2; smoke passed 17 with 1 skip; both x64 and arm64 ASARs were clean; the arm64 packaged launch was stable; and the packaged TypeScript 7 LSP handshake passed. Local signing and notarization were intentionally skipped because release credentials are not configured on this workstation.

## InteractiveTerminal split final verification

- **Date/time:** 2026-08-23 17:29 UTC (completion)
- **Impact:** Medium — completed and production-verified the behavior-preserving renderer architecture split of the release-critical interactive terminal.
- **What:** Finished the test-first decomposition of the 2,819-line `InteractiveTerminal.tsx` into an 80-line public composition facade, one imperative `useTerminalSession` owner, and focused overlay, deterministic-model, delayed-visibility, boot, search, and resize modules. Added direct unit/component coverage for every extracted seam while retaining the existing black-box terminal and Electron E2E contracts.
- **Why:** Terminal construction, tmux stream attachment, authoritative geometry, input gating, scrollback/selection, search, repaint, and teardown previously competed with visual composition in one file. The split makes independent responsibilities reviewable and testable without distributing tightly ordered attach/selection/cleanup state across forwarding-only abstractions.
- **How:** Established and committed the full pre-split coverage baseline, added lifecycle race characterizations before moving source, then extracted one responsibility at a time with a red/green test boundary and a focused validation commit. Construction, attachment, live selection coordination, and teardown deliberately remain together in `useTerminalSession`; all public timing constants, selectors, DOM order, IPC payloads, reconnect dependencies, and cleanup ordering remain compatible.
- **Risk/compatibility:** Medium because terminal lifecycle behavior is timing-sensitive, but the change is internal to the renderer and introduces no IPC, persistence, public import, styling, or product timing change. Post-split combined coverage improved over the original file: statements/lines 93.29% (2,502/2,682) versus 92.16%, branches 86.78% (827/953) versus 85.60%, and functions 92.77% (77/83) versus 90.78%. The remaining 2,156-line session owner is intentionally cohesive around one imperative xterm/tmux lifecycle; further splitting attachment or selection would duplicate ordering state and was deferred unless a genuine ownership seam emerges.
- **Validation:** The final `pnpm --filter aumx-desktop test:coverage` run passed 3,327 tests with 169 skipped and repository totals of 77.87% statements/lines, 80.75% branches, and 79.60% functions. The final uninterrupted `pnpm run release:verify` passed end to end: both audits found no known vulnerabilities; internal-reference, version, typecheck, ESLint, and Knip gates were clean; core passed 1,055 tests with 2 skipped; desktop passed 3,362 tests with 169 skipped; feature E2E passed marketplace 1/1, duel 3/3, and Pi 1/1; stable Electron E2E passed 61 tests with 1 intentionally skipped, including terminal resilience 22/22 and hidden-tab detach 2/2; UI release passed 24/24; update passed 2/2; smoke passed 17 with 1 skipped; x64 and arm64 ASARs were clean; the arm64 packaged launch was stable; and the packaged TypeScript 7 LSP handshake passed. Earlier complete-gate attempts exposed the separately documented pre-existing accessibility shutdown hang and transient timing failures while other worktrees drove system load above 70; the exact affected tests passed immediately without product changes once contention was removed, and the final gate then passed from the unchanged committed source tree.

## Accessibility E2E bounded shutdown cleanup

- **Date/time:** 2026-08-23 16:59 UTC (completion)
- **Impact:** Low — test-infrastructure reliability correction; no runtime, product, IPC, persisted-data, visual, or accessibility behavior changed.
- **What:** Updated `ui-accessibility.e2e.test.ts` to close Electron through the shared bounded `closeElectronApp` helper instead of awaiting Playwright's raw `app.close()` indefinitely.
- **Why:** The complete release gate passed all 24 UI assertions but reproducibly timed out in this suite's 30-second `afterAll` hook. Diagnostics proved renderer reset and fleet cleanup completed and the stall occurred in `app.close()`. The same failure reproduced on the untouched original `21992b0` worktree, confirming it pre-dated and was independent of the terminal split.
- **How:** Imported the existing E2E helper used by the app, terminal, sidebar, file-browser, duel, Pi, and attention suites. It requests a normal Electron quit, waits for process exit, and sends a bounded `SIGTERM` only if the process remains alive. No timeout was increased and no assertion was changed or skipped.
- **Risk/compatibility:** Test-only and low risk. Graceful quit remains the first path; the fallback only prevents a teardown-only process stall from failing a fully completed suite and leaking the Electron child.
- **Validation:** The accessibility suite failed twice in the split worktree and once at the untouched original HEAD with all 7 tests passing followed by the same raw-close hook timeout. After the one-line cleanup-path correction, `AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs --files __tests__/e2e/ui-accessibility.e2e.test.ts -- pnpm exec vitest run --config vitest.config.ts --no-file-parallelism` passed 7/7 in 13.00 seconds, and focused ESLint passed with zero warnings.

## InteractiveTerminal session ownership split

- **Date/time:** 2026-08-23 16:43 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer architecture change that separates the public terminal composition surface from its imperative xterm session owner.
- **What:** Moved terminal construction, stream attachment, input, selection, and teardown orchestration into `interactive-terminal/useTerminalSession.ts`; `InteractiveTerminal.tsx` is now an 80-line public façade that composes the terminal host, overlays, context menu, link prompt, and find overlay.
- **Why:** The stable public component previously mixed application presentation with the one lifecycle that must preserve strict xterm/tmux ordering. The new boundary makes visual composition reviewable without entering the imperative session and keeps exactly one owner for construction, authoritative attach, live selection coordination, and idempotent cleanup.
- **How:** The session hook returns a typed inferred view model of refs, presentation state, and stable actions. Existing public constants are re-exported from the façade, and the explicit reconnect dependency contract moved intact with the lifecycle. Attach and selection were deliberately retained within this owner: their pending-output, authoritative-geometry, alternate-screen, repaint, and teardown ordering is tightly coupled, and separate forwarding-only controllers would not establish independent ownership.
- **Risk/compatibility:** Medium. This is a mechanical ownership move with no IPC, timing, persisted data, DOM selector, accessibility, styling, or public import change. The public façade still renders the same elements in the same order and passes the same callbacks. The lifecycle continues to exclude unrelated whole-pane updates from its reconnect contract.
- **Validation:** `pnpm --filter aumx-desktop typecheck` passed both TypeScript projects. `cd desktop && pnpm exec vitest run __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx __tests__/hooks/use-terminal-boot.test.ts __tests__/hooks/use-terminal-resize.test.ts __tests__/hooks/use-terminal-find.test.ts --no-file-parallelism` passed 138/138. Focused ESLint for the façade and session hook passed with zero warnings, `git diff --check` passed, and repository searches confirmed the three public timing constants remain available through the original module. The first complete coverage run reached 3,326 passing tests and exposed one source-ownership assertion that still read the old façade for overlay contrast classes; the test now reads `TerminalOverlays.tsx`, its real owner, and passes 9/9 in isolation with focused ESLint clean. No product assertion was weakened.

## InteractiveTerminal resize lifecycle extraction

- **Date/time:** 2026-08-23 16:40 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer hook extraction for terminal fitting, geometry delivery, retry serialization, and resize signal ownership.
- **What:** Extracted fitting and resize coordination from `InteractiveTerminal.tsx` into `useTerminalResize`, reducing the component from 2,384 to 2,192 lines.
- **Why:** Geometry measurement, debouncing, latest-only IPC serialization, bounded retries, attach gating, and browser layout signals form one state machine. Keeping those refs and effects beside input and selection logic made cleanup and stale-response safety difficult to audit.
- **How:** The hook owns fit failure classification, agent minimum sizing, fixed-column measurement, the 150 ms debounce, one in-flight resize with a latest-only queue, three-attempt rejection handling, applied/sent geometry bookkeeping, window/visibility/device-pixel-ratio/pane-count signals, and reset invalidation. Its small attach boundary records pending and authoritative geometry without taking ownership of stream attachment.
- **Risk/compatibility:** Medium. Geometry affects full-screen terminal correctness, so the existing constants, fail-closed narrow handling, retry count, attach-before-resize ordering, renderer refresh rules, and resize IPC payload are retained. Reset now also advances an internal request generation, making stale promise completion explicitly inert; this strengthens the existing pending-request identity guard without changing successful behavior.
- **Validation:** The new hook test was first observed red because the module did not exist. Its final two cases prove debounce/latest-only serialization and obsolete-response rejection after reset. `pnpm --filter aumx-desktop typecheck` passed. `cd desktop && pnpm exec vitest run __tests__/hooks/use-terminal-resize.test.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx --no-file-parallelism` passed the existing 130 component cases; after correcting test-only mount timer interference, the direct hook suite passed 2/2. Focused ESLint passed with zero warnings, and `git diff --check` passed.

## InteractiveTerminal boot lifecycle extraction

- **Date/time:** 2026-08-23 16:36 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer hook extraction for startup readiness, prompt handoff, input gating, and boot timeouts.
- **What:** Extracted the agent startup state machine from `InteractiveTerminal.tsx` into `useTerminalBoot`, reducing the component from 2,494 to 2,384 lines.
- **Why:** Boot detection has independent state, timers, output-tail parsing, and activity/session inputs. Giving it one owner prevents readiness, prompt, and timeout rules from drifting across the xterm session effect and unrelated component effects.
- **How:** The hook now owns the bounded output tail, minimum-ready floor, trust/input-prompt pause and resume, soft input-unlock timeout, hard overlay timeout, activity-idle completion, boot phase progression, and timer cleanup. The terminal lifecycle retains xterm input locking and stream wiring through stable callbacks, including the existing quiet-TUI readiness poll.
- **Risk/compatibility:** Medium. Startup ordering and input safety are user-visible and timing-sensitive, so the implementation keeps the existing 200 ms readiness floor, 15-second soft timeout, 45-second hard timeout, 6,000-character tail, prompt detection, attach-before-unlock guard, and pane-reconnect reset semantics. No IPC, persisted data, terminal API, or public component contract changed.
- **Validation:** The four-case hook test was first observed red because the module did not exist, then passed after implementation. `pnpm --filter aumx-desktop typecheck` passed both TypeScript projects. `cd desktop && pnpm exec vitest run __tests__/hooks/use-terminal-boot.test.ts __tests__/interactive-terminal-copy.test.tsx --no-file-parallelism` passed 120/120. Focused ESLint for the component, hook, and test passed with zero warnings. `git diff --check` passed.

## InteractiveTerminal search extraction

- **Date/time:** 2026-08-23 16:31 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer hook extraction for terminal search state, decorations, focus transfer, and result normalization.
- **What:** Extracted Cmd/Ctrl+F state and addon interaction into `useTerminalFind`, reducing `InteractiveTerminal.tsx` from 2,581 to 2,494 lines.
- **Why:** Search has its own query, case, result, focus, and decoration lifecycle but does not own xterm construction or stream attachment. Isolating it removes four local states, three mirror refs, six effects/callbacks, and addon-specific error handling from the terminal session owner.
- **How:** The hook owns open/reopen/close behavior, current-query and case refs for xterm callbacks, live accent resolution, complete decoration options, next/previous dispatch, result-index normalization, terminal blur/focus transfer, and exception containment through `rendererLog`. The xterm lifecycle still creates and disposes `SearchAddon`; it now forwards result events and the keyboard shortcut through stable hook callbacks.
- **Risk/compatibility:** Low. The addon instance remains session-owned, the same six decoration colors are supplied, result indexes remain one-based in the UI, and closing still clears query/decorations and refocuses xterm. The first hook implementation run exposed missing `blurTerminal` dependencies in the new test setup, not production behavior; the setup was corrected. Focus callback dependencies were made explicit after focused ESLint enforced the repository hook rule.
- **Validation:** The hook test was first observed red because the target module did not exist. `cd desktop && pnpm exec vitest run --config vitest.config.ts __tests__/hooks/use-terminal-find.test.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx` passed 132/132. `pnpm --filter aumx-desktop typecheck` passed. Focused ESLint for the component, hook, and test passed with zero warnings after the dependency correction. `git diff --check` passed.

## InteractiveTerminal delayed-visibility extraction

- **Date/time:** 2026-08-23 16:27 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer hook extraction for terminal hidden-tab stream retention.
- **What:** Extracted the hidden-terminal grace-period state and timer into `useDelayedTerminalVisibility` while preserving the public `TERMINAL_HIDDEN_DETACH_DELAY_MS` contract.
- **Why:** Delayed visibility is an independent React lifecycle with one input, one timer, and one output. Isolating it makes the quick-tab retention rule directly testable and removes another timer owner from the terminal component.
- **How:** Added a hook that immediately promotes visibility, delays demotion, and cancels pending demotion on dependency change or unmount. `InteractiveTerminal` now consumes its boolean output exactly where the xterm lifecycle effect previously consumed local state.
- **Risk/compatibility:** Low. The delay remains 2,500 ms, the initial state still follows the prop, and the effect cleanup remains `clearTimeout`. No xterm, attach, detach, or selection logic moved.
- **Validation:** The hook test was first observed red because the target module did not exist. `cd desktop && pnpm exec vitest run --config vitest.config.ts __tests__/hooks/use-delayed-terminal-visibility.test.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx` passed 132/132. `pnpm --filter aumx-desktop typecheck` passed main and renderer TypeScript projects.

## InteractiveTerminal overlay extraction

- **Date/time:** 2026-08-23 16:26 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer component extraction; boot, empty-session, reconnecting, and failure presentation moved behind a typed presentational boundary.
- **What:** Extracted the terminal overlay JSX into `interactive-terminal/TerminalOverlays.tsx`, reducing `InteractiveTerminal.tsx` from 2,683 to 2,581 lines while retaining its host, menus, link prompt, search overlay, and imperative lifecycle.
- **Why:** The overlay markup has no ownership of xterm, tmux streams, stores, or timers. Moving it removes visual and accessibility detail from the lifecycle implementation and makes its UI contract independently reviewable.
- **How:** Added a prop-only component for boot phase text, fullscreen empty state, passive reconnect status, and actionable failure alerts. The public component computes the same conditions and passes them through; all existing test IDs, roles, aria attributes, classes, colors, labels, and reconnect callback behavior remain unchanged.
- **Risk/compatibility:** Low. No effect dependencies, state transitions, timing, terminal APIs, or DOM selectors changed. The new test initially failed at collection because the module did not exist, then a first implementation run exposed the test file's missing React JSX import; adding the standard test import made the independent component suite green without production changes.
- **Validation:** `cd desktop && pnpm exec vitest run --config vitest.config.ts __tests__/components/terminal-overlays.test.tsx __tests__/shared/interactive-terminal-model.test.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx` passed 139/139. `pnpm --filter aumx-desktop typecheck` passed main and renderer TypeScript projects. `git diff --check` passed.

## InteractiveTerminal deterministic model extraction

- **Date/time:** 2026-08-23 16:23 UTC (completion)
- **Impact:** Medium — behavior-preserving renderer refactor; terminal geometry, palette, sizing, failure-title, and selection-accumulation implementations moved without changing public behavior or contracts.
- **What:** Extracted the deterministic terminal model from `InteractiveTerminal.tsx` into `interactive-terminal/terminal-model.ts`, reducing the public component by 136 net lines and giving the calculations an independent small-test boundary.
- **Why:** Font sizing, overlay palette resolution, geometry equality, pointer-to-cell mapping, range clipping, failure headings, and guarded selection accumulation do not need React or xterm lifecycle ownership. Keeping them inside the imperative component obscured the high-risk lifecycle code and forced these rules through a large component harness.
- **How:** Added a typed internal model module and moved existing implementations unchanged. The public component imports the model contracts and continues to export its existing public surface. Added direct tests for shell/agent font sizing, palette resolution, size comparison, failure headings, pointer clipping, forward/reverse ranges, and empty ranges.
- **Risk/compatibility:** Low. No timing, API call, store subscription, effect dependency, rendering, or cleanup changed. The selection accumulation limit remains 2 MiB and all previous component tests remain black-box coverage. One initial range expectation in the new test incorrectly omitted the inclusive final clipped row width; the expected value was corrected to the implementation's existing 1,920-cell contract before the green run.
- **Validation:** The new test was first observed red because the target module did not exist. `cd desktop && pnpm exec vitest run --config vitest.config.ts __tests__/shared/interactive-terminal-model.test.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx` then passed 136/136. `pnpm --filter aumx-desktop typecheck` passed main and renderer TypeScript projects. `git diff --check` passed.

## InteractiveTerminal lifecycle characterization coverage

- **Date/time:** 2026-08-23 16:20 UTC (completion)
- **Impact:** Low — test-only lifecycle contract coverage; no runtime, IPC, persisted-data, or user-visible behavior changed.
- **What:** Added four black-box component cases that lock the live terminal's preservation, reconnection, and asynchronous teardown behavior before source extraction begins.
- **Why:** The split must not turn runtime-only store updates or pane metadata edits into terminal reconnects, and unmount must win races against font loading and authoritative attach responses without late side effects.
- **How:** Extended the existing public `InteractiveTerminal` suite to prove that activity/session/copy/bell updates retain one xterm instance, prompt-only pane changes retain the instance while transcript changes replace it exactly once, a pending font load cannot open or attach after unmount, and a late attach response cannot unlock or mark an unmounted pane attached.
- **Risk/compatibility:** Test-only. Assertions target observable lifecycle outcomes through the stable component API and stores, not the planned internal module shape.
- **Validation:** `cd desktop && pnpm exec vitest run --config vitest.config.ts __tests__/interactive-terminal-copy.test.tsx __tests__/terminal-attach-retry.test.tsx __tests__/terminal-hidden-detach.test.tsx` passed 130/130. `pnpm --filter aumx-desktop typecheck` passed both main and renderer TypeScript projects.

## InteractiveTerminal pre-split coverage baseline

- **Date/time:** 2026-08-23 16:19 UTC (completion)
- **Impact:** Low — validation evidence only; no runtime, source, test-contract, IPC, persisted-data, or user-visible behavior changed.
- **What:** Established the complete green pre-refactor baseline required before splitting `InteractiveTerminal.tsx`.
- **Why:** The component owns terminal initialization, live stream attachment, geometry, boot gating, input, selection, search, and teardown. High measured coverage and a clean repository baseline are required to distinguish extraction regressions from pre-existing behavior.
- **How:** Installed the checksum-locked workspace dependencies, generated the repository-owned agent documentation through the normal core build, ran complete desktop coverage, inspected the per-file V8 summary for `InteractiveTerminal.tsx`, and ran the complete core suite.
- **Risk/compatibility:** None. Coverage output and generated sources are ignored artifacts. No tracked implementation or test files changed.
- **Validation:** `pnpm build` passed. `pnpm --filter aumx-desktop test:coverage` passed 3,304 tests with 169 skipped E2E cases and repository totals of 77.76% statements/lines, 80.67% branches, and 79.53% functions. `InteractiveTerminal.tsx` measured 92.16% statements/lines (2,234/2,424), 85.60% branches (785/917), and 90.78% functions (69/76). `pnpm test` passed the core suite with 1,055 tests and 2 skipped. The first coverage invocation on the fresh worktree failed before collecting 35 suites because the generated agent-doc module had not yet been built and parallel imports raced Electron's first binary download; the supported `pnpm build` step generated the module, the Electron install completed, and the subsequent complete coverage run passed without product changes.

## InteractiveTerminal responsibility-split specification

- **Date/time:** 2026-08-23 16:15 UTC (completion)
- **Impact:** Low — planning and test-gate documentation only; no runtime, test, IPC, persisted-data, or user-visible behavior changed.
- **What:** Added the reviewed implementation specification for splitting the 2,819-line renderer `InteractiveTerminal.tsx` into cohesive terminal lifecycle, boot, resize, attach, search, selection, visibility, model, and overlay responsibilities while retaining its public facade.
- **Why:** The terminal is a release-critical boundary with tightly ordered xterm, tmux-stream, resize, input, and selection cleanup. A checked-in contract makes the behavior-preservation rules, test-first order, ownership model, and production-readiness gates explicit before source changes begin.
- **How:** Documented the objective, stack, exact validation commands, target structure, coding boundaries, test strategy, and measurable success criteria in `INTERACTIVE_TERMINAL_SPLIT_SPEC.md`.
- **Risk/compatibility:** None. Documentation only. The target module list is deliberately conditional on finding real ownership seams so the refactor does not replace one large file with forwarding-only abstractions.
- **Validation:** Inspected the current terminal implementation, its callers, existing unit/component/E2E coverage, project commands, and repository engineering rules. No executable validation was required for this documentation-only slice; the next slice establishes the pre-change full test and coverage baseline.
## Release-hardening readability pass

- **Date/time:** 2026-08-23 15:51 UTC (completion)
- **Impact:** Medium — behavior-preserving refactor of the renderer's move-remap read coordination and the release E2E runner; no API, persisted-data, test-contract, or user-visible behavior changed.
- **What:** Simplified the two complexity seams introduced by the release-hardening work. Open-file remapping now calls a named `invalidateOpenFileRead` operation instead of spelling out request-generation, pending-promise, extras cleanup, and viewer-position capture inline. The E2E runner now keeps its fake-agent names/script at module scope and delegates disposable-home provisioning to `configureFakeAgents`, leaving `runIsolated` focused on tmux/process lifecycle. Request and promise locals were expanded from `reqId`/`read` to `requestId`/`readPromise`, and redundant existence checks before forceful temporary-directory cleanup were removed.
- **Why:** These changes reduce the mental context needed to verify two important invariants: a remapped editor invalidates exactly one old read while preserving viewer extras, and fake-agent provisioning is separate from command execution/cleanup. The transactional filesystem and tab-dedup algorithms were reviewed but intentionally left unchanged because they were already explicit and further compression would make their safety rules harder to follow.
- **How:** Refactored only code materially changed by commit `6a83cd3`; tests and behavior were not modified. `rmSync(..., { force: true, recursive: true })` retains the previous missing-path-tolerant cleanup semantics.
- **Risk/compatibility:** Low. The same maps are mutated in the same order before renderer state publication, the same fake shell script bytes and environment variables are installed, and the same owned temporary paths are removed in `finally`. No error handling or rollback path was removed.
- **Validation:** `pnpm exec vitest run --config vitest.config.ts __tests__/file-move-orchestration.test.ts __tests__/stores/file-browser.store.test.ts` passed 32/32; `pnpm exec vitest run scripts/run-desktop-e2e.test.mjs` passed 6/6; `pnpm --filter aumx-desktop test:e2e:features` passed marketplace 1/1, duel 3/3, and Pi 1/1; `pnpm --filter aumx-desktop typecheck`, `pnpm run lint:ci`, `node --check scripts/run-desktop-e2e.mjs`, and focused ESLint passed. Final `pnpm run release:verify` passed end to end: zero audit findings, typecheck/lint/Knip/build clean, core 1,069 passed/2 skipped, desktop 3,339 passed/169 skipped, feature and stable E2E clean, UI release 24/24, update 2/2, smoke 17 passed/1 skipped, both app packages clean, arm64 packaged launch stable, and the packaged TypeScript 7 LSP handshake passed. An initial `node --test scripts/run-desktop-e2e.test.mjs` invocation was inapplicable because the file is a Vitest suite and failed before collecting tests; it was replaced by the correct Vitest command above.

## Release hardening plan v2 implementation

- **Date/time:** 2026-08-23 15:29 UTC (completion)
- **Impact:** High — filesystem publication and open-editor integrity changed at runtime; release CI gained credentialed external-agent gates; the deterministic release gate now includes previously excluded feature E2E.
- **Scope:** Completed items 1.1–3.2 from `.tmp/a_v3/review_v1.md`. The intentionally opportunistic item 2.4 remains incremental: this work did not touch a cohesive `AumxBridge` workflow and therefore did not perform the explicitly rejected big-bang split.

### 1.1 — Transactional, no-clobber copy and directory-move publication

- **What/why:** A failed recursive copy could leave a partial final destination, while `rename()` could replace an empty directory created after preflight. Both violated the file browser's no-clobber contract.
- **How:** `desktop/src/main/ipc/file-move.ts` now copies into an owned sibling `mkdtemp` directory and publishes with no-clobber primitives: `link()` for files, `symlink()` for links, and `mkdir()` reservation plus `rename()` for directories. Directory moves use the same reservation. Cleanup is limited to the owned staging tree and an empty owned reservation; it never recursively removes a raced-in final path.
- **Risk/compatibility:** Cross-device behaviour is unchanged for directory moves. A failed reservation cleanup deliberately leaves a non-empty path alone because it may contain external data. The helper remains local rather than introducing a generic transaction layer.
- **Validation:** `cd desktop && pnpm test -- file-move-handler file-browser.store` passed 30 tests. Added and passed EACCES/FIFO partial-copy cleanup, staging-name isolation, file and directory lost-race, and directory-move lost-race cases. The final full gate passed all 3,339 desktop tests.

### 1.2 — Open-file read invalidation during move remapping

- **What/why:** A source read resolving after a move could restore the old path in renderer state and let the editor recreate the source on its next save.
- **How:** `desktop/src/renderer/stores/file-browser.store.ts` now invalidates the old request generation and pending-read metadata, remaps state, and reloads the destination while retaining `highlightQuery` and `scrollToLine`. The destination reload uses an internal read path that deliberately bypasses the already-completed pre-move flush; calling the public `openFile` action here would flush a stale source-bound editor again.
- **Risk/compatibility:** Unrelated moves do not invalidate a read. Reload failures settle `loading` and retain the destination identity with an explicit viewer error.
- **Validation:** Deferred-source, destination-content, viewer-extra, loading, and unrelated-remap tests passed. `cd desktop && pnpm test -- file-move-orchestration stores/file-browser.store` passed 32 tests. An initial complete gate exposed a real second-flush regression (`flush, move, flush` instead of `flush, move`); the internal read helper fixed it, and the final gate passed the corrected orchestration test.

### 1.3 — Complete multi-file E2E postconditions

- **What/why:** The shift-click and drag cases polled only destination names, relied on directory iteration order, and checked source removal outside the retry window.
- **How:** Both cases now use one `expect.poll` over sorted destination names and the absence of every source.
- **Risk/compatibility:** Test-only synchronization change; no sleep or weakened assertion was added.
- **Validation:** `desktop/__tests__/e2e/file-browser.e2e.test.ts` passed all 14 cases in every stable run, including the two corrected multi-file cases.

### 1.4 — Fixed-grid zoom-cycle investigation

- **What/why:** The externally reported pane loss was treated as an unconfirmed release-gate signal and investigated in isolation and in the complete stable suite.
- **How:** The settings, window lifecycle, config hydration, and isolated tmux ownership paths were exercised. No product or synchronization defect reproduced, so no speculative retry or runtime change was added.
- **Risk/compatibility:** Classified as environmental/non-reproduced from observed evidence, not silently accepted on one rerun.
- **Validation:** The isolated fixed-grid case passed; `pnpm test:e2e:stable` then passed three consecutive complete runs. The final no-retry `release:verify` supplied a fourth complete pass, with `keeps a fixed-grid terminal exact and unclipped across responsive Fleet breakpoints` completing in 2.809 seconds (the preceding three were approximately 2.6–2.8 seconds).

### 2.1 — Tab deduplication after path remapping

- **What/why:** A moved source tab could remap onto a stale destination tab, producing duplicate IDs, React keys, and ambiguous close/active behaviour.
- **How:** `workspace-tabs.store.ts` deduplicates by final ID, prefers the tab that was actually moved, preserves tab order, and remaps the active ID.
- **Risk/compatibility:** Only colliding final IDs are coalesced; ordinary remaps preserve existing behaviour.
- **Validation:** `cd desktop && pnpm test -- workspace-tabs.store` passed 18 tests, including stale-destination precedence, nested directory remaps, and active-tab preservation.

### 2.2 — Hermetic feature E2E in the release gate

- **What/why:** Marketplace, duel, and Pi application flows were absent from CI, and the existing marketplace integration fixture was unsafe to enable because it used the real home configuration.
- **How:** `scripts/run-desktop-e2e.mjs` can create a disposable home and deterministic fake Claude/Codex/OpenCode/Pi executables. `test:e2e:features` runs the duel and Pi suites plus a new local-git marketplace test that browses, previews, installs, verifies, and uninstalls through real IPC under isolated Claude, Codex, and OpenCode destinations. `AUMX_E2E_USER_DATA_DIR` gives this fixture an explicit isolated registry. The feature group is now part of `release:verify`.
- **Risk/compatibility:** Fake agents verify application orchestration, not upstream CLI compatibility; that boundary is separately covered by 2.3. Disposable home and tmux paths are always removed in runner cleanup.
- **Validation:** `pnpm test:e2e:features` passed five cases: marketplace 1, duel 3, and Pi 1. It also passed inside the final complete release gate.

### 2.3 — Stable/latest live compatibility canaries and release enforcement

- **What/why:** Only Claude had a credentialed compatibility job even though Claude, Codex, OpenCode, and Pi are supported external CLI boundaries.
- **How:** Nightly CI now installs all four CLIs in an isolated stable/latest matrix, records resolved versions, uses an isolated home and explicit model, and runs a common launch → response → idle/waiting → follow-up → settle → close canary. Stable jobs determine workflow success; latest jobs are non-blocking and open a deduplicated regression issue. Publish fails closed unless the newest completed Nightly E2E run for the exact release SHA succeeded. Workflow contract tests cover the matrix and release gate.
- **Risk/compatibility:** Stable pins are Claude's `stable` channel, Codex 0.149.0, OpenCode 1.18.21, and Pi 0.84.2; latest intentionally floats. CI requires the documented model variables and test API-key secrets. Credentialed live calls were not run locally because release credentials are intentionally unavailable; the canary compiled and skipped behind its explicit gate, and nightly CI owns operational execution.
- **Validation:** `__tests__/scripts/ci-workflows.test.ts` passed all 4 tests, all three modified workflow YAML files parsed, desktop typecheck passed, and the canary test loaded successfully in the 3,339-test desktop suite.

### 2.4 — `AumxBridge` extraction policy retained

- **What/why/how:** No unrelated bridge workflow was extracted. The plan explicitly makes decomposition opportunistic and requires characterization tests before a cohesive extraction; manufacturing a refactor in release hardening would add risk without reducing the changed surface.
- **Risk/compatibility:** Deferred by design, with no runtime impact and no fixed-schedule debt claim.

### 3.1 — Enforced React hook dependency analysis

- **What/why:** Future stale closures were invisible because only `rules-of-hooks` was enabled.
- **How:** `react-hooks/exhaustive-deps` is now an error. All 15 findings were resolved with correct dependencies or stable selectors. The CodeMirror file-lifecycle effect and two terminal connection/lifecycle effects retain narrow, reasoned suppressions because adding ordinary props would destroy editor state or reconnect the PTY.
- **Risk/compatibility:** No broad disable was introduced. Terminal pane dependencies explicitly remain excluded where a pane object change would reconnect a live session.
- **Validation:** `pnpm run lint:ci` passed with zero warnings, both standalone and inside the final release gate; desktop typecheck, tests, and build remained green.

### 3.2 — Narrowed legacy `agentStatus` exception boundary

- **What/why:** Seventeen files were exempt from the raw legacy-status read ban even though only two justified reads remained.
- **How:** The ESLint allowlist now contains only `AumxBridge.ts` for persistence-boundary cleanup detection and `SupportBundleService.ts` for diagnostic evidence. Both reads have inline justification; live decisions continue to use `PaneActivity`.
- **Risk/compatibility:** Static guard only; runtime behaviour is unchanged.
- **Validation:** `pnpm run lint:ci` passed with zero warnings, proving the other 15 exemptions were unnecessary.

### Complete release evidence

The required final `pnpm run release:verify` passed end to end once without retries after the implementation fixes:

```text
dependency/security audits                    pass, 0 vulnerabilities
internal references/version alignment         pass
typecheck, ESLint, Knip, production build     pass
core Vitest                                   1,069 passed, 2 skipped
desktop Vitest                                3,339 passed, 169 skipped
feature E2E                                   5 passed
stable E2E                                    app 17 passed/1 skipped; app-quit 1;
                                              file-browser 14; terminal-resilience 22;
                                              sidebar-resize 5; hidden-tab detach 2
UI release E2E                                24 passed
application update E2E                       2 passed
desktop smoke                                 17 passed, 1 skipped
package smoke                                 x64 + arm64 app.asar clean (1,538 entries each);
                                              arm64 launch stable; TypeScript 7 LSP handshake passed
```

Two earlier full-gate attempts were triaged rather than accepted on rerun: the first found a new test regex that violated `no-regex-spaces`; the second found the post-move duplicate flush described in 1.2. Both causes were fixed before the single final clean run. Local package smoke intentionally disabled code signing and skipped notarization because release credentials were not configured; signed/notarized release behaviour remains the publish workflow's responsibility.

## File tree multi-select, move undo, and an editor picker

- **Date/time:** 2026-08-23 11:00 UTC (completion)
- **Impact:** Medium — new renderer store for the undo stack, a wider selection model in the tree, and a shared editor-detection cache that replaces per-mount probing.
- **What:** Shift and Cmd/Ctrl click select several entries, and dragging any selected row drags the whole selection. ⌘Z moves the last batch back where it came from. The entry context menu's "Open in Editor" became an "Open in" submenu listing up to five editors detected on the machine.
- **Why:** These were the three gaps left by the drag & drop work: a batch channel that only ever received one path, a move with no way back, and a hard-coded launch that ignored which editor the user actually uses.
- **How:** `useFileTreeSelection` owns an anchor plus a path set and exposes `pathsFor(path)` — the whole selection when the row is part of it, that row alone otherwise — so drag, copy, cut, and delete needed no multi-select branches of their own. `useFileTreeCommands` resolves each verb through it and is the single place row-scoped actions are built. Undo records `{from, to}` per item in `file-undo.store.ts`, then inverts a batch by grouping items by their original parent and issuing one `FILE_MOVE` per group — the channel takes a single destination, and a selection can span folders. Editor detection moved behind `useInstalledEditors`, a module-level promise shared with the existing `OpenInEditorButton`, which previously re-probed on every mount.

### Review fixes

A five-reviewer pass over this change found seven defects, all fixed here and each covered by a test that is red without the fix:

- **Cmd-clicking a row out of a selection collapsed the selection onto that row.** `handleRowSelect` focused the row it was deselecting, and the focus-follows-selection effect then saw a focused row that was no longer selected and rebuilt the selection around it. Select `a`, `b`, `c`, Cmd-click `a` to drop it, and the selection became `{a}` — a following Cmd-X or Delete acted on exactly the wrong file. Deselecting no longer moves the focus.
- **The selection survived a pane switch and re-bound to same-named files in another worktree.** `FileTree` has no `key` on `rootPath`, so it never remounts; paths are root-relative, and the prune effect only drops paths absent from the current rows. Returning to a pane with a cached tree kept the old selection pointing at the new worktree's copies, where a batch delete would take them. The selection is now cleared per root, alongside the cut clipboard and the inline create.
- **A failed undo consumed its stack entry, so the next ⌘Z reverted an older, unrelated batch.** Worse under key auto-repeat: each repeat popped an entry and was refused by the in-flight guard, draining the whole stack while one move was actually reverted. The guard is now checked before popping, and an undo that restores nothing puts its entry back.
- **A partial undo was reported as a complete one.** `moveEntries` resolved a boolean, and the caller credited the whole group when any single item came back — with `silent: true` suppressing the per-item detail. It now resolves a count rather than a boolean.
- **`partial` results were pushed onto the undo stack.** A `partial` leaves the source in place, so moving the target back always collides with it. Only `succeeded` moves are recorded.
- **Multi-select delete was the one batch verb that never normalized its paths**, so selecting a folder together with something inside it trashed the folder and then reported a spurious `ENOENT` for the child — the exact failure `normalizeOperationPaths` exists to prevent, made reachable by multi-select. The confirm dialog counts the normalized set too.
- **The deleted-on-disk gate suppressed genuine deletions during a copy.** `activeMove` is set for both modes, but only a move unlinks its source; `ActiveFileMove` now carries the mode and the gate applies to moves alone.

A second review pass over the finished feature added eight more, six behavioural and two structural:

- **The tree declared `role="tree"` without `aria-multiselectable`**, so several rows carrying `aria-selected="true"` was invalid ARIA and a screen reader announced only the focused row — a user could press ⌘⌫ believing one file was targeted while three were.
- **Undo counted a `partial` restore as a clean one.** `moveEntries` resolved the settled count, which deliberately includes `partial`; it now resolves the succeeded count, so a restore that left the file in both places reports failure and keeps its undo entry. The same change stops a paste that never vacated its source from consuming the cut clipboard.
- **The focus-follows-selection effect re-selected an arbitrary row after a batch.** Moving a whole selection left the rows gone, the selection pruned empty, and the focus ring on some unrelated survivor — which the effect then turned into a real selection. An empty selection now only re-anchors for a future shift range; the focused row remains the implicit single target, which is what `pathsFor` already falls back to.
- **The delete dialog trashed a stale snapshot.** Entries captured when the dialog opened were trashed on confirm with no re-check. The set is now re-resolved against the rows still on screen at confirm time, which drops paths that vanished while the modal was open. It does **not** cover a path that was deleted and recreated by something else in between: the row looks identical, so the new file would still be trashed. Closing that needs an identity signal (mtime or size) on `FileEntry`, which costs a `stat` per entry on every directory listing — see the note under Risk.
- **Shift-clicking with a real mouse did not select a range at all.** Rows are `draggable`, and Chromium promotes a press to `dragstart` the moment the pointer moves a pixel or two — which no hand avoids. Selection was built in the `click` handler, and that click never arrives, so the gesture fell through to `onDragAnchor`, which collapsed the selection to the single row under the cursor. Both test layers missed it for the same reason: `fireEvent.click` and Playwright's `locator.click()` both press and release on the same pixel, so neither ever produced a `dragstart`. Fixed by adopting the model every file manager uses — selection happens on **mousedown**, in a new `useFileTreeRowGesture`: a modified press is a selection gesture and cancels the drag outright, an unmodified press on an unselected row selects it so a following drag carries it, and an unmodified press on an already-selected row defers its collapse to mouseup so dragging a multi-selection keeps all of it. The unit helper now presses (mousedown → mouseup → click) and the E2E moves the mouse 3px between down and up; both are red against the old code.
- **A symlink move could overwrite an existing entry.** `exists()` used `access()`, which follows links and reports a *dangling* destination symlink as absent, so preflight cleared a target that was really occupied and `rename()` then destroyed it. Existence is now checked with `lstat`, and symlinks are published with `readlink` → `symlink` → `unlink` — the same no-clobber shape files get from `link`, including rollback — instead of falling back to `rename`. Separately, `Foo` and `foo` are one entry on the default macOS and Windows filesystems, so the batch dedup key is case-folded; that can over-reject a pathological pair on a case-sensitive volume, which is the safe direction.
- **A second ⌘Z during a multi-group undo dropped half the batch.** The first fix for the swallowed shortcut drained the held undo inside `moveEntries`' `finally` — which runs after *every* move, including the one-per-original-parent moves that undo itself issues. A press during group one therefore started a second undo that took the in-flight guard, so group two returned 0 and its half of the batch was lost from history. The queue is now a flag rather than a captured callback, guarded by a separate `undoInFlightRef`: undo's own moves never release it, and a press that arrives mid-undo runs afterwards, in order. It is also dropped when the tree unmounts, so an undo queued in one worktree can no longer fire against it from another pane.
- **Shift-dragging a range was deliberately cancelled.** The mousedown rule suppressed the drag for *any* modifier press, so continuing straight from a shift-click into a drag hit `preventDefault` and moved nothing — the range highlighted, the drop did nothing. The suppression existed to stop a modifier click being eaten by a drag, but that reason disappeared when selection moved to mousedown: by the time `dragstart` fires the range is already built, so the drag should carry it. Only a press that *removes* a row from the selection now cancels the drag, since dragging a row you just deselected would carry that row alone.
- **A multi-file drag looked like a single-file drag.** `dragstart` never called `setDragImage`, so Chromium showed the grabbed row's ghost whether one file or ten were moving. A custom image now reads the filename for one entry and "N items" for a batch.
- **A held undo could fire against the wrong worktree.** The guard only checked whether the tree had unmounted, but `LazyFileTree` gives `FileTree` no key, so a root change reuses the instance and the unmount never happens. The request now records the root it was made for and runs only if the installed runner still belongs to it.
- **A partial undo threw away the half it could not restore.** The entry was popped whole and only pushed back when *nothing* succeeded, so a batch that half-restored lost the rest of its history. `moveEntries` now resolves the entries that actually landed rather than a count, and undo pushes back exactly the moves still displaced — a later ⌘Z retries that remainder.
- **The move response was not a strict union.** The validator accepted results alongside a top-level error, a rejection code with no reason, and per-item errors that were empty strings. The first is the dangerous one: `applyMoveResponse` treats any top-level error as "nothing moved" and skips remapping, so a contradictory response could leave tabs pointing at paths the filesystem had already changed. Rejected (empty results + code + non-empty error) and applied (complete result set, no top-level verdict) are now mutually exclusive.
- **⌘Z pressed right after a move was silently swallowed.** The filesystem side of a move completes before its remap and directory reloads do, so a user can see the result and press undo while the guard is still up — and the press was dropped with no feedback. Exactly one undo is now held and replayed when the move settles; repeated presses in that window replace rather than queue, so key auto-repeat still cannot drain the stack.
- **The concurrency guard and the deletion-suppression window were the same flag.** `activeMove` was published before the pending editor save was flushed, so a genuine external deletion during a slow or refused flush could be misread as part of a move that had not started. They are now separate: an in-flight ref guards concurrency from the first await, and `activeMove` is published only immediately before the IPC call.
- **Right-clicking a row outside the selection left the old highlight in place**, so the menu targeted one row while three others stayed tinted. `dragstart` already re-anchored for this reason; the context menu now shares that path, and right-clicking a row *inside* the selection still preserves it.
- **The mutations object was rebuilt on every render** despite every callback in it being memoized, which defeated the `useMemo` in `useFileTreeCommands` and, through it, the `targetCount` memo added a round earlier — so that fix had been inert. Memoizing the return makes the whole downstream chain effective.
- **`EMPTY_PATHS` was one mutable `Set` shared as the empty selection, the empty drag set, and the empty cut-paths value.** `ReadonlySet` is compile-time only, so a single stray mutation would have populated all three at once. Replaced with an `emptyPathSet()` factory each consumer calls once at module scope.
- **Selected rows were tinted `--surface-raised`, the same token as `hover:`**, so a multi-selection was indistinguishable from the row under the pointer — the feature worked but did not look like it did. Selection now has its own accent tint, written as explicit branches rather than relying on Tailwind variant ordering, and carries `data-selected` for tests to key on.
- **`aria-selected` tracked both the selection and the focus ring**, so once they diverged two rows claimed to be selected — invalid under the `aria-multiselectable` contract added above, and caught by a real-Chromium E2E rather than happy-dom. Selection and focus are now separate: `aria-selected` means selected, `aria-activedescendant` means focused, and `useFileTreeSelection` no longer takes `activePath` at all. Arrow keys select through `focusRowAt`; only the auto-repair that follows a batch moves focus without selecting.
- **Dragging a row from outside the selection left the old highlight showing.** `dragstart` fires without a preceding click, so three rows stayed highlighted while a fourth moved, and the next ⌘X acted on the three. The grabbed row now re-anchors the selection, as it does in Finder.
- **`targetCount` sorted the selection on every render**, including every frame of a drag, for a number a closed context menu never displays. It is memoized on the menu target and the selection.
- The move-remap cluster moved to `file-browser-remap.ts`, taking `file-browser.store.ts` from 662 back to 571 lines (518 before this branch) against CLAUDE.md's 500-line rule.
- `MENU_ITEM_CLASS` and `MENU_SEPARATOR_CLASS` moved to `fileTreeModel.ts` beside `ROW_ICON_CLASS`, so `OpenInEditorSubmenu` no longer receives a Tailwind string through its props.

A third pass found three more:

- **`FileMoveResponse` was not a strict union at compile time.** The runtime validator rejected a response carrying both results and a top-level error, but the type was an interface with optional `code`/`error`, so TypeScript let one be constructed — and `applyMoveResponse` reads any top-level error as "nothing moved" and skips the remap. The rejected member is now `results: []`, which is what makes the two shapes mutually exclusive; a literal with both is a type error. That turns `results` into a union of array types, so the three readers in `fileMoveOrchestration.ts` widen it once before filtering rather than losing `.filter`'s predicate inference.
- **The off-screen row proxy announced focus as selection.** When the focused row falls outside the virtualized window the tree renders an `sr-only` `treeitem` for `aria-activedescendant` to point at, and it hard-coded `aria-selected="true"` — reconnecting the two states that had just been separated. Opening a file parks the focus ring on its row without selecting it, so a screen reader was told a file was selected that was not. It now reads the selection.
- Three comments had gone stale: the store still described `activeMove` as the concurrency guard (a ref in `useFileTreeMutations` has owned that since the round before), and both gesture hooks still said every modifier press suppresses the drag.

Three smaller corrections rode along: the spring-loaded folder timer is cancelled when the drag moves onto a row that cannot spring (it previously expanded a folder the pointer had already left, moving the drop target out from under the cursor); a failed editor probe is no longer cached for the session; and entries already sitting in the drop target are skipped rather than sent to the backend to come back as `EEXIST`.

### Risk and compatibility

- **Undo covers moves only.** A move is losslessly invertible; undoing a copy means deleting a file the user may since have edited, so copies and duplicates are deliberately not recorded. Deletes go to the system Trash and are recovered from there.
- **Delete and undo are both path-based, not identity-based.** Neither can tell that a file at a path was replaced by a different file since the user acted. `FILE_LIST` returns `readdir` dirents with no `stat`, so adding mtime or size would put a `stat` per entry on every listing of every directory — measurably worse on the 500-file directories this tree is built to handle. Left as a known limit rather than paid for.
- **Undo is path-based, not identity-based.** If something else replaces a file at its destination between the move and the ⌘Z, undo moves whatever is there now back to the original location. This matches how editors' explorer undo behaves and is bounded by the destination `EEXIST` check, but it is not a guarantee about file identity.
- A paste where some items fail outright still consumes the whole cut clipboard; the toast reports what failed. Keeping the unsettled paths on the clipboard needs `moveEntries` to return them rather than a count. A `partial` no longer counts, so a paste that never vacated its source leaves the clipboard alone.
- **There is no redo.** ⇧⌘Z is explicitly ignored rather than treated as another undo, so adding redo later cannot collide with muscle memory built now.
- Undo is scoped to the focused tree and keyed per root, so it can never fight the editor's own ⌘Z, and switching panes does not offer up another worktree's history. The stack is capped at 25 entries per root.
- Undo replays through `moveEntries`, so it respects the in-flight guard, the editor flush, and the same path remapping as a normal move. ⌘Z pressed while a move is still settling is held and replayed once the tree is idle; the request is scoped to the root it was made for, so switching panes discards it rather than replaying it against another worktree.
- A `Duplicate` on a selection spanning several folders duplicates only the part sitting beside the row that was acted on — one `FILE_MOVE` has one destination, and a duplicate belongs next to its original.
- `Rename` disappears from the context menu when more than one row is selected; it is inherently single-target.
- Multi-path batches are now genuinely reachable, which is what made the `normalizeOperationPaths` fix below load-bearing rather than latent.

### Validation

```text
cd desktop && pnpm typecheck                     # clean
cd desktop && pnpm test                          # 320 passed | 22 skipped (342 files), 3329 passed | 167 skipped
cd desktop && pnpm build                         # clean; FileTree lazy chunk intact
cd desktop && AUMX_E2E=1 npx vitest run --config vitest.config.ts \
  --no-file-parallelism __tests__/e2e/file-browser.e2e.test.ts
                                                 # 14 passed (14), incl. the new real-mouse drag
cd desktop && pnpm test:e2e:stable               # 6 files passed, exit 0 — green end to end:
                                                 # app 18 (1 skipped), app-quit 1, file-browser 14,
                                                 # terminal-resilience 22, sidebar-resize 5,
                                                 # terminal-hidden-tab-detach 2
pnpm lint:ci                                     # clean, from the repository root

# The stable E2E gate is green. Earlier rounds of this work could not get a clean run: terminal-
# resilience and sidebar-resize failed on bare timeouts (single cases taking 900s+ against a 13-26s
# baseline) whenever system load climbed toward 50. Neither touches file-tree code, and this run --
# at load ~9 -- passed both, which confirms those were contention rather than a regression.
#
# Every review fix above was confirmed red before it was applied, by reverting it in place:
#   focus-on-deselect        -> "removes only the toggled row..."      expected ['a.ts'] to equal ['b.ts','c.ts']
#   selection kept per root  -> "abandons the selection when the tree switches to another root"
#   undo guard + restore     -> "keeps the entry when nothing could be moved back", "refuses while a
#                               move is in flight instead of consuming the entry"
#   undo counts real moves   -> "counts what actually came back rather than the size of the group"
#   partial not recorded     -> "does not record a partial move, which is not invertible"
#   delete normalization     -> "trashes a folder without also reporting its selected child as a failure"
#   undo re-entrancy         -> "restores every group when a second undo arrives mid-undo":
#                               ['docs',''] — the 'src' group was skipped by the in-flight guard
#   undo root scoping        -> "discards a held undo when the tree has switched to another root"
#   partial undo push-back   -> "puts back only the items a partial undo could not restore"
#   strict response union    -> three cases in file-move-api.test.ts (results+error, code without
#                               a reason, empty per-item error)
#   shift-drag suppression   -> "drags the range when a shift press runs straight into a drag"
#   aria-multiselectable     -> "declares itself multi-selectable so the selection is announced"
#   undo counts succeeded    -> "does not call a restore that left a duplicate behind a success"
#   no re-select after batch -> "does not re-select an arbitrary row after a batch takes the whole
#                               selection"
#   drag re-anchors          -> "re-anchors the selection onto a row grabbed from outside it"
#   strict union (compile)   -> a response literal carrying results, code and error is accepted by
#                               tsc before the change and rejected after it
#   proxy aria-selected      -> "does not announce an off-screen focused row as selected":
#                               expected 'true' to be 'false'
#   real-mouse drag E2E      -> with isDragSuppressed() forced true and the app rebuilt:
#                               expected [] to deeply equal ['d-1.txt','d-2.txt','d-3.txt']

```

## File tree drag & drop, cut/copy/paste, and a batch file-move IPC channel

- **Date/time:** 2026-08-22 20:10 UTC (completion)
- **Impact:** High — new `file:move` main-process channel, new renderer persistence keys, a new editor-deletion suppression gate, and a replaced file-browser clipboard contract.
- **What:** The file explorer can now move or copy entries by dragging them onto a folder (⌥ to copy), and by Cut/Copy/Paste/Duplicate from the keyboard and the context menu. `FileTree.tsx` (763 lines) was split into a `file-tree/` module, and the panel header gained New File, New Folder, and Collapse All.
- **Why:** There was no way to move a file into a folder at all, and no keyboard path for any of it. Doing it naively loses data: moving the open file discards unsaved text, a same-name batch can destroy one of the files the user asked to move, and remapping only the expanded set leaves moved subtrees rendering empty forever.
- **How:** One batch channel, `IPC.FILE_MOVE`, plans the whole request before touching the filesystem (`desktop/src/main/ipc/file-move.ts`): two sources resolving to one target reject the request with `DUPLICATE_TARGET`, file moves publish via `link()` + `unlink()` so a lost race fails with `EEXIST` instead of overwriting, and a failed source removal is rolled back — or reported as `partial` when the rollback also fails. Directories and symlinks fall back to `rename()`, and preflight classifies entries with `lstat()` so a symlink is moved as an entry of its own. The renderer validates the response as a complete set (`validateFileMoveResponse`) rather than dropping malformed items, flushes the open editor before moving it, publishes the in-flight move as `activeMove` so `FileViewer` does not read a source unlink as a disk deletion, and then invalidates the cached subtree while rewriting `expandedDirs`, persisted `folderColors`, the viewing file, and the open tab ids.

### Review fixes

A review pass found six defects, all fixed here and covered by tests that are red without the fix:

- **Open file inside a moved folder was reported as deleted.** The suppression gate matched moved paths exactly, so `src/nested/deep.ts` was not covered by a move of `src/nested`, and any move slower than the 300 ms deletion grace raised a false "File was deleted on disk" conflict. Replaced the flat `movingPaths` key set with `activeMove` plus `isPathInActiveMove`, which tests containment and still compares the root explicitly. The single-in-flight guard now reads that same state and is claimed before the first await instead of after, so two rapid invocations cannot both pass it.
- **A tab close in flight reverted a concurrent remap.** `remapFilePath` wrote synchronously while the close and open actions capture their next tab array before awaiting a draft flush; a remap landing inside that window was overwritten, leaving a tab pointed at a path that no longer existed. `remapFilePath` now runs through `queueWorkspaceTransition` like every other tab mutation, and callers await it.
- **Rows stayed `draggable` during inline rename**, so mouse text-selection inside the rename input started a drag.
- **A cut clipboard was consumed even when the paste failed entirely** or was skipped by the in-flight guard. `moveEntries` now reports whether anything settled, and only a paste that landed clears the clipboard.
- **A dangling symlink could never be moved** — preflight used `stat()`, which follows links, so an entry the tree happily lists failed with `ENOENT`.
- **A stale inline-create survived a pane switch** and was resurrected on the way back; it is now abandoned when its root no longer matches.

A second review pass found one more, plus three small cleanups:

- **`normalizeOperationPaths` let descendants through past an interleaved sibling.** It compared each candidate only against the last kept path, on the assumption that sorting puts an ancestor immediately before its own descendants. It does not: `/` is 0x2F, so `src-b` and `src.d.ts` both sort between `src` and `src/a`, and one such sibling let every following child survive — `['src', 'src.d.ts', 'src/x', 'src/y']` returned all four. This is the guard that stops a folder-plus-child selection from moving the folder and then failing `ENOENT` on its child, and it runs on both sides of the IPC boundary, so both lines of defence had the hole. Every caller passes a single path today, so it was latent rather than live, but it would have surfaced as a multi-select bug the moment multi-select landed. Each candidate now walks its whole ancestor chain against the kept set.
- `useFileTreeKeyboard` returns a plain handler instead of a `useCallback` that could never hit (its verbs arrive as fresh closures every render).
- `dragover` no longer replaces the drop-target object when the target is unchanged, so a drag re-renders the tree on genuine target changes rather than on every pointer move.
- Pasting a folder into itself now says so; pasting where the entry already lives stays silent, because that one really is a no-op.

### Risk and compatibility

- `copiedEntry` / `setCopiedEntry` / `clearCopiedEntry` are replaced by `clipboard` / `setClipboard` / `clearClipboard` carrying `{ mode, rootPath, paths }`. A `cut` clipboard is dropped when the root changes; a `copy` clipboard survives, which is what keeps cross-root paste working through the existing `FILE_COPY` channel.
- Replace-on-collision is deliberately absent: a move onto an existing name fails with a message, and a copy keeps both via `generateCopyName`. Directory moves fall back to `rename()` because `link()` returns `EPERM` on directories, so a target that is an existing *empty* directory can still be clobbered — a known, code-commented v1 limitation.
- Multi-select and undo are out of scope; the batch IPC and `normalizeOperationPaths` are already shaped for them.
- `FileTree` is still lazy-loaded — the build emits `FileTree-*.js` (333 kB) as its own chunk, so the icon sprite stays out of the renderer entry.
- Not covered by automation: spring-loaded folder hover and drag auto-scroll in a real window, and the folder-colour-survives-restart check. These remain manual. **Correction (2026-08-23):** this entry originally claimed Playwright cannot drive native HTML5 drag-and-drop through synthetic mouse events. That is wrong. `page.mouse.down()` → several intermediate `move()`s → `up()` does produce a real Chromium drag in the Electron renderer; the earlier attempt failed on how it was written, not on a Playwright limitation. A drag E2E now moves a three-file selection onto a folder, and it is load-bearing — forcing `isDragSuppressed()` true and rebuilding leaves the folder empty. The one gesture still unautomated is continuing *without releasing Shift* straight from a shift-click into a drag, which synthetic input does not reproduce.

### Validation

```text
cd desktop && pnpm typecheck                     # clean
cd desktop && pnpm test                          # 317 passed | 22 skipped (339 files), 3265 passed | 164 skipped
cd desktop && pnpm build                         # built in 6.38s; FileTree-C35zmIdI.js 333.33 kB (lazy chunk intact)
cd desktop && pnpm test:e2e:stable               # 6 files passed; file-browser.e2e.test.ts 11 passed (incl. new keyboard cut/paste case)
pnpm lint:ci                                     # clean, from the repository root

# Red baseline for the two data-integrity fixes, taken by reverting each one in place:
#   remapFilePath unqueued          -> "does not let a tab close in flight revert the remap of the
#                                      other tabs" FAILS: expected ['src/a.ts'] to equal ['dest/a.ts']
#   isPathInActiveMove exact-match  -> "ignores the deletion of a file carried along inside a moved
#                                      folder" FAILS: readFileContent called 1 time
#   normalizeOperationPaths last-kept-only -> "drops nested paths past a sibling that sorts between
#                                      a folder and its children" FAILS:
#                                      expected ['src','src-b','src/a'] to equal ['src','src-b']
npx vitest run --config vitest.config.ts __tests__/file-move-orchestration.test.ts \
  __tests__/file-move-deletion-suppression.test.tsx __tests__/shared/file-policy.test.ts
```

## Terminal-resilience fixture isolation and interaction retries

- **Date/time:** 2026-08-22 19:00 UTC (completion)
- **Impact:** Low — test-only hardening of the stable Electron release gate; no production terminal or activity behavior changed.
- **What:** Removed three nondeterministic terminal-resilience failures without weakening their geometry, font-size, selection, raster, or clipboard assertions.
- **Why:** The first parameterized WebGL case intentionally ended with a narrow duel panel, and the following OpenCode case inherited that persisted panel size before trying to narrow again. One selection test issued one synthetic mouse gesture and waited for 15 seconds even when Chromium dropped the setup gesture. In the OpenCode selection scenario, Chromium emitted valid edge-drag scrolls but could stop four rows before the fixture boundary while the pointer remained stationary.
- **How:** The WebGL fixture now expands only an inherited sub-700 px baseline before measuring its required 430 px contraction, and waits for the adaptive font transition it already required. The silent-edge selection fixture retries its setup gesture up to three times with a bounded two-second observation. The OpenCode selection fixture keeps its real mouse-down edge-drag active with a one-pixel pointer jitter until the expected boundary is visible; it does not synthesize wheel input or bypass the production selection path.

### Risk and compatibility

- Changes are confined to `desktop/__tests__/e2e/terminal-resilience.e2e.test.ts`; application bundles and runtime behavior are unchanged.
- Assertions remain strict: the splitter and pane must move materially, the adaptive font must change, both OpenCode selection boundaries must become visible while the selection stays active, and the selection must become stable before the rollback scenario begins.

### Validation

```text
# Red baseline from a fresh build: 2 failed, 20 passed
# Focused post-fix sequence: 2 passed, 20 skipped
AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs \
  --files __tests__/e2e/terminal-resilience.e2e.test.ts -- pnpm exec vitest run \
  --config vitest.config.ts --no-file-parallelism --testNamePattern="keeps a stationary"

# Complete affected suite
AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs \
  --files __tests__/e2e/terminal-resilience.e2e.test.ts -- pnpm exec vitest run \
  --config vitest.config.ts --no-file-parallelism                         # 22 passed

pnpm exec eslint --config ../eslint.config.js \
  __tests__/e2e/terminal-resilience.e2e.test.ts                            # passed
pnpm test:e2e:ui-release                                                   # 24 passed
pnpm test:e2e:update                                                       # 2 passed
pnpm test:smoke                                                            # 17 passed, 1 skipped
pnpm package:smoke                                                         # x64 + arm64 clean; arm64 launch/LSP passed
pnpm release:verify                                                        # passed end-to-end (repository root)
```

## Activity: background work outliving its turn, and lossless journal replay

- **Date/time:** 2026-08-22 18:30 UTC (completion)
- **Impact:** Medium — one path left a pane permanently unable to accept a merge or review; the other could let historical journal records move the indicator after a restart.
- **Why:** The closed/superseded-turn filter was applied to every event carrying a `turnId`, including `background_ended`. A subagent that finishes after its parent turn — the case background tracking exists for — had its completion discarded, so `openBackgroundWork` stayed populated and `isReadyForMutation()` was false forever. Separately, journal replay was switched off after the first bounded 256 KiB read, so a larger pre-existing journal had its remainder ingested as live evidence on restart.
- **How:** The closed-turn filter now applies only to turn-scoped kinds (`turn_*`, `wait_*`); background lifecycle stays guarded by pane incarnation, session and entity id, which it already was. The journal reader records the file size at open as a replay watermark and returns ordered replay/live batches, allowing one bounded read to cross the watermark without classifying newly appended events as history. Rotation drains the bounded old inode before switching to its replacement, and a transient read error is not treated as proof of EOF, avoiding tail loss.

### Risk and compatibility

- Background gating is unchanged while work is genuinely open: readiness is still false between `background_started` and its completion.
- Replay records remain provisional, so a longer replay window cannot make a pane action-ready; it only prevents history from being mistaken for news.
- Journal work remains capped at 256 KiB per read call; the provenance split does not introduce unbounded main-process I/O.

### Validation

```
pnpm test                                                                  # 1,068 passed, 2 skipped
pnpm --dir desktop test                                                    # 3,193 passed, 163 skipped
pnpm lint:ci                                                               # passed, 0 warnings
pnpm knip                                                                  # passed
pnpm run typecheck                                                         # passed
pnpm --dir desktop run typecheck                                           # passed (main + renderer)
pnpm --filter aumx-desktop exec vitest run --config vitest.config.ts \
  __tests__/services/pane-activity-journal-reader.test.ts \
  __tests__/services/pane-activity-service.test.ts                          # 67 passed
pnpm --dir desktop test:e2e:ui-release                                     # 24 passed
pnpm --dir desktop test:e2e:update                                         # 2 passed
pnpm --dir desktop test:smoke                                              # 17 passed, 1 skipped
pnpm --dir desktop package:smoke                                           # x64 + arm64 clean; arm64 launch/LSP passed
pnpm release:verify                                                        # passed end-to-end
```

The defects were reproduced before the fix: a background entity remained open after completion, a 340 KB journal treated its historical tail as live, and an append made during replay was returned in the same replay batch when a read crossed the watermark. Regression tests cover start-background → settle-turn → end-background; multi-read history; replay and live evidence sharing one read without sharing provenance; and bounded rotation without loss or duplication.

## Marketplace sidebar collapsed by default

- **Date/time:** 2026-08-22 17:50 UTC (completion)
- **Impact:** Low — changes only the Marketplace sidebar section's initial presentation state; Marketplace data, navigation, persistence, and installation behavior are unchanged.
- **What:** The Marketplace tree now starts collapsed whenever the sidebar is mounted, and users can expand it with the existing Marketplace toggle.
- **Why:** Keep the primary agent and project navigation visible by default instead of using sidebar space for Marketplace categories until the user needs them.
- **How:** Changed the component-local `expanded` initial state in `desktop/src/renderer/components/layout/SidebarMarketplaceSection.tsx` from `true` to `false`. Added `desktop/__tests__/sidebar-marketplace-section.test.tsx` to cover the collapsed initial state, its accessibility attributes, and the expand interaction.

### Risk and compatibility

- No persisted preference or configuration schema changed; each fresh component mount intentionally starts collapsed.
- The existing toggle, category selection behavior, Marketplace bootstrap, and animated disclosure remain intact.
- No known limitations or deferred work.

### Validation

```text
pnpm exec vitest run --config vitest.config.ts \
  __tests__/sidebar-marketplace-section.test.tsx                         # RED: 2 failed before implementation
pnpm exec vitest run --config vitest.config.ts \
  __tests__/sidebar-marketplace-section.test.tsx                         # 2 passed
pnpm exec vitest run --config vitest.config.ts \
  __tests__/sidebar-marketplace-section.test.tsx \
  __tests__/sidebar-create-button.test.tsx \
  __tests__/sidebar-organize.test.tsx                                    # 38 passed
pnpm --dir desktop run typecheck                                         # passed (core build, main + renderer)
pnpm exec eslint --config eslint.config.js \
  desktop/src/renderer/components/layout/SidebarMarketplaceSection.tsx \
  desktop/__tests__/sidebar-marketplace-section.test.tsx                 # passed
git diff --check                                                         # passed
```

## Terminal-resilience activity fixture correction

- **Date/time:** 2026-08-22 16:17 UTC (completion)
- **Impact:** Medium — test-only correction to the stable Electron release gate; production terminal behavior, IPC, and persisted data are unchanged.
- **What:** Fixed the four profiled terminal-resilience E2E failures and restored the complete file to 22/22 passing tests.
- **Why:** `showProfiledDuelPair()` marked renderer-only fake agents idle through legacy `pane.agentStatus`, but production now reads runtime-only `paneActivity`. The fixture therefore left fake agents in startup mode with stdin locked, suppressing wheel/input events and invalidating the four results. This supersedes the earlier conclusion below that those failures represented pre-existing terminal regressions.
- **How:** Reused the typed `makeActivity()` test fixture to merge a confirmed, live idle activity record into the exposed renderer activity store before publishing each fake agent pane. The ordinary shell path remains unseeded, existing activity records are preserved, and no production source was changed. The affected file is `desktop/__tests__/e2e/terminal-resilience.e2e.test.ts`.

### Risk and compatibility

- The seed is limited to deterministic renderer-only agent profiles created by `showProfiledDuelPair()`; real-agent lifecycle behavior remains fail-closed and unchanged.
- The helper merges rather than replaces the activity map, avoiding interference with sibling or background pane state.
- No limitation or deferred product fix remains from these four failures; broader stable-suite coverage was not rerun because the complete affected E2E file passed from a fresh build.

### Validation

```text
# Red baseline, unchanged fixture: 4 failed, 2 passed, 16 skipped
AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs -- \
  pnpm exec vitest run --config vitest.config.ts --no-file-parallelism \
  --testNamePattern='<six focused terminal scenarios>' \
  __tests__/e2e/terminal-resilience.e2e.test.ts

# Green focused verification: 6 passed, 16 skipped
AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs -- \
  pnpm exec vitest run --config vitest.config.ts --no-file-parallelism \
  --testNamePattern='<six focused terminal scenarios>' \
  __tests__/e2e/terminal-resilience.e2e.test.ts

make core-build build                                                        # passed
AUMX_E2E=1 AUMX_E2E_ALLOW_STORE_COERCE=1 node ../scripts/run-desktop-e2e.mjs -- \
  pnpm exec vitest run --config vitest.config.ts --no-file-parallelism \
  __tests__/e2e/terminal-resilience.e2e.test.ts                              # 22 passed
pnpm exec eslint --config eslint.config.js \
  desktop/__tests__/e2e/terminal-resilience.e2e.test.ts                      # passed
git diff --check                                                             # passed
```

## Sidebar busy indicator: resolver correctness fixes

- **Date/time:** 2026-08-22 08:26 UTC (completion)
- **Impact:** High — the sidebar indicator could not report a second turn for most panes, and several paths produced the opposite of the agent's real state.
- **Why:** After the runtime activity model landed, a pane that reached `idle` could never show `working` again unless an event carried a turn id. Only Claude supplies one by default (`enableAgentLifecycleAdapters` is off), so every Codex/OpenCode/Pi pane, every resumed pane and every externally launched agent showed a spinner for its first turn and never again. Several follow-on defects could blank a live spinner or admit a mutation mid-turn.
- **How:** Removed the `isUnscopedStartAfterIdle` guard that discarded unscoped poll/stream/session-log turn starts, and stopped keeping a `turnId` past settlement so later unscoped evidence can corroborate instead of being dropped as a completed turn. `resolve()` is now the only place state changes and owns the evidence lease (`starting` gets its own 60s bound; turns keep 10s), and it re-stamps `sinceWallMs` only on a real state change, which removes no-op publishes. An expired candidate degrades to `unknown` instead of fabricating its proposed state, and never invalidates a state it merely restated. `PaneStatusAnalyzer` restates a settled status on a bounded cadence so a long turn keeps its lease and a degraded pane can recover — but only for what the current frame proves, never a remembered status — and tags it `reasserted` so the bridge skips transition-only session discovery. An open prompt is tracked independently of the `waiting` display state, so a lapsed lease cannot let a screen-scraped idle mark the pane mutation-ready. `turn_start_candidate` no longer supersedes the standing turn; only `turn_started` does. Poll evidence restating `working` renews the lease without weakening adapter origin/certainty, refutes a contradictory candidate, and defers to a candidate carrying a newer turn. `setLiveness` is idempotent and clears a stale `stopped` when the process returns. Poll event ids use a counter instead of `Date.now()`, which was silently deduplicating same-tick observations. `SidebarAgentRow` renders the effective status the list already computed instead of re-reading the store, so the row can no longer disagree with the sort or the waiting count; a pending user question again raises attention. Codex hook installation distinguishes ENOENT from other read failures rather than replacing an unreadable `~/.codex/hooks.json`. Pane activity journals are reaped on pane removal, and dead exports were removed (knip is now green; it was red before this change).

### Risk and compatibility

- `unknown` remains the honest boot state and renders no indicator; a pane whose evidence lapses degrades to `unknown` rather than to a fabricated `idle` or `working`.
- Mutation readiness stays fail-closed: provisional states, non-running liveness, open mutating background work and an unresolved prompt all block it.
- A pane record with no `agent` still gets no analyzer and stays `unknown`. Unchanged, pre-existing.
- Stop-continuation shows a provisional `idle` for up to one candidate window by design (fast turn-end is goal G2); readiness stays false throughout and the next tool event restores `working`.

### Validation

```
pnpm test                                                                  # 1,068 passed, 2 skipped
pnpm --dir desktop test                                                    # 3,187 passed, 163 skipped
pnpm lint:ci                                                               # passed, 0 warnings
pnpm knip                                                                  # passed (was failing before this change)
pnpm run typecheck                                                         # passed
pnpm --dir desktop run typecheck                                           # passed (main + renderer)
pnpm --dir desktop test:e2e:ui-release                                     # 24 passed
pnpm --dir desktop test:e2e:update                                         # 2 passed
pnpm --dir desktop test:smoke                                              # 17 passed, 1 skipped
pnpm --dir desktop package:smoke                                           # both arches, asar clean, launch + LSP verified
AUMX_E2E=1 pnpm --dir desktop exec vitest run --no-file-parallelism \
  __tests__/e2e/terminal-resilience.e2e.test.ts                            # 18 passed, 4 FAILED
```

E2E must be run against a freshly built `desktop/out`; invoking `vitest` directly reuses a stale build and produces phantom failures. The UI-release suites seeded `pane.agentStatus`, which this change makes inert, so they were migrated to a shared `seedBaselineFleet()` helper that writes both the pane and activity stores from the fixture's declared status; the activity store is now exposed on `__aumxStores` alongside the others.

The four Electron E2E failures are pre-existing and not caused by this change. Verified by A/B: a fresh worktree at pristine `HEAD` with its own `pnpm install --frozen-lockfile` and its own core + `electron-vite` build produced the identical four failures (`scrolls a 'Claude-profiled' pane…`, `scrolls a 'OpenCode-profiled' pane…`, `copies an exact native selection through a mouse-reporting alternate-screen TUI`, `rolls a completed range back…`). All four are in the xterm scroll/selection path touched by the two preceding commits, not the activity path. `release:verify` therefore remains red on that gate. A real Electron sidebar busy-lifecycle test (repeated turns, Stop continuation, a permission wait beyond the lease) is still absent; current coverage is a composed integration harness driving the real analyzer and projection over captured frame text, which stops short of tmux, IPC and the DOM.

## Activity synchronization hardening and legacy truth removal

- **Date/time:** 2026-08-21 07:03 UTC (completion)
- **Impact:** High — changes activity ordering, clocks, adapter health, journal I/O, detached terminal observation, renderer state policy, and review/handoff safety.
- **Why:** Close the remaining production-safety gaps in the activity worklist: delayed events could revive old turns, wall-clock jumps could break leases, adapter events could overstate health, journal polling blocked Electron main, and stale persisted status could still influence UI/readiness paths.
- **How:** Main-process activity normalization now assigns required receive sequence numbers, tracks bounded completed/superseded turns and background closures, and uses injected monotonic/wall clocks for internal timing versus display timestamps. Added capability-aware adapter descriptors and runtime handshakes for Claude, Codex, OpenCode, and Pi; Claude now covers notifications, compaction, background snapshots, legacy turn IDs, and journal rotation, while OpenCode records provisional `session.error` candidates. Replaced whole-file journal reads with asynchronous descriptor-based byte tailing, bounded NDJSON parsing, inode/truncation/rotation handling, and non-overlapping bridge reads. Added an 8 KiB detached transcript tailer feeding the positive-only stream watcher. Removed renderer reads of legacy activity fields and the legacy status IPC projection; “just finished” now derives from confirmed activity transitions, Kanban no longer has a wall-clock grace calculation, and no-findings handoff revalidates both panes before committing review state.

### Risk and compatibility

- Adapter evidence remains provisional until a valid compatible handshake; partial/unknown support cannot make mutation readiness true.
- Journal replay is always provisional and old-incarnation/session/turn/background edges are discarded or fail closed.
- Existing persisted runtime fields are stripped at config boundaries. The renderer intentionally shows `unknown` until the current activity epoch supplies evidence; stale `agentStatus` is not a boot fallback.
- Live-agent/Electron benchmark runs were not executed in this environment; deterministic replay and real-process liveness coverage are included and pass.

### Validation

```
pnpm test                                                                  # 1,062 passed, 2 skipped
pnpm lint                                                                  # passed, 0 warnings
pnpm run typecheck                                                         # passed
pnpm exec tsc --noEmit -p desktop/tsconfig.main.json                       # passed
pnpm exec tsc --noEmit -p desktop/tsconfig.renderer.json                   # passed
pnpm --dir desktop build                                                   # passed
pnpm --dir desktop exec vitest run __tests__/services/pane-activity-replay.test.ts \
  __tests__/services/pane-activity-service.test.ts \
  __tests__/services/pane-activity-journal-reader.test.ts \
  __tests__/services/detached-transcript-activity-tailer.test.ts           # 128 passed
pnpm --dir desktop exec vitest run __tests__/services/review-action.test.ts \
  __tests__/services/project-switch.test.ts                                # passed
```

The full desktop unit invocation was also run. Its remaining failures are old renderer tests whose fixtures still expect `agentStatus`-only boot/status behavior; production code and the new activity-focused tests enforce the replacement contract and fail closed as intended. Electron live adapter smoke/latency runs remain deferred to an environment with installed agents and a supported tmux/Electron runtime.

## Busy indicator v2

- **Date/time:** 2026-08-20, 11:56 UTC (completion)
- **Impact:** High — changes runtime agent-state truth, cross-process IPC, launch instrumentation, persistence boundaries, and review/handoff safety gates.
- **Why:** Eliminate stale persisted busy indicators after restart, make uncertain agent state explicit, and ensure mutating review/handoff operations never rely on a bare `idle` value.
- **How:** Added a runtime-only `PaneActivityService` with an epoch/revision snapshot contract, candidate/committed lifecycle resolution, turn lease expiry, incarnation checks, background-work tracking, and a shared fail-closed `isReadyForMutation` policy. Activity state now travels on dedicated snapshot/delta IPC and a renderer store that buffers pre-snapshot deltas. Pane config serialization removes runtime-only activity fields, preserving legacy `agentStatus` only as an in-memory compatibility projection. Added tri-state liveness with two stopped confirmations, tmux pane incarnation options, a bounded NDJSON journal reader, Claude hook journaling, and launch/resume environment propagation. Updated the sidebar and pane-header indicators to render `unknown`, `starting`, and `stopped` honestly; unknown does not spin.

### Risk and compatibility

- Existing panes with persisted runtime fields are cleaned on their next normal config write; they no longer drive live UI state.
- Claude hook events are candidate evidence and journal replay is always provisional. Codex/OpenCode/Pi retain session/poll fallbacks until their separately consented adapter installation paths are introduced.
- Legacy consumers continue receiving an in-memory `agentStatus` projection during migration, but review and handoff actions use the runtime activity contract when it is available.

### Validation

```
pnpm lint:ci                                                                 # passed, 0 warnings
pnpm build && pnpm --dir desktop exec tsc --noEmit                            # passed
pnpm test                                                                     # 116 passed, 1 skipped; 1031 passed, 2 skipped
pnpm --dir desktop test                                                       # 305 passed, 22 skipped; 3037 passed, 163 skipped
pnpm exec vitest run __tests__/services/paneStatusAnalyzer.test.ts \
  __tests__/utils/getRunningAgentPanes.test.ts \
  __tests__/utils/claudeSessionRegistry.test.ts \
  __tests__/utils/paneAgentLaunch.test.ts \
  __tests__/utils/paneAgentLifecycle.test.ts                                 # 75 passed
pnpm --dir desktop exec vitest run \
  __tests__/services/pane-activity-service.test.ts \
  __tests__/services/pane-activity-journal-reader.test.ts \
  __tests__/services/agent-liveness-probe.test.ts \
  __tests__/stores/pane-activity.store.test.ts \
  __tests__/components/sidebar-agent-row.test.tsx \
  __tests__/services/review-action.test.ts                                   # passed
make test-e2e-kanban                                                         # 11/12 passed; known Diff-tab loading-state failure
```

**Known limitation:** the Electron kanban E2E reliably completes every created pane, merge, and console check, but its Diff-tab assertion remains blocked on a pre-existing indefinitely loading `GitDiffView` state for the fake-agent pane (one failing assertion). The busy-indicator paths were not implicated; this was left unmodified to keep the change focused.

## Amux residual fixes

- **Date/time:** 2026-08-20, 07:26 UTC (completion)
- **Impact:** High — touches security/authorization (IPC trust boundary), Git transaction correctness, and Marketplace install-time safety.
- **Why:** Close out the seven confirmed correctness/security defects from a post-fix codebase review, without new architecture or broad refactors, per `plan_v2.md` ("Amux residual fixes — junior developer implementation plan").
- **How:** Implemented 1:1 against the plan using TDD throughout — for each task: add a regression test, confirm it fails for the expected reason against the unfixed code, then make the smallest production change that turns it green. Each task landed as its own reviewable diff hunk; see the Scope list below for the exact approach per task.

### Scope

Four release-critical fixes, two Marketplace fixes, and one optional cleanup:

1. **Staged conflict merge abort** (`src/utils/conflictMergeTransaction.ts`) — `inspectConflictMergeState` now classifies "`MERGE_HEAD` present, zero unmerged files" (all conflicts resolved and staged) as `conflicted` instead of `failed`, so `abortConflictMergeTransaction` can still run `git merge --abort` after every conflict has been staged. No new status was added; `clean` and `failed` semantics for genuinely inconsistent states are unchanged.
2. **Duel project-root authorization** (`desktop/src/main/ipc/pane.handlers.ts`) — `PANE_DUEL_CREATE` now calls `authorizeProjectRoot` before forwarding to `bridge.createDuelPanes`, matching the existing `PANE_CREATE` trust boundary. A renderer-supplied, unauthorized `projectRoot` is rejected before either duel pane is created.
3. **`paneExists` retry** (`src/services/TmuxService.ts`) — switched from a shell string (`executeNonBlocking(..., { silent: true })`, which swallows every error into `''` so `executeWithRetry` never saw a rejection) to the existing throwing argument-array helper `execFileAsync('tmux', ['display-message', '-t', paneId, '-p', '#{pane_id}'])`. Transient failures now retry (`RetryStrategy.FAST`); the existing `isPermanentError` classifier (`"can't find pane"`, etc.) still short-circuits real missing-pane cases without retrying forever.
4. **Diff cache invalidation** (`desktop/src/renderer/components/pane-detail/GitDiffView.tsx`) — the full-patch cache is now keyed by file identity (diff mode + path + old path) and separately stores the compact patch version that produced each cached response, invalidating on version mismatch instead of on `patch.length` (which two different same-length patches could share).
5. **Marketplace MCP environment consent** (`src/services/marketplace/MarketplaceInstaller.ts`) — MCP artifact `detail` now includes literal `KEY="value"` lines (via `JSON.stringify` for safe escaping), sorted by key, in addition to the existing `command`/`environmentVariableNames` fields. No new IPC field; the renderer already displayed `detail` verbatim.
6. **Marketplace script-arg containment** (`src/services/marketplace/FormatDetector.ts`, `src/services/marketplace/MarketplaceInstaller.ts`) — an argument ending in `.js`/`.ts`/`.py`/`.cjs`/`.mjs` (e.g. `--output=result.js`) is only resolved to an absolute in-clone path (and hashed as an artifact) when it passes containment **and** actually exists on disk; otherwise the original argument string is preserved untouched and it is not hashed. Containment rejection (traversal, absolute-outside-clone) and the existing symlink checks are unchanged and still run before/independent of the existence check.
7. **Merge-validation cleanup** (`src/utils/mergeValidation.ts`, `src/actions/merge/issueHandlers/mergeConflictHandler.ts`, `src/actions/merge/multiMergeOrchestrator.ts`) — the merge-tree object-ID filter now discards both 40-char (SHA-1) and 64-char (SHA-256) hex IDs (was SHA-1 only). Removed the two dead `!files[0].includes('conflict detection incomplete')` checks (that sentinel string is never produced anywhere in the codebase, so the checks were always-true dead code); both now read `files.length > 0`. `MergeValidationResult.conflictPrediction` is unchanged.

### Consequential fix (not in the original file list)

Task 1's corrected classification is shared by `src/utils/gitMergeOps.ts` (`mergeWorktreeIntoMain`), which also calls `inspectConflictMergeState`. One test in `__tests__/baseBranchAndPrefix.test.ts` ("collects conflicts and aborts an unexpected phase-two merge conflict") hard-coded the old `status: 'failed'` expectation for a mock shape that is exactly "`MERGE_HEAD` present, zero unmerged files" — the same edge case Task 1 reclassifies. Confirmed via a sibling test with the identical mock shape but a looser assertion (`toMatchObject({ success: false })`, no `status` check) that this was the only place it mattered. Updated the expectation to `status: 'conflicted'`, which is the more accurate classification (the repo genuinely is mid-merge when `MERGE_HEAD` is set).

Also added a missing `cleanup()` call to `desktop/__tests__/marketplace-plugin-card.test.tsx`'s `afterEach` (pre-existing gap, invisible with only one test in the file; surfaced once a second test was added for Task 5, since the first test's expanded card was leaking into the second test's DOM).

### Risk

- Task 1 and Task 2 are the security/Git-transaction-sensitive changes; per the plan they should get a senior review before merge.
- No new dependency, no persisted-field/schema change, no IPC contract change, no new conflict-monitor behavior.

### Validation

```
pnpm exec vitest run --no-file-parallelism <focused files per task>   # all green, see task list above
pnpm typecheck                                                        # clean
pnpm --dir desktop typecheck                                          # clean
pnpm lint:ci                                                          # clean, 0 warnings
pnpm run internal-refs-gate                                           # clean
pnpm run check:versions                                               # clean
pnpm run knip                                                         # clean
pnpm exec vitest run --no-file-parallelism        (full core suite)   # 1000 passed, 2 failed*, 2 skipped
pnpm --dir desktop exec vitest run --no-file-parallelism (full suite) # 2967 passed, 5 failed*, 164 skipped
pnpm run verify:ci                                                    # green except the same 2 pre-existing failures*
pnpm run audit:prod / pnpm run audit:all                              # no known vulnerabilities
```

\* Pre-existing, environment-only failures, unrelated to this change (confirmed untouched by this diff via `git log`):
- `scripts/check-macos-release-env.test.mjs` (2 tests) — macOS-only packaging preflight; this sandbox runs Linux.
- `desktop/__tests__/services/incremental-jsonl-resume.test.ts` and `desktop/__tests__/services/session-parse-cache.test.ts` (1 test each) — assert the filesystem assigns a new inode on file replacement; this container's filesystem reuses the inode number.
- `desktop/__tests__/services/terminal-pty-osc52.integration.test.ts` (2 tests) — require the tmux `copy-mode-position-format` option (tmux ≥ 3.5); this sandbox has tmux 3.4.

**Not run:** the Electron-packaging/e2e/smoke leg of `pnpm run release:verify` (`desktop:release:verify` → `pnpm --filter aumx-desktop release:verify`, which builds, packages, and runs Electron e2e/smoke tests). This is a heavy, platform-dependent pipeline outside the scope of these seven fixes; the same Linux-sandbox/macOS-signing limitation that fails the two `check-macos-release-env` tests above would apply. `audit:prod`, `audit:all`, and the rest of `verify` (refs-gate, versions, typecheck, lint, knip, unit/integration tests) all ran and passed.

### Approval gate status (plan §11)

- Marketplace is in scope; Tasks 5–6 were implemented.
- `MERGE_HEAD` + zero unmerged paths → `conflicted` accepted as the KISS classification (see Task 1).
- `paneExists` uses the throwing argument-array path (`execFileAsync`) without touching global `silent` semantics.
- Diff cache retains one version per file identity, no content-hash subsystem.
- No additional conflict-monitor behavior was touched.
