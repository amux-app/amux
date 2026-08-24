import { exec as execAsync, execSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { promisify } from 'util';
import { describe, it } from 'vitest';
import { setupCinema, sleep, trace, VIEWPORT } from './demo/cinema';
import type { CutResult } from './demo/scenes';
import { runFullCut, runHeroCut } from './demo/scenes';
import { getAppWindow } from './e2e-helpers';

const exec = promisify(execAsync);

const ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(ROOT, '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const DEMO_OUTPUT_DIR = resolve(REPO_ROOT, '.tmp', 'demo');
const KEPT_WEBM_NAMES = new Set(['hero.webm', 'full.webm']);
const PROJECT_ROOT_TMUX_OPTION = '@aumx_project_root';

interface DemoSession {
  app: ElectronApplication;
  page: Page;
  e2eRoot: string;
  videoStartEpochMs: number;
  // Non-blocking: resolved via genuinely async tmux queries (not execSync)
  // so capturing it never steals wall-clock time from the cut's own
  // entrance/reveal timing — it has the whole cut's duration to resolve
  // before finalizeRecording needs it.
  tmuxSessionNamePromise: Promise<string | null>;
}

// Finds the exact tmux session this run's app created, by matching the
// session-tagged project root against our own uniquely-generated e2eRoot —
// never a name-substring guess, so cleanup can never touch another run's
// (or the user's own) session.
async function findSessionForProjectRoot(projectRoot: string): Promise<string | null> {
  let names: string[];
  try {
    const { stdout } = await exec('tmux list-sessions -F "#{session_name}" 2>/dev/null');
    names = stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const { stdout } = await exec(`tmux show -t "${name}" ${PROJECT_ROOT_TMUX_OPTION} 2>/dev/null`);
      const raw = stdout.trim();
      const prefix = `${PROJECT_ROOT_TMUX_OPTION} `;
      const value = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
      if (value === projectRoot) return name;
    } catch { /* option unset on this session */ }
  }
  return null;
}

function killTmuxSession(name: string | null): void {
  if (!name) return;
  try {
    execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* already gone */ }
}

// Playwright names Electron BrowserContext video files randomly inside
// DEMO_OUTPUT_DIR; finalizeRecording renames the intended one to hero.webm/
// full.webm, but stray extra windows (e.g. a transient devtools window)
// leave their own untouched random-named recordings behind.
function cleanupStrayWebmArtifacts(): void {
  for (const entry of readdirSync(DEMO_OUTPUT_DIR)) {
    if (entry.endsWith('.webm') && !KEPT_WEBM_NAMES.has(entry)) {
      rmSync(resolve(DEMO_OUTPUT_DIR, entry), { force: true });
    }
  }
}

async function launchDemoApp(): Promise<DemoSession> {
  if (!existsSync(MAIN_ENTRY)) throw new Error(`Build missing: ${MAIN_ENTRY}`);
  mkdirSync(DEMO_OUTPUT_DIR, { recursive: true });
  trace('launch:start');

  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    for (const name of sessions.split('\n').filter((s) => s.includes('aumx-demo'))) {
      execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
    }
  } catch { /* no tmux */ }

  const e2eRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'aumx-demo-cinema-')));
  let app: ElectronApplication | undefined;
  try {
    execSync('git init', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.email "demo@aumx.test"', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.name "aumx-demo"', { cwd: e2eRoot, stdio: 'ignore' });
    writeFileSync(resolve(e2eRoot, '.gitignore'), '.amux/\n.aumx/\n');
    execSync('git add .gitignore', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git commit -m "chore: demo workspace init"', { cwd: e2eRoot, stdio: 'ignore' });

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'),
    );

    trace('electron.launch:start');
    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: e2eRoot,
      env: { ...inheritedEnv, NODE_ENV: 'test', AUMX_DEV: 'true', AUMX_E2E: '1' },
      recordVideo: { dir: DEMO_OUTPUT_DIR, size: VIEWPORT },
    });
    trace('electron.launch:done');

    const page = await getAppWindow(app);
    const videoStartEpochMs = Date.now(); // closest proxy for the recording's t=0
    trace('getAppWindow:done');

    await app.context().addInitScript(() => {
      (window as any).__AUMX_E2E = true;
      // A solid cover, installed before React ever paints, so the raw
      // empty-state boot frame never reaches the recording. Scenes.ts removes
      // it itself once the staged fleet is installed and painted.
      const cover = document.createElement('div');
      cover.id = '__cinema_boot_cover';
      cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;pointer-events:none;';
      document.documentElement.appendChild(cover);
    });
    await page.reload();
    trace('page.reload:done');

    // Resize the BrowserWindow itself (not just the viewport) so the app shell
    // fills the recording frame — setViewportSize alone leaves the Electron
    // window at its default size, causing grey margins in the recording.
    const actualContentSize = await app.evaluate(({ BrowserWindow }, dims) => {
      const wins = BrowserWindow.getAllWindows();
      const win = wins.find((w) => !w.webContents.getURL().startsWith('devtools://')) ?? wins[0];
      if (!win) return null;
      win.setContentSize(dims.width, dims.height);
      win.center();
      return win.getContentSize();
    }, VIEWPORT);
    trace('window.resize:done');
    if (!actualContentSize || actualContentSize[0] !== VIEWPORT.width || actualContentSize[1] !== VIEWPORT.height) {
      const got = actualContentSize ? `${actualContentSize[0]}x${actualContentSize[1]}` : 'no window found';
      throw new Error(
        `BrowserWindow content size mismatch after setContentSize: expected `
        + `${VIEWPORT.width}x${VIEWPORT.height}, got ${got}. The host display may be too small to `
        + 'hold the recording viewport, which would letterbox the recording.',
      );
    }
    await sleep(400);
    await page.setViewportSize(VIEWPORT);
    trace('viewport.set:done');
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
    trace('app-shell:visible');
    await setupCinema(page);
    trace('setupCinema:done');

    const tmuxSessionNamePromise = findSessionForProjectRoot(e2eRoot);
    trace('tmux-session:capture-started');

    return {
      app, page, e2eRoot, videoStartEpochMs, tmuxSessionNamePromise,
    };
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    killTmuxSession(await findSessionForProjectRoot(e2eRoot).catch(() => null));
    rmSync(e2eRoot, { recursive: true, force: true });
    throw error;
  }
}

