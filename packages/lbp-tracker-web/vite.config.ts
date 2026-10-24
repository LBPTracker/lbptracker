/**
 * The web package's build. The other two packages have none.
 *
 * ❗ **The bundler is confined to this package, and that is the point.**
 * `@lbptracker/lib` stays plain TypeScript that Node runs directly — `node
 * --test` needs no build step and no bundler, which is what keeps the fidelity
 * work honest (see steering/tracker-architecture.md). `@lbptracker/cwlib` is a
 * git dependency and arrives as the `dist/*.js` its own `prepare` built, which
 * is what Node runs too. Only the pages are bundled.
 *
 * ## Why a bundler at all, measured rather than assumed
 *
 * ⚠️ **Import maps do not reach a Worker or an AudioWorklet.** Probed in Chrome
 * on 2026-09-06 with a page carrying `{"@probe/": "./pkg/"}` and three
 * consumers:
 *
 * | context | bare specifier |
 * |---|---|
 * | the page | resolves |
 * | `new Worker(url, {type:'module'})` | load error |
 * | `audioWorklet.addModule(url)` | `Failed to resolve module specifier` |
 *
 * `render-worker.ts` reaches `assets.ts`, `render.ts` and `backup.ts`, so the
 * worker's module graph is very nearly the whole engine. Without a bundler,
 * every one of those files would have to name its neighbours with a relative
 * path across the package boundary, and the package names would buy nothing.
 * Vite resolves them in all three contexts, so the source says
 * `@lbptracker/cwlib/things/level.ts` everywhere and means it.
 *
 * ## The three things this config exists for
 *
 * 1. **One page.** `index.html` is the app; the render worker and the worklet are its other entries, found through their imports.
 * 2. **`base: './'`**, so the built site is relocatable — it works at a bucket's
 *    root or under a prefix. That property was tested rather than asserted
 *    before the bundler arrived and is tested the same way after.
 * 3. **`fixtures/` is served, never built.** See the plugin below.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const HERE = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(REPO, 'fixtures');

const MIME = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.wav', 'audio/wav'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.jsonl', 'application/x-ndjson; charset=utf-8'],
]);

/**
 * `/fixtures/…` out of the checkout, in dev and in preview.
 *
 * ❗ **Serving is not shipping.** The fixtures are the user's own game data,
 * extracted locally with `tools/ExtractGuid.java`, and they must never enter
 * `dist/` — see *Asset licensing* in steering/game-assets.md. So this is a dev
 * and preview middleware and deliberately not `publicDir`, which would copy the
 * lot into the build output.
 *
 * They live at the repository root, one level above this package's Vite root,
 * which is the other reason the pages cannot simply reach them: Vite's dev
 * server does not serve outside its root without being told to.
 */
function fixtures(): Plugin {
  const serve = async (req: { url?: string }, res: any, next: () => void) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/fixtures/')) return next();
    // Confine to `fixtures/` whatever the URL claims, after decoding: three of
    // the game's samples carry a `#` and 48 more a space, so the path that
    // arrives here is percent-encoded (see `asset()` in src/assets.ts).
    const file = path.resolve(REPO, '.' + decodeURIComponent(url));
    if (!file.startsWith(FIXTURES + path.sep)) {
      res.statusCode = 403;
      return res.end('outside fixtures/');
    }
    try {
      const body = await readFile(file);
      res.setHeader('content-type', MIME.get(path.extname(file)) ?? 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end(`not found: ${url}`);
    }
  };
  return {
    name: 'lbptracker:fixtures',
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}

export default defineConfig({
  root: HERE,
  base: './',
  // 8173 and 8174 are what every note, page and bookmark in this project says.
  server: { host: '127.0.0.1', port: 8173, strictPort: true },
  preview: { host: '127.0.0.1', port: 8174, strictPort: true },
  // Pre-bundling either library would hand the browser an esbuild copy instead
  // of the file `node --test` runs, which is exactly the property this project
  // keeps: `lib`'s source, and cwlib's built `dist/`.
  optimizeDeps: { exclude: ['@lbptracker/cwlib', '@lbptracker/lib'] },
  build: {
    outDir: path.join(REPO, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.join(HERE, 'index.html'),
      },
    },
  },
  plugins: [vue(), fixtures()],
});
