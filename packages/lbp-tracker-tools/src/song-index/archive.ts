/**
 * The archive's copy on this machine: every level over a play count, with every
 * resource it depends on, fetched out of the dry23 zips by byte range.
 *
 * Measured on 2026-10-31, 184,588 levels with more than 1,000 plays: 42.5
 * minutes, 2,227,249 resources, 29.9 GB, 46,456 requests, **no 429**, at 32
 * requests in flight. The numbers behind each choice:
 *
 * - **One queue per zip, shared by every group of levels.** A worker that comes
 *   free takes the zip with most entries waiting, all of them in one request:
 *   under load the queues grow and the requests fill (about 60 entries each),
 *   and when the load drops — a group's last waves — the few left go at once.
 * - **Several groups at a time.** Dependencies are known only once the file
 *   that names them is read, so a group is waves; one group's last waves leave
 *   the workers idle unless others are running. 4,000 levels: 6.4 min one at a
 *   time, 4.1 min four at a time.
 * - **32 requests in flight.** 64 went 1.4× faster, and the servers began
 *   closing idle connections; 32 never saw either.
 * - ❗ **A 429 stops every worker**, not only the one that got it, for the
 *   `Retry-After` it gives and never less than a minute.
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statfsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readDependencies } from '@lbptracker/cwlib/io/resource.ts';
import { resourcePath, row } from './db.ts';
import {
  batches,
  centralDirectory,
  cut,
  readCentralDirectory,
  readMultipart,
  zipOf,
  zipPath,
  type Entry,
  type Part,
} from './zip-ranges.ts';

const USER_AGENT = 'lbptracker-song-index/1 (+https://lbptracker.sgdc3.it)';

export interface FetchOptions {
  /** Requests in flight. */
  readonly workers: number;
  /** Intervals per request. */
  readonly batch: number;
  /** Bytes per request. */
  readonly maxBatchBytes: number;
  readonly retries: number;
  readonly timeoutMs: number;
}

