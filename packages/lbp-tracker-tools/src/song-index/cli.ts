/**
 * The song index, built from the public archive: every music sequencer of the
 * LBP2 and LBP3 levels over a play count, grouped into songs with their
 * variants, makers and levels, and written as the files the page's song index
 * reads. steering/level-sources.md, *The song index*, has what each step
 * found; steering/tools.md, *Environment variables*, the folders.
 *
 *     npm run song-index -- list      [--min-plays 1000] [--max-plays N] [--include-lbp1]
 *     npm run song-index -- download  [--min-plays 1000] [--max-plays N] [--workers 32] [--parallel 8] [--min-free-gb 10]
 *     npm run song-index -- scan      [--retry-failed] [--workers N] [--limit N]
 *     npm run song-index -- cluster   [--threshold 0.5]
 *     npm run song-index -- export    [--out fixtures/songindex]
 *     npm run song-index -- build     # scan, cluster, export
 *     npm run song-index -- set-author <song id> <maker> [--note "…"]   # '' clears it
 *
 * `download` and `scan` resume where they stopped: a level with a manifest is
 * not fetched again, a resource already recorded is not read again.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FETCH, fetchLevels, freeGb, Store, ZipClient, ZipIndex, type SlotRow } from './archive.ts';
import { cluster, setAuthor, THRESHOLD } from './cluster.ts';
import { archiveDir, DEFAULT_OUT, dryDb, openSongDb, row, zipIndexFile } from './db.ts';
import { exportIndex } from './export.ts';
import { DEFAULT_SCAN, forgetFailed, scan } from './scan.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'min-plays': { type: 'string', default: '1000' },
    'max-plays': { type: 'string' },
    'include-lbp1': { type: 'boolean', default: false },
    workers: { type: 'string' },
    parallel: { type: 'string', default: '8' },
    chunk: { type: 'string', default: '1000' },
    'min-free-gb': { type: 'string', default: '10' },
    limit: { type: 'string', default: '0' },
    'retry-failed': { type: 'boolean', default: false },
    threshold: { type: 'string', default: String(THRESHOLD) },
    out: { type: 'string', default: DEFAULT_OUT },
    note: { type: 'string' },
  },
});
const [command, ...rest] = positionals;

/**
 * The slots over the play count (and up to `--max-plays`, for taking a lower
 * band later), most played first; LBP1 left out unless asked, having no music
 * sequencer.
 */
function slots(dry: DatabaseSync): SlotRow[] {
  const lbp1 = values['include-lbp1'] ? '' : 'AND game <> 0';
  const limit = Number(values.limit);
  const max = values['max-plays'] === undefined ? Number.MAX_SAFE_INTEGER : Number(values['max-plays']);
  return dry.prepare(
    `SELECT id, name, npHandle, playCount, game, rootLevel, icon FROM slot
     WHERE playCount > ? AND playCount <= ? ${lbp1} ORDER BY playCount DESC ${limit ? 'LIMIT ' + limit : ''}`,
  ).all(Number(values['min-plays']), max).map((r) => row<SlotRow>(r));
}

async function download(): Promise<void> {
  const archive = archiveDir();
  const levelsDir = path.join(archive, 'levels');
  await mkdir(levelsDir, { recursive: true });
  const opts = { ...DEFAULT_FETCH, workers: Number(values.workers ?? DEFAULT_FETCH.workers) };
  const client = new ZipClient(opts);
  const index = new ZipIndex(zipIndexFile());
  await index.build(client, 8);
  const todo = slots(new DatabaseSync(dryDb(), { readOnly: true }))
    .filter((s) => !existsSync(path.join(levelsDir, `${s.id}.json`)));
  console.error(`${todo.length} levels to fetch (the others have their manifest)`);
  const store = new Store(archive, client, index, opts);
  const size = Number(values.chunk);
  const groups: SlotRow[][] = [];
  for (let i = 0; i < todo.length; i += size) groups.push(todo.slice(i, i + size));
  const minFree = Number(values['min-free-gb']);
  const started = Date.now();
  let done = 0;
  let failed = 0;
  let full = false;
  const next = async (): Promise<void> => {
    const group = groups.shift();
    if (!group || full) return;
    if (freeGb(archive) < minFree) {
      full = true;
      console.error(`  !! under ${minFree} GB free: no new groups started`);
      return;
    }
    let what: string;
    try {
      what = `${await fetchLevels(store, group, levelsDir)} waves`;
    } catch (e) {
      failed += group.length; // no manifests: the next run takes them again
      what = `FAILED ${e instanceof Error ? e.message : e}`;
    }
    done += group.length;
    const s = store.stats;
    const minutes = (Date.now() - started) / 60000;
    console.error(`[${done}/${todo.length}] ${what} | ${s.downloaded} fetched (${(s.bytes / 1e9).toFixed(2)} GB), ` +
      `${s.cached} already here, ${s.missing} not in the archive | ${client.requests} requests, ` +
      `429: ${client.rateLimited} | ${minutes.toFixed(1)} min, ${((minutes / done) * (todo.length - done) / 60).toFixed(1)} h left`);
    return next();
  };
  await Promise.all(Array.from({ length: Number(values.parallel) }, next));
  console.error(`Done${full ? ', stopped for disk space' : ''}: ${failed} levels failed; ${client.requests} requests, ` +
    `${client.rateLimited} answered 429.`);
  process.exit(0); // the store's idle workers would keep the loop alive
}

async function main(): Promise<void> {
  switch (command) {
    case 'list': {
      const rows = slots(new DatabaseSync(dryDb(), { readOnly: true }));
      for (const r of rows) {
        // Some names carry tabs and newlines; one line per level.
        process.stdout.write(`${r.id}\t${r.playCount}\tLBP${r.game + 1}\t${r.npHandle}\t${(r.name ?? '').split(/\s+/).join(' ')}\n`);
      }
      console.error(`\n${rows.length} levels with more than ${values['min-plays']} plays`);
      return;
    }
    case 'download':
      return download();
    case 'scan':
    case 'build': {
      const db = openSongDb();
      if (values['retry-failed']) {
        const forgot = forgetFailed(db);
        console.error(`${forgot.resources} unreadable resources forgotten, their levels to be revisited`);
      }
      await scan(db, {
        ...DEFAULT_SCAN, archive: archiveDir(), dryDb: dryDb(),
        workers: Number(values.workers ?? DEFAULT_SCAN.workers), limit: Number(values.limit),
        includeLbp1: values['include-lbp1']!,
      });
      if (command === 'scan') return;
      cluster(db, Number(values.threshold));
      console.error(`Exported ${await exportIndex(db, values.out!)} to ${values.out}`);
      return;
    }
    case 'cluster':
      cluster(openSongDb(), Number(values.threshold));
      return;
    case 'export': {
      const version = await exportIndex(openSongDb(), values.out!);
      console.error(`Exported ${version} to ${values.out}`);
      return;
    }
    case 'set-author': {
      const [song, author] = rest;
      if (!song || author === undefined) throw new Error('set-author <song id> <maker>, or <maker> as "" to clear it');
      const db = openSongDb();
      const name = setAuthor(db, Number(song), author, values.note);
      console.error(author ? `"${name}": made by ${author}` : `"${name}": correction cleared`);
      cluster(db, Number(values.threshold));
      return;
    }
    default:
      console.error('song-index list | download | scan | cluster | export | build | set-author (see the top of packages/lbp-tracker-tools/src/song-index/cli.ts)');
      process.exit(2);
  }
}

await main();
