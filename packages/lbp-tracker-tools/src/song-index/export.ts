/**
 * The song database as the static files the page reads (`packages/lbp-tracker-web/src/song-index.ts`
 * has the format and steering/level-sources.md, *The song index*, the numbers).
 *
 * ❗ **A new export is a new directory, made whole before anything points at
 * it**: written under `<version>.part`, renamed, and only then named by
 * `index.json`. An export cut short leaves a `.part` and the page reading the
 * one before; an earlier version of this wrote in place and left a directory
 * holding one file of 257.
 */

import type { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { row } from './db.ts';

/**
 * 3: `songs.json` has a `game` column, 1 for a song out of the game's story.
 * 2: a variant row has fixed positions (`null, null` for no copy to open) and
 * ends with how the variant joined its song.
 */
export const FORMAT = 3;
const ALT_NAMES = 3;

const year = (ms: number | null) => (ms ? new Date(ms).getUTCFullYear() : 0);
const clean = (name: string | null) => (!name || name === 'MUSIC_SEQUENCER_NAME' ? '' : name);
const target = (t: string | null): [string, number] | [null, null] => {
  if (!t) return [null, null];
  const [sha, uid] = t.split(' ');
  return [sha, Number(uid)];
};

interface SongRecord {
  id: number; name: string | null; sequencer_author: string | null; n_variants: number; n_levels: number;
  plays: number | null; first_seen: number | null; tempo: number | null; n_notes: number | null;
  origin_level: string | null; origin_level_author: string | null; from_game: number;
  rep_content_id: number; origin_slot_id: number | null;
}

export async function exportIndex(db: DatabaseSync, out: string, shards = 256, keep = 1): Promise<string> {
  const now = new Date();
  const version = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const part = path.join(out, `${version}.part`);
  await rm(part, { recursive: true, force: true });
  await mkdir(path.join(part, 'song'), { recursive: true });

  const songs = db.prepare(
    `SELECT id, name, sequencer_author, n_variants, n_levels, plays, first_seen, tempo, n_notes,
            origin_level, origin_level_author, from_game, rep_content_id, origin_slot_id
     FROM song ORDER BY n_levels DESC, plays DESC, id`,
  ).all().map((r) => row<SongRecord>(r));

  // The other names a song goes by, for the search: "Clocks" also finds '"Clocks" by Coldplay'.
  const altNames = db.prepare(
    `SELECT o.name, count(*) AS n FROM content c JOIN occurrence o ON o.content_id = c.id
     WHERE c.song_id = ? AND o.name NOT IN ('', 'MUSIC_SEQUENCER_NAME') GROUP BY o.name ORDER BY n DESC LIMIT ?`,
  );
  const cols: Record<string, (string | number)[]> = {
    id: [], name: [], author: [], variants: [], levels: [], plays: [], year: [], tempo: [], notes: [],
    origin: [], originAuthor: [], alt: [], game: [],
  };
  for (const s of songs) {
    const name = clean(s.name);
    const alt = altNames.all(s.id, ALT_NAMES + 1).map((r) => row<{ name: string }>(r).name)
      .filter((n) => n !== name).slice(0, ALT_NAMES);
    cols.id.push(s.id);
    cols.name.push(name);
    cols.author.push(s.sequencer_author ?? '');
    cols.variants.push(s.n_variants);
    cols.levels.push(s.n_levels);
    cols.plays.push(s.plays ?? 0);
    cols.year.push(year(s.first_seen));
    cols.tempo.push(Math.round(s.tempo ?? 0));
    cols.notes.push(s.n_notes ?? 0);
    cols.origin.push(s.origin_level ?? '');
    cols.originAuthor.push(s.origin_level_author ?? '');
    cols.alt.push(alt.join(' / '));
    cols.game.push(s.from_game ? 1 : 0);
  }
  await writeFile(path.join(part, 'songs.json'), JSON.stringify(cols));

  // A copy to open: one inside a level root rather than a plan (one file, the
  // route most proven), and in the most played level.
  const variantStmt = db.prepare(
    `SELECT c.id, c.similarity, c.relation, c.tempo, c.n_notes, cs.n_levels, cs.first_seen,
            (SELECT o.sha || ' ' || o.uid FROM occurrence o JOIN resource r ON r.sha = o.sha
             LEFT JOIN level_resource lr ON lr.sha = o.sha LEFT JOIN level l ON l.slot_id = lr.slot_id
             WHERE o.content_id = c.id ORDER BY r.magic = 'LVLb' DESC, l.plays DESC LIMIT 1) AS target,
            (SELECT o.name FROM occurrence o WHERE o.content_id = c.id AND o.name NOT IN ('', 'MUSIC_SEQUENCER_NAME')
             GROUP BY o.name ORDER BY count(*) DESC LIMIT 1) AS name,
            (SELECT o.author FROM occurrence o WHERE o.content_id = c.id AND o.author <> ''
             GROUP BY o.author ORDER BY count(*) DESC LIMIT 1) AS author
     FROM content c LEFT JOIN content_stats cs ON cs.content_id = c.id
     WHERE c.song_id = ? ORDER BY c.id = ? DESC, cs.n_levels DESC, c.similarity DESC`,
  );
  const authorStmt = db.prepare(
    'SELECT author, n_instances, n_levels, first_seen, candidate FROM song_author WHERE song_id = ? ORDER BY rank',
  );
  // Every level, with no cap: fifty cut 21,849 levels off 205 songs for about
  // 2.8 MB, and those files are fetched only by opening one of those songs.
  const levelStmt = db.prepare(
    `SELECT l.slot_id, l.name, l.author, l.plays, l.game, coalesce(l.last_updated, l.first_published) AS seen,
            (SELECT o.sha || ' ' || o.uid FROM content c2 JOIN occurrence o ON o.content_id = c2.id
             JOIN level_resource lr2 ON lr2.sha = o.sha JOIN resource r ON r.sha = o.sha
             WHERE c2.song_id = ? AND lr2.slot_id = l.slot_id ORDER BY r.magic = 'LVLb' DESC LIMIT 1) AS target
     FROM level l WHERE l.slot_id IN (
       SELECT lr.slot_id FROM content c JOIN occurrence o ON o.content_id = c.id
       JOIN level_resource lr ON lr.sha = o.sha WHERE c.song_id = ?)
     ORDER BY l.slot_id = ? DESC, l.plays DESC`,
  );

  const buckets: Record<number, unknown>[] = Array.from({ length: shards }, () => ({}));
  let n = 0;
  for (const s of songs) {
    const v = variantStmt.all(s.id, s.rep_content_id).map((x) => {
      const r = row<{ similarity: number | null; relation: string | null; tempo: number; n_notes: number;
        n_levels: number | null; first_seen: number | null; target: string | null; name: string | null; author: string | null }>(x);
      return [r.similarity == null ? null : Math.round(r.similarity * 100) / 100, Math.round(r.tempo), r.n_notes,
        r.n_levels ?? 0, year(r.first_seen), ...target(r.target), r.name ?? '', r.author ?? '', r.relation ?? ''];
    });
    const a = authorStmt.all(s.id).map((x) => {
      const r = row<{ author: string; n_instances: number; n_levels: number; first_seen: number | null; candidate: number }>(x);
      return [r.author, r.n_instances, r.n_levels, r.first_seen ?? 0, r.candidate];
    });
    const l = levelStmt.all(s.id, s.id, s.origin_slot_id ?? -1).map((x) => {
      const r = row<{ slot_id: number; name: string | null; author: string | null; plays: number | null;
        game: number | null; seen: number | null; target: string | null }>(x);
      return [r.slot_id, r.name ?? '', r.author ?? '', r.plays ?? 0, r.game ?? -1, r.seen ?? 0, ...target(r.target)];
    });
    buckets[s.id % shards][s.id] = { o: s.origin_slot_id ?? 0, v, a, l };
    if (++n % 5000 === 0) console.error(`  ${n}/${songs.length} songs`);
  }
  await Promise.all(buckets.map((b, i) => writeFile(path.join(part, 'song', `${String(i).padStart(3, '0')}.json`), JSON.stringify(b))));

  await rename(part, path.join(out, version));
  await writeFile(path.join(out, 'index.json'), JSON.stringify({
    format: FORMAT, version, generated: now.toISOString(), songs: songs.length, shards,
  }));

  // Older exports go, but `keep` of them stay: a cached list may ask for them for a day.
  const dirs = (await readdir(out, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const old of dirs.filter((d) => d.endsWith('.part') && d !== `${version}.part`)) await rm(path.join(out, old), { recursive: true });
  const finished = dirs.filter((d) => !d.endsWith('.part'));
  for (const old of finished.slice(0, Math.max(0, finished.length - 1 - keep))) await rm(path.join(out, old), { recursive: true });
  return version;
}
