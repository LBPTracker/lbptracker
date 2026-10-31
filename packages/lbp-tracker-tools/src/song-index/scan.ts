/**
 * Every sequencer in the downloaded levels, into the song database.
 *
 * Reads each level's manifest, sends the resources nobody has read yet to a
 * pool of threads (`scan-worker.ts`), and records what they found. ❗ **A
 * resource is read once however many levels use it** — the 184,588 levels
 * share their plans — and a re-run skips every resource already recorded, so
 * after a reader fix only the resources that failed need reading again
 * (`--retry-failed`): 1,813 resources in 3.4 minutes on 2026-10-31, against 23.5
 * minutes for the whole archive.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { row } from './db.ts';
import type { Manifest } from './archive.ts';
import type { ResourceResult } from './scan-worker.ts';

class Pool {
  private idle: Worker[] = [];
  private queue: { shas: string[]; done: (r: ResourceResult[]) => void }[] = [];
  private busy = new Map<Worker, (r: ResourceResult[]) => void>();

  static async start(size: number, archive: string): Promise<Pool> {
    const pool = new Pool();
    const file = new URL('./scan-worker.ts', import.meta.url);
    await Promise.all(Array.from({ length: size }, () => new Promise<void>((ok, fail) => {
      const worker = new Worker(file, { workerData: { archive } });
      worker.once('error', fail);
      worker.once('message', () => {
        worker.on('message', (r: ResourceResult[]) => {
          const done = pool.busy.get(worker)!;
          pool.busy.delete(worker);
          pool.idle.push(worker);
          pool.pump();
          done(r);
        });
        pool.idle.push(worker);
        ok();
      });
    })));
    return pool;
  }

  run(shas: string[]): Promise<ResourceResult[]> {
    return new Promise((done) => {
      this.queue.push({ shas, done });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(worker, job.done);
      worker.postMessage(job.shas);
    }
  }

  stop(): void {
    for (const w of [...this.idle, ...this.busy.keys()]) void w.terminate();
  }
}

export interface ScanOptions {
  readonly archive: string;
  readonly dryDb: string;
  readonly workers: number;
  /** Levels per batch: what is read between two commits. */
  readonly batch: number;
  readonly limit: number;
  /** LBP1 has no music sequencer; its levels are recorded and not read. */
  readonly includeLbp1: boolean;
}

export const DEFAULT_SCAN = { workers: Math.max(1, availableParallelism() - 2), batch: 1000, limit: 0, includeLbp1: false };

/** Forget the resources a reader could not open, so the next scan reads them again. */
export function forgetFailed(db: DatabaseSync): { resources: number; levels: number } {
  db.exec('BEGIN');
  const resources = Number(db.prepare('DELETE FROM resource WHERE error IS NOT NULL').run().changes);
  // Their levels are revisited; every other resource of theirs is skipped as known.
  const levels = resources ? Number(db.prepare('DELETE FROM level WHERE game IS NULL OR game <> 0').run().changes) : 0;
  db.exec('COMMIT');
  return { resources, levels };
}

