/**
 * Stage the site for deployment: `dist/` plus the assets the pages fetch.
 *
 *     npm run stage      # vite build, then this
 *     npm run deploy     # stage, then `wrangler deploy`
 *
 * ❗ **`vite build` alone never copies `fixtures/`**, and that stands: it is
 * the property steering/game-assets.md describes, and a build that silently
 * carried game data would be the wrong kind of surprise. This script is the
 * one place that puts game data into `dist/`. It runs only when a deployment
 * is asked for, it copies exactly what the manifests name, and it prints what
 * it copied.
 *
 * What goes in: `fixtures/rinst` and `fixtures/smp` with their manifests — the
 * two directories `src/assets.ts` fetches — and the song index's current
 * export when there is one (`stageSongIndex`), and nothing else. `fixtures/archive`
 * stays out: the pages read levels from archive.org directly
 * (`src/lbparchive.ts`); the local copy exists for the tests.
 *
 * ⚠️ **Names are made boring on the way.** Three samples carry a `#` and 48 a
 * space. `asset()` percent-encodes both, and the dev server and Vite's preview
 * decode them back — but whether a static host maps `%23` onto a file whose
 * name holds a `#` is the host's business, and this exact class of trap once
 * cost a day (see the header of `src/assets.ts`). The manifest is the
 * indirection built for this: the copied file is `choir_f-sharp3_v2.smp`, the
 * staged manifest says so, and `fixtures/` on disk is untouched. `publicName`
 * is the rule, and `test/stage-site.test.ts` holds it to being the identity
 * under `encodeURIComponent` over the whole real manifest.
 *
 * `_headers` is written here too, because `vite build` empties `dist/` first:
 * hashed bundles are immutable, the samples are game data that does not
 * change, and the manifests get a day.
 */

import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO = path.resolve(HERE, '..', '..', '..');
const FIXTURES = path.join(REPO, 'fixtures');
const DIST = path.join(REPO, 'dist');

/** The two directories `src/assets.ts` fetches, by name under `fixtures/`. */
const SHIPPED = ['rinst', 'smp'] as const;

type Row = { guid: number; file: string; path: string; size: number };

/** A file name any static host serves under its percent-encoded form. */
export const publicName = (file: string): string =>
  file.replace(/#/g, '-sharp').replace(/ /g, '_');

const HEADERS = `# Written by packages/lbp-tracker-web/dev/stage-site.ts on every stage.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/fixtures/*
  Cache-Control: public, max-age=86400
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
/*
  X-Content-Type-Options: nosniff
`;

async function stageDir(name: (typeof SHIPPED)[number]): Promise<{ files: number; bytes: number }> {
  const from = path.join(FIXTURES, name);
  const to = path.join(DIST, 'fixtures', name);
  let rows: Row[];
  try {
    rows = JSON.parse(await readFile(path.join(from, 'manifest.json'), 'utf8')) as Row[];
  } catch {
    throw new Error(
      `no ${path.relative(REPO, from)}/manifest.json — extract the game's data first; ` +
        'steering/tools.md says how',
    );
  }
  await mkdir(to, { recursive: true });
  const seen = new Map<string, string>();
  let bytes = 0;
  const staged: Row[] = [];
  for (const row of rows) {
    const pub = publicName(row.file);
    const clash = seen.get(pub);
    if (clash !== undefined && clash !== row.file) {
      throw new Error(`publicName collides: "${clash}" and "${row.file}" both become "${pub}"`);
    }
    seen.set(pub, row.file);
    const source = path.join(from, row.file);
    await copyFile(source, path.join(to, pub));
    bytes += (await stat(source)).size;
    staged.push({ ...row, file: pub });
  }
  await writeFile(path.join(to, 'manifest.json'), JSON.stringify(staged));
  return { files: rows.length + 1, bytes };
}

/**
 * The song index, when this machine has one: `index.json` and the one export it
 * names, never the older ones beside it.
 *
 * ❗ **Optional, unlike the samples.** It is built outside this repository from
 * the archive's whole download (steering/level-sources.md, *The song index*),
 * so a checkout without it still stages a working site, whose index panel says
 * the index is not available. It is not game data: names, numbers and the
 * hashes of levels that are already public.
 */
async function stageSongIndex(): Promise<{ files: number; bytes: number } | undefined> {
  const from = path.join(FIXTURES, 'songindex');
  let head: { version?: unknown };
  try {
    head = JSON.parse(await readFile(path.join(from, 'index.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof head.version !== 'string' || !/^[\w-]+$/.test(head.version)) {
    throw new Error(`${path.relative(REPO, from)}/index.json names no export`);
  }
  const to = path.join(DIST, 'fixtures', 'songindex');
  await cp(path.join(from, head.version), path.join(to, head.version), { recursive: true });
  await copyFile(path.join(from, 'index.json'), path.join(to, 'index.json'));
  let files = 1;
  let bytes = (await stat(path.join(from, 'index.json'))).size;
  for (const entry of await readdir(path.join(to, head.version), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

export async function stage(): Promise<void> {
  try {
    await stat(path.join(DIST, 'index.html'));
  } catch {
    throw new Error(`no ${path.relative(REPO, DIST)}/index.html — run \`vite build\` first`);
  }
  let files = 0;
  let bytes = 0;
  for (const name of SHIPPED) {
    const done = await stageDir(name);
    files += done.files;
    bytes += done.bytes;
    console.log(`fixtures/${name}: ${done.files} files, ${(done.bytes / 1e6).toFixed(1)} MB`);
  }
  const songs = await stageSongIndex();
  if (songs) {
    files += songs.files;
    bytes += songs.bytes;
    console.log(`fixtures/songindex: ${songs.files} files, ${(songs.bytes / 1e6).toFixed(1)} MB`);
  } else {
    console.log('fixtures/songindex: none here, so the song index panel will say it is not available');
  }
  await writeFile(path.join(DIST, '_headers'), HEADERS);
  console.log(
    `staged ${files} asset files (${(bytes / 1e6).toFixed(1)} MB) into dist/fixtures, plus _headers`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await stage();
}