// Sidecar for the downstream encoder's head-trim: trim to
// revealEpochMs - videoStartEpochMs, then encode from there.
function writeMetaSidecar(session: DemoSession, cut: CutResult, baseName: string): void {
  const target = resolve(DEMO_OUTPUT_DIR, `${baseName}.meta.json`);
  writeFileSync(
    target,
    JSON.stringify({ videoStartEpochMs: session.videoStartEpochMs, revealEpochMs: cut.revealEpochMs }),
  );
}

async function finalizeRecording(session: DemoSession, outputFileName: string): Promise<void> {
  let videoPath: string | undefined;
  try {
    videoPath = await session.page.video()?.path();
  } catch { /* ignore */ }

  await session.app.close();
  killTmuxSession(await session.tmuxSessionNamePromise.catch(() => null));

  if (videoPath && existsSync(videoPath)) {
    const target = resolve(DEMO_OUTPUT_DIR, outputFileName);
    execSync(`mv "${videoPath}" "${target}"`);
    console.log(`\n✓ Recording saved → ${target}\n`);
  } else {
    console.log('Recording finalize: no video path resolved');
  }
  cleanupStrayWebmArtifacts();

  rmSync(session.e2eRoot, { recursive: true, force: true });
}

describe.runIf(process.env.AUMX_DEMO_VIDEO === '1')('Amux Cinematic Demo', () => {
  it('records the hero cut (~17.3s, seamless loop for the README autoplay hero)', async () => {
    const session = await launchDemoApp();
    try {
      const cut = await runHeroCut(session.page);
      writeMetaSidecar(session, cut, 'hero');
    } finally {
      await finalizeRecording(session, 'hero.webm');
    }
  }, 90_000);

  it('records the full cut (~50s, 7-scene narrative)', async () => {
    const session = await launchDemoApp();
    try {
      const cut = await runFullCut(session.page);
      writeMetaSidecar(session, cut, 'full');
    } finally {
      await finalizeRecording(session, 'full.webm');
    }
  }, 180_000);
});
