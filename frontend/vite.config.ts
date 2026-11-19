import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** public/ holds the mock fixture and the static-build data; each build keeps only what it uses. */
function dropUnusedAssets(isMock: boolean, isStatic: boolean): Plugin {
  return {
    name: 'drop-unused-assets',
    apply: 'build',
    closeBundle() {
      if (!isMock) rmSync(resolve(__dirname, 'dist/mock'), { recursive: true, force: true });
      if (!isStatic) rmSync(resolve(__dirname, 'dist/static-data'), { recursive: true, force: true });
    },
  };
}

/** Deep links on GitHub Pages. Route-sheet URLs (/sheet/c22/A-Tue?absence=…) get a copy of the app
 * at sheet/<cleaner>/<day>.html, which Pages serves for the extensionless URL with status 200; any
 * other path falls back to 404.html (also the app), which keeps the URL and query. */
function spaFallback(isStatic: boolean): Plugin {
  return {
    name: 'spa-fallback',
    apply: 'build',
    closeBundle() {
      if (!isStatic) return;
      const dist = resolve(__dirname, 'dist');
      const index = resolve(dist, 'index.html');
      copyFileSync(index, resolve(dist, '404.html'));
      const plans = resolve(dist, 'static-data/plans');
      const meta = JSON.parse(readFileSync(resolve(dist, 'static-data/meta.json'), 'utf8')) as { day_keys: string[] };
      const ids = new Set<string>();
      for (const f of readdirSync(plans)) {
        const { plan } = JSON.parse(readFileSync(resolve(plans, f), 'utf8')) as { plan: { cleaners: { id: string }[] } };
        plan.cleaners.forEach((c) => ids.add(c.id));
      }
      for (const id of ids) {
        mkdirSync(resolve(dist, 'sheet', id), { recursive: true });
        for (const day of meta.day_keys) copyFileSync(index, resolve(dist, 'sheet', id, `${day}.html`));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const isMock = env.VITE_MOCK === '1';
  const isStatic = env.VITE_STATIC === '1';
  return {
    // the static build is served from https://<user>.github.io/cleanplan-athens/
    base: isStatic ? env.STATIC_BASE || '/cleanplan-athens/' : '/',
    plugins: [react(), dropUnusedAssets(isMock, isStatic), spaFallback(isStatic)],
    server: {
      port: 5173,
      // API_TARGET lets you point the dev proxy elsewhere; default per contract.
      proxy: { '/api': { target: env.API_TARGET || 'http://localhost:8000', changeOrigin: true } },
    },
    preview: { port: 4173 },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  };
});
