import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'path';
import type { Plugin } from 'vite';

const buildCrashReportUrl = process.env.MUXBASE_CRASH_REPORT_URL?.trim() ?? '';

// Worktree-scoped dev sets MUXBASE_RENDERER_PORT to avoid colliding with main
// checkout's `make dev` (which sticks to the default 5273).
const rendererPort = Number(process.env.MUXBASE_RENDERER_PORT) || 5273;

function externalizeMuxBase(): Plugin {
  return {
    name: 'externalize-muxbase',
    enforce: 'pre',
    resolveId(source) {
      // This leaf is browser-safe and intentionally bundled into the renderer.
      // The rest of muxbase/core remains a main-process-only external dependency.
      if (source === 'muxbase/pane-name' || source === 'muxbase/pane-terminal-profile') return null;
      if (source === 'muxbase' || source === 'muxbase/core' || source.startsWith('muxbase/')) {
        return { id: source, external: true };
      }
      return null;
    },
  };
}

export default defineConfig({
  main: {
    define: {
      'process.env.MUXBASE_BUILD_CRASH_REPORT_URL': JSON.stringify(buildCrashReportUrl),
    },
    plugins: [externalizeMuxBase()],
    build: {
      rollupOptions: {
        input: {
          formatterWorker: resolve(__dirname, 'src/main/formatter/formatterWorker.ts'),
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        external: ['diff', 'node-pty', 'prettier'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/preload.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    plugins: [externalizeMuxBase(), react(), tailwindcss()],
    root: resolve(__dirname, 'src/renderer'),
    server: {
      port: rendererPort,
      strictPort: true,
    },
    build: {
      assetsInlineLimit: 0,
      // Renderer chunks have explicit entry and lazy-chunk byte budgets in build.test.ts.
      // Match the largest enforced budget so Vite's generic 500 kB warning does
      // not contradict those more precise regression gates.
      chunkSizeWarningLimit: 1950,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