export async function scan(db: DatabaseSync, opts: ScanOptions): Promise<void> {
  const dry = new DatabaseSync(opts.dryDb, { readOnly: true });
  const slotOf = dry.prepare(
    `SELECT name, npHandle, game, playCount, uniquePlayCount, heartCount, thumbsup, firstPublished, lastUpdated
     FROM slot WHERE id = ?`,
  );
  const manifests = path.join(opts.archive, 'levels');
  const done = new Set(db.prepare('SELECT slot_id FROM level').all().map((r) => row<{ slot_id: number }>(r).slot_id));
  let files = (await readdir(manifests)).filter((f) => f.endsWith('.json') && !done.has(Number(f.slice(0, -5))));
  if (opts.limit) files = files.slice(0, opts.limit);
  console.error(`${files.length} levels to read (${done.size} already done)`);
  if (!files.length) return;

  const pool = await Pool.start(opts.workers, opts.archive);
  const st = statements(db);
  const started = Date.now();
  let read = 0, errors = 0, skipped = 0, lbp1 = 0;
  try {
    for (let i = 0; i < files.length; i += opts.batch) {
      const levels: { id: number; resources: string[]; slot: Slot | undefined }[] = [];
      const wanted = new Set<string>();
      for (const f of files.slice(i, i + opts.batch)) {
        let manifest: Manifest;
        try {
          manifest = JSON.parse(await readFile(path.join(manifests, f), 'utf8')) as Manifest;
        } catch {
          skipped++; // still being written by the downloader: next time
          continue;
        }
        const slot = slotOf.get(manifest.id) as Slot | undefined;
        if (slot?.game === 0 && !opts.includeLbp1) {
          lbp1++;
          st.level.run(...levelValues(manifest.id, slot, 0));
          continue;
        }
        levels.push({ id: manifest.id, resources: manifest.resources, slot });
        for (const sha of manifest.resources) if (!st.known.get(sha)) wanted.add(sha);
      }
      const shas = [...wanted];
      const jobs: Promise<ResourceResult[]>[] = [];
      for (let j = 0; j < shas.length; j += 16) jobs.push(pool.run(shas.slice(j, j + 16)));
      const results = (await Promise.all(jobs)).flat();
      read += results.length;

      db.exec('BEGIN');
      for (const r of results) {
        if (r.error) errors++;
        st.resource.run(r.sha, r.magic, r.sequencers.length, r.problems, r.error);
        for (const s of r.sequencers) {
          st.content.run(s.contentHash, s.musicHash, s.tempo, s.swing, s.tracks, s.notes, s.lengthSteps,
            JSON.stringify(s.instruments), s.minhash);
          const id = row<{ id: number }>(st.contentId.get(s.contentHash)).id;
          st.occurrence.run(r.sha, s.uid, id, s.name, s.author, s.planGuid, s.mmGroup ? 1 : 0);
        }
      }
      for (const level of levels) {
        for (const sha of level.resources) {
          const known = st.known.get(sha) as { n_sequencers: number } | undefined;
          if (known && known.n_sequencers > 0) st.levelResource.run(level.id, sha);
        }
        const n = row<{ n: number }>(st.countSeq.get(level.id)).n;
        st.level.run(...levelValues(level.id, level.slot, n));
      }
      db.exec('COMMIT');

      const at = Math.min(i + opts.batch, files.length);
      const seconds = (Date.now() - started) / 1000;
      const left = ((seconds / at) * (files.length - at)) / 60;
      const occ = row<{ n: number }>(db.prepare('SELECT count(*) AS n FROM occurrence').get()).n;
      console.error(`[${at}/${files.length}] levels | ${read} resources read (${errors} failed) | ` +
        `${occ} sequencers | ${(seconds / 60).toFixed(1)} min, ${left.toFixed(0)} min left`);
    }
  } finally {
    pool.stop();
  }
  console.error(`Read ${files.length - skipped - lbp1} levels; ${lbp1} LBP1 levels recorded unread; ` +
    `${skipped} manifests not readable yet.`);
}

interface Slot {
  name: string; npHandle: string; game: number; playCount: number; uniquePlayCount: number;
  heartCount: number; thumbsup: number; firstPublished: number | null; lastUpdated: number | null;
}

function levelValues(id: number, s: Slot | undefined, sequencers: number) {
  return [id, s?.name ?? null, s?.npHandle ?? null, s?.game ?? null, s?.playCount ?? null,
    s?.uniquePlayCount ?? null, s?.heartCount ?? null, s?.thumbsup ?? null, s?.firstPublished ?? null,
    s?.lastUpdated ?? null, sequencers] as const;
}

function statements(db: DatabaseSync): Record<string, StatementSync> {
  return {
    known: db.prepare('SELECT n_sequencers FROM resource WHERE sha = ?'),
    resource: db.prepare('INSERT OR REPLACE INTO resource VALUES (?, ?, ?, ?, ?)'),
    content: db.prepare(
      `INSERT OR IGNORE INTO content (content_hash, music_hash, tempo, swing, n_tracks, n_notes, length_steps,
       instruments, minhash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    contentId: db.prepare('SELECT id FROM content WHERE content_hash = ?'),
    occurrence: db.prepare(
      'INSERT INTO occurrence (sha, uid, content_id, name, author, plan_guid, mm_group) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    levelResource: db.prepare('INSERT OR IGNORE INTO level_resource VALUES (?, ?)'),
    level: db.prepare('INSERT OR REPLACE INTO level VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    countSeq: db.prepare(
      'SELECT count(*) AS n FROM level_resource lr JOIN occurrence o ON o.sha = lr.sha WHERE lr.slot_id = ?',
    ),
  };
}