export const DEFAULT_FETCH: FetchOptions = {
  workers: 32, batch: 200, maxBatchBytes: 32 << 20, retries: 6, timeoutMs: 60_000,
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Byte ranges of the dry23 zips, straight from the servers that hold each item. */
export class ZipClient {
  requests = 0;
  bytes = 0;
  rateLimited = 0;
  private pauseUntil = 0;
  private servers = new Map<string, Promise<string[]>>();
  private readonly opts: FetchOptions;

  constructor(opts: FetchOptions) {
    this.opts = opts;
  }

  /**
   * The item's own servers. `archive.org/download/…` would redirect every
   * request to one of them; asking once saves a round trip each time.
   */
  private bases(item: string): Promise<string[]> {
    let bases = this.servers.get(item);
    if (!bases) {
      bases = (async () => {
        const answer = await fetch(`https://archive.org/metadata/${item}`, { headers: { 'User-Agent': USER_AGENT } });
        const meta = (await answer.json()) as { d1: string; d2: string; dir: string; workable_servers?: string[] };
        return (meta.workable_servers ?? [meta.d1, meta.d2]).map((host) => `https://${host}${meta.dir}`);
      })();
      bases.catch(() => this.servers.delete(item));
      this.servers.set(item, bases);
    }
    return bases;
  }

  private async waitPause(): Promise<void> {
    for (let wait = this.pauseUntil - Date.now(); wait > 0; wait = this.pauseUntil - Date.now()) await sleep(wait);
  }

  private pause(answer: Response): void {
    const asked = Number(answer.headers.get('retry-after'));
    const seconds = Math.max(60, Number.isFinite(asked) ? asked : 120);
    this.rateLimited++;
    const until = Date.now() + seconds * 1000;
    if (until > this.pauseUntil) {
      this.pauseUntil = until;
      console.error(`  !! HTTP 429 from archive.org: every worker waits ${seconds}s (${this.rateLimited} so far; consider fewer workers)`);
    }
  }

  /** `bytes=…` of one zip; the parts that came back. */
  async get(zip: string, spec: string): Promise<Part[]> {
    const { item, file } = zipPath(zip);
    const bases = await this.bases(item);
    let delay = 2000;
    let error = '';
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      await this.waitPause();
      const url = `${bases[attempt % bases.length]}/${file}`;
      try {
        const answer = await fetch(url, {
          headers: { Range: spec, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const body = new Uint8Array(await answer.arrayBuffer());
        if (answer.status === 206) {
          this.requests++;
          this.bytes += body.length;
          const type = answer.headers.get('content-type') ?? '';
          if (type.startsWith('multipart/byteranges')) {
            return readMultipart(body, type.split('boundary=')[1].trim().replace(/^"|"$/g, ''));
          }
          const m = /bytes (\d+)-/.exec(answer.headers.get('content-range') ?? '');
          if (!m) throw new Error('206 without Content-Range');
          return [[Number(m[1]), body]];
        }
        error = `HTTP ${answer.status}`;
        if (answer.status === 429) {
          this.pause(answer); // the pause replaces this worker's own backoff
          continue;
        }
        if (answer.status < 500) throw new Error(`${file}: ${error}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith(`${file}:`)) throw e;
        error = e instanceof Error ? e.message : String(e);
      }
      if (attempt < this.opts.retries) {
        console.error(`  ! ${file} on ${new URL(url).host}: ${error}, again in ${delay / 1000}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 300_000);
      }
    }
    throw new Error(`${file}: ${error}`);
  }
}

/**
 * Where every resource is: SHA-1 → offset and size, out of the 256 central
 * directories. Built once, 6.7 minutes and 2.4 GB for 61,743,686 entries; the
 * zip is the SHA-1's first byte, so it is not stored.
 */
export class ZipIndex {
  private readonly db: DatabaseSync;
  private readonly find;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS entry (sha BLOB PRIMARY KEY, offset INTEGER, size INTEGER) WITHOUT ROWID');
    this.db.exec('CREATE TABLE IF NOT EXISTS zip_done (zip TEXT PRIMARY KEY, entries INTEGER)');
    this.find = this.db.prepare('SELECT offset, size FROM entry WHERE sha = ?');
  }

  async build(client: ZipClient, workers: number): Promise<void> {
    const done = new Set(this.db.prepare('SELECT zip FROM zip_done').all().map((r) => row<{ zip: string }>(r).zip));
    const todo = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).filter((z) => !done.has(z));
    if (!todo.length) return;
    console.error(`Indexing the zips: ${todo.length} central directories to read…`);
    const insert = this.db.prepare('INSERT OR REPLACE INTO entry VALUES (?, ?, ?)');
    const mark = this.db.prepare('INSERT OR REPLACE INTO zip_done VALUES (?, ?)');
    const started = Date.now();
    let n = 0;
    const next = async (): Promise<void> => {
      const zip = todo.shift();
      if (!zip) return;
      const [[, tail]] = await client.get(zip, 'bytes=-65536');
      const where = centralDirectory(tail);
      const parts = await client.get(zip, `bytes=${where.offset}-${where.offset + where.size - 1}`);
      const entries = readCentralDirectory(Buffer.concat(parts.map(([, b]) => b)));
      this.db.exec('BEGIN');
      for (const e of entries) insert.run(Buffer.from(e.sha1, 'hex'), e.offset, e.size);
      mark.run(zip, entries.length);
      this.db.exec('COMMIT');
      console.error(`  [${++n}] dry${zip}.zip: ${entries.length} entries (${Math.round((Date.now() - started) / 1000)}s)`);
      return next();
    };
    await Promise.all(Array.from({ length: workers }, next));
  }

  lookup(sha1: string): Entry | undefined {
    const found = this.find.get(Buffer.from(sha1, 'hex'));
    if (!found) return undefined;
    const r = row<{ offset: number; size: number }>(found);
    return { sha1, offset: r.offset, size: r.size };
  }
}

/** The SHA-1 dependencies a resource names; a file that is no resource names none. */
export function shaDependencies(bytes: Uint8Array): string[] {
  try {
    return readDependencies(bytes).flatMap((d) => (d.kind === 'sha1' ? [d.sha1] : []));
  } catch {
    return [];
  }
}

/** What `resolve` knows of a resource: its dependencies, or `null` when the archive does not have it. */
export type Known = Map<string, string[] | null>;

/**
 * The local store and the shared queue that fills it.
 *
 * ❗ **A resource two groups want is fetched once**: the first to ask claims
 * it, the other waits for that claim and then reads it from disk; if the first
 * failed, the second asks again itself.
 */
export class Store {
  readonly stats = { downloaded: 0, cached: 0, missing: 0, bytes: 0 };
  private readonly pending = new Map<string, Entry[]>();
  private readonly inflight = new Map<string, Promise<string[] | Error>>();
  private readonly settle = new Map<string, (r: string[] | Error) => void>();
  /** Workers with nothing to do, each waiting to be woken. */
  private sleepers: (() => void)[] = [];

  private readonly archive: string;
  private readonly client: ZipClient;
  private readonly index: ZipIndex;
  private readonly opts: FetchOptions;

  constructor(archive: string, client: ZipClient, index: ZipIndex, opts: FetchOptions) {
    this.archive = archive;
    this.client = client;
    this.index = index;
    this.opts = opts;
    for (let i = 0; i < opts.workers; i++) void this.worker();
  }

  private async worker(): Promise<never> {
    for (;;) {
      if (this.pending.size === 0) {
        await new Promise<void>((done) => this.sleepers.push(done));
        continue;
      }
      // The fullest queue: under load that is the biggest request there is.
      let zip = '';
      let most = -1;
      for (const [z, list] of this.pending) if (list.length > most) [zip, most] = [z, list.length];
      const queue = this.pending.get(zip)!;
      const taken = queue.splice(0, this.opts.batch);
      if (!queue.length) this.pending.delete(zip);
      taken.sort((a, b) => a.offset - b.offset);
      for (const b of batches(taken, this.opts.batch, this.opts.maxBatchBytes)) {
        let results: Map<string, string[] | Error>;
        try {
          results = await this.fetchBatch(zip, b.entries, b.ranges);
        } catch (e) {
          results = new Map(b.entries.map((x) => [x.sha1, e instanceof Error ? e : new Error(String(e))]));
        }
        for (const [sha1, r] of results) {
          this.inflight.delete(sha1);
          this.settle.get(sha1)?.(r);
          this.settle.delete(sha1);
        }
      }
    }
  }

  private async fetchBatch(
    zip: string,
    entries: readonly Entry[],
    ranges: readonly (readonly [number, number])[],
  ): Promise<Map<string, string[] | Error>> {
    const parts = await this.client.get(zip, `bytes=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`);
    const out = new Map<string, string[] | Error>();
    for (const entry of entries) {
      let data = cut(parts, entry);
      if (data && !(data instanceof Uint8Array)) {
        const [from, to] = data.refetch; // an extra field longer than the slack
        data = (await this.client.get(zip, `bytes=${from}-${to}`))[0][1];
      }
      if (!data || createHash('sha1').update(data).digest('hex') !== entry.sha1) {
        out.set(entry.sha1, new Error(`${entry.sha1} is not what dry${zip}.zip holds there`));
        continue;
      }
      const file = resourcePath(this.archive, entry.sha1);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.part`, data);
      await rename(`${file}.part`, file);
      this.stats.downloaded++;
      this.stats.bytes += entry.size;
      out.set(entry.sha1, shaDependencies(data));
    }
    return out;
  }

  /** Make these resources local; their dependencies, or null for the ones the archive lacks. */
  async resolve(shas: Iterable<string>): Promise<Known> {
    const known: Known = new Map();
    const waits: [string, Promise<string[] | Error>][] = [];
    const theirs: string[] = [];
    for (const sha1 of shas) {
      const other = this.inflight.get(sha1);
      if (other) {
        theirs.push(sha1);
        continue;
      }
      const file = resourcePath(this.archive, sha1);
      if (existsSync(file)) {
        known.set(sha1, shaDependencies(await readFile(file)));
        this.stats.cached++;
        continue;
      }
      const entry = this.index.lookup(sha1);
      if (!entry) {
        known.set(sha1, null);
        this.stats.missing++;
        continue;
      }
      const promise = new Promise<string[] | Error>((done) => this.settle.set(sha1, done));
      this.inflight.set(sha1, promise);
      waits.push([sha1, promise]);
      const zip = zipOf(sha1);
      const queue = this.pending.get(zip);
      if (queue) queue.push(entry);
      else this.pending.set(zip, [entry]);
    }
    if (this.pending.size) for (const wake of this.sleepers.splice(0)) wake();
    let failure: Error | undefined;
    for (const [sha1, promise] of waits) {
      const r = await promise;
      if (r instanceof Error) failure ??= r;
      else known.set(sha1, r);
    }
    if (failure) throw failure;
    if (theirs.length) {
      // Our own requests never wait on anyone's, so this cannot deadlock.
      await Promise.all(theirs.map((s) => this.inflight.get(s)));
      for (const [s, r] of await this.resolve(theirs)) known.set(s, r);
    }
    return known;
  }
}

/** One level as `levels/<id>.json` records it: the format the Python downloader wrote, kept. */
export interface Manifest {
  readonly id: number;
  readonly name: string;
  readonly author: string;
  readonly playCount: number;
  readonly game: number;
  readonly rootLevel: string | null;
  readonly icon: string | null;
  readonly resources: string[];
  readonly missing: string[];
}

export interface SlotRow {
  readonly id: number;
  readonly name: string;
  readonly npHandle: string;
  readonly playCount: number;
  readonly game: number;
  readonly rootLevel: Uint8Array | null;
  readonly icon: Uint8Array | null;
}

/** A 20-byte reference is a SHA-1; four bytes are a GUID, which is a game asset and not in the archive. */
const refSha = (blob: Uint8Array | null): string | null =>
  blob && blob.length === 20 ? Buffer.from(blob).toString('hex') : null;

/** A group of levels, fetched in waves until nothing new is named; then their manifests. */
export async function fetchLevels(store: Store, rows: readonly SlotRow[], levelsDir: string): Promise<number> {
  const known: Known = new Map();
  let frontier = new Set<string>();
  for (const r of rows) for (const s of [refSha(r.rootLevel), refSha(r.icon)]) if (s) frontier.add(s);
  let waves = 0;
  while (frontier.size) {
    waves++;
    for (const [s, deps] of await store.resolve(frontier)) known.set(s, deps);
    const next = new Set<string>();
    for (const deps of known.values()) for (const d of deps ?? []) if (!known.has(d)) next.add(d);
    frontier = next;
  }
  for (const r of rows) {
    const root = refSha(r.rootLevel);
    const icon = refSha(r.icon);
    const resources: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    const stack = [root, icon].filter((s): s is string => s !== null);
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      const deps = known.get(s);
      if (deps === null || deps === undefined) {
        missing.push(s);
        continue;
      }
      resources.push(s);
      stack.push(...deps);
    }
    const manifest: Manifest = {
      id: r.id, name: r.name, author: r.npHandle, playCount: r.playCount, game: r.game,
      rootLevel: root, icon, resources, missing,
    };
    await writeFile(path.join(levelsDir, `${r.id}.json`), JSON.stringify(manifest, null, 1));
  }
  return waves;
}

/** Free gigabytes on the disk that holds `dir`. */
export const freeGb = (dir: string): number => {
  const s = statfsSync(dir);
  return (s.bavail * s.bsize) / 1e9;
};
