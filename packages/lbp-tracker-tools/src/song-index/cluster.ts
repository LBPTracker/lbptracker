/**
 * Copies into songs, and what is known about each song.
 *
 * Rebuilt whole every run (seconds), so a rule changed here applies to
 * everything; the reading (`scan.ts`) is what is incremental. Each rule below
 * carries the case that made it.
 */

import type { DatabaseSync } from 'node:sqlite';
import { row } from './db.ts';
import { bandKey, isPart, LSH_BANDS, MINHASH_SIZE, similarity } from './signature.ts';

/** A copy joins a song when it is at least this similar to the song's centre. */
export const THRESHOLD = 0.5;

/**
 * When a level proves it holds its sequencers, in SQL.
 *
 * ⚠️ `last_updated`, not `first_published`: what the archive holds is the
 * level as last saved, so the song was there at that date. `first_published`
 * is when the slot was made, and a slot made on LBP1, or published empty and
 * filled later, gave a copier a date before the author's.
 */
const SEEN_AT = 'coalesce(l.last_updated, l.first_published)';
/**
 * How close to the oldest proof a name stays a candidate for maker. The dates
 * are proofs, not births: names first seen the same month cannot be told apart
 * by date, and there the number of copies decides.
 */
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 3600 * 1000;
/** The maker of a song out of the game: the creator the game writes into its own groups. */
export const GAME_AUTHOR = 'MM_Studio';
/**
 * From how many songs up a game item is a tool, not a song. Measured on
 * 2026-10-31: the popit's empty music sequencer, 120863, is under 32,381 songs;
 * the seventeen other game items with a sequencer are under 26 at most.
 */
const GAME_TOOL_SONGS = 100;
/** A game item seen fewer times than this is noise, not a song the game handed out. */
const GAME_SONG_MIN_COPIES = 5;

export function cluster(db: DatabaseSync, threshold = THRESHOLD): void {
  const started = Date.now();
  const rows = db.prepare('SELECT id, music_hash, minhash, n_notes FROM content').all()
    .map((r) => row<{ id: number; music_hash: string; minhash: Uint8Array | null; n_notes: number }>(r));
  console.error(`Clustering ${rows.length} distinct copies`);

  // How widespread each copy is: the most widespread becomes a song's centre.
  db.exec(`DROP TABLE IF EXISTS content_stats; CREATE TABLE content_stats AS
    SELECT o.content_id, count(DISTINCT lr.slot_id) AS n_levels, sum(l.plays) AS plays, min(${SEEN_AT}) AS first_seen
    FROM (SELECT DISTINCT content_id, sha FROM occurrence) o
    JOIN level_resource lr ON lr.sha = o.sha JOIN level l ON l.slot_id = lr.slot_id
    GROUP BY o.content_id;
    CREATE INDEX content_stats_id ON content_stats(content_id);`);
  const stats = new Map<number, { n_levels: number; plays: number }>();
  for (const r of db.prepare('SELECT content_id, n_levels, plays FROM content_stats').all()) {
    const s = row<{ content_id: number; n_levels: number; plays: number }>(r);
    stats.set(s.content_id, s);
  }

  const sigs = rows.map((r) => (r.minhash ? new Uint32Array(new Uint8Array(r.minhash).buffer.slice(0), 0, MINHASH_SIZE) : null));
  const byMusic = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byMusic.get(r.music_hash);
    if (list) list.push(i);
    else byMusic.set(r.music_hash, [i]);
  });
  const buckets = Array.from({ length: LSH_BANDS }, (_, band) => {
    const map = new Map<string, number[]>();
    sigs.forEach((sig, i) => {
      if (!sig) return;
      const key = bandKey(sig, band);
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    });
    return map;
  });

  // ❗ Around a centre, not in a chain. Single-link union-find joined A to C
  // through B with A and C almost unrelated: every "music maker" kit sharing
  // its chips became one song. Here a copy joins only if it is close to the
  // CENTRE, the most widespread copy not yet taken.
  const order = rows.map((_, i) => i).filter((i) => rows[i].n_notes > 0).sort((a, b) => {
    const sa = stats.get(rows[a].id);
    const sb = stats.get(rows[b].id);
    return (sb?.n_levels ?? 0) - (sa?.n_levels ?? 0) || (sb?.plays ?? 0) - (sa?.plays ?? 0) || rows[a].id - rows[b].id;
  });
  const songOf = new Int32Array(rows.length).fill(-1);
  const simOf = new Float64Array(rows.length);
  const relOf: string[] = new Array(rows.length);
  const centres: number[] = [];
  const count = { sameMusic: 0, similar: 0, parts: 0, compared: 0 };
  for (const centre of order) {
    if (songOf[centre] >= 0) continue;
    const song = centres.length;
    centres.push(centre);
    songOf[centre] = song;
    simOf[centre] = 1;
    relOf[centre] = 'center';
    for (const j of byMusic.get(rows[centre].music_hash)!) {
      if (songOf[j] >= 0) continue;
      [songOf[j], simOf[j], relOf[j]] = [song, 1, 'same_music'];
      count.sameMusic++;
    }
    const sig = sigs[centre];
    if (!sig) continue;
    const seen = new Set<number>();
    for (let band = 0; band < LSH_BANDS; band++) {
      for (const j of buckets[band].get(bandKey(sig, band))!) {
        if (songOf[j] >= 0 || seen.has(j)) continue;
        seen.add(j);
        count.compared++;
        const sim = similarity(sig, sigs[j]!);
        if (sim >= threshold) {
          [songOf[j], simOf[j], relOf[j]] = [song, sim, 'similar'];
          count.similar++;
        } else if (isPart(sim, rows[centre].n_notes, rows[j].n_notes)) {
          // The real Jaccard is kept: it says how different the lengths are.
          [songOf[j], simOf[j], relOf[j]] = [song, sim, rows[j].n_notes > rows[centre].n_notes ? 'extended' : 'shortened'];
          count.parts++;
        }
      }
    }
  }
  console.error(`  ${centres.length} songs: ${count.sameMusic} same notes, ${count.similar} similar, ` +
    `${count.parts} longer or shorter (${count.compared} comparisons)`);

  const setSong = db.prepare('UPDATE content SET song_id = ?, similarity = ?, relation = ? WHERE id = ?');
  db.exec('BEGIN');
  db.exec('UPDATE content SET song_id = NULL, similarity = NULL, relation = NULL');
  db.exec('DROP TABLE IF EXISTS song_rep; CREATE TABLE song_rep (song_id INTEGER PRIMARY KEY, content_id INTEGER)');
  const setRep = db.prepare('INSERT INTO song_rep VALUES (?, ?)');
  centres.forEach((centre, song) => setRep.run(song + 1, rows[centre].id));
  rows.forEach((r, i) => {
    if (songOf[i] >= 0) setSong.run(songOf[i] + 1, simOf[i], relOf[i], r.id);
  });
  db.exec('COMMIT');

  describe(db);
  const songs = row<{ n: number; multi: number; game: number }>(
    db.prepare('SELECT count(*) AS n, sum(n_variants > 1) AS multi, sum(from_game) AS game FROM song').get(),
  );
  console.error(`  ${songs.n} songs, ${songs.multi} with variants, ${songs.game} from the game ` +
    `(${Math.round((Date.now() - started) / 1000)}s)`);
}

/** Makers, aliases, the game's songs and the `song` table, out of the clustered copies. */
function describe(db: DatabaseSync): void {
  // Makers. ❗ Not the name on the most copies: whoever saves a copy into a
  // plan of their own becomes the creator its group names, and a copy that
  // spreads further outnumbers the original ("Inner Space": Festerd_Jester from
  // April 2011 in 32 levels, SonicBoomXD from October 2011 in 60). Nor the
  // oldest alone: a date is a proof, and one level updated early was enough to
  // win. So: candidates are the names first seen within the window of the
  // oldest; among them, most copies, then whoever put it in a level of theirs.
  db.exec(`DROP TABLE IF EXISTS song_author; CREATE TABLE song_author AS
    WITH a AS (
      SELECT c.song_id, o.author, count(*) AS n_instances, count(DISTINCT lr.slot_id) AS n_levels,
             min(${SEEN_AT}) AS first_seen, coalesce(max(l.author = o.author), 0) AS self_published
      FROM content c JOIN occurrence o ON o.content_id = c.id
      LEFT JOIN level_resource lr ON lr.sha = o.sha LEFT JOIN level l ON l.slot_id = lr.slot_id
      WHERE c.song_id IS NOT NULL AND o.author <> ''
      GROUP BY c.song_id, o.author),
    w AS (
      SELECT *, first_seen IS NOT NULL
             AND first_seen <= min(first_seen) OVER (PARTITION BY song_id) + ${ATTRIBUTION_WINDOW_MS} AS candidate
      FROM a)
    SELECT *, row_number() OVER (PARTITION BY song_id
             ORDER BY candidate DESC, n_instances DESC, self_published DESC, first_seen, author) AS rank
    FROM w;
    CREATE INDEX song_author_song ON song_author(song_id, rank);`);

  // Linked accounts: whoever publishes levels made almost only of one other
  // maker's songs is nearly always that maker's second account (FJMusic for
  // Festerd_Jester). It finds the origin level; collections of everyone's songs
  // ("ALL MUSIC BOXS!") do not pass, since nobody is a majority in them.
  db.exec(`DROP TABLE IF EXISTS author_alias; CREATE TABLE author_alias AS
    WITH pairs AS (
      SELECT DISTINCT l.author AS level_author, o.author AS seq_author, c.song_id
      FROM content c JOIN occurrence o ON o.content_id = c.id
      JOIN level_resource lr ON lr.sha = o.sha JOIN level l ON l.slot_id = lr.slot_id
      WHERE c.song_id IS NOT NULL AND o.author <> '' AND l.author IS NOT NULL),
    totals AS (SELECT level_author, count(DISTINCT song_id) AS total FROM pairs GROUP BY level_author)
    SELECT p.level_author, p.seq_author, count(*) AS songs, t.total
    FROM pairs p JOIN totals t USING (level_author)
    WHERE p.level_author <> p.seq_author
    GROUP BY p.level_author, p.seq_author HAVING count(*) >= 5 AND count(*) * 2 > t.total;
    CREATE UNIQUE INDEX author_alias_pair ON author_alias(level_author, seq_author);`);

  // The game's songs. A sequencer placed from a game item keeps the item's
  // `planGuid` and a group of MM_Studio's; cwlib's `sequencerAuthor` skips
  // MM_Studio and climbs to whoever put it in a level, who did not write it
  // ("Dew Shimmers", out of LBP2's story: item 197129 in every copy, signed by
  // whoever used it). ⚠️ The popit's EMPTY music sequencer is a game item too
  // (120863, under "Inner Space" as under everything): it is told apart by the
  // number of songs under it. ⚠️ Of an item's songs only the one with most
  // copies is the game's: the others (up to 25 for one item) are the item
  // edited by players into something else, which is theirs. ⚠️ And that song
  // is the game's only when most of its copies came from the item: one copy
  // in an LBP3 chunk carrying a game item's GUID made "FORGOT, LOL." (49
  // levels, every other copy a player's) the game's, as it did two more.
  db.exec(`DROP TABLE IF EXISTS game_plan; CREATE TABLE game_plan AS
    WITH per AS (
      SELECT o.plan_guid, c.song_id, count(*) AS copies
      FROM occurrence o JOIN content c ON c.id = o.content_id
      WHERE o.plan_guid > 0 AND o.mm_group = 1 AND c.song_id IS NOT NULL GROUP BY o.plan_guid, c.song_id)
    SELECT plan_guid, count(*) AS songs, sum(copies) AS copies,
           (SELECT p2.song_id FROM per p2 WHERE p2.plan_guid = per.plan_guid ORDER BY p2.copies DESC LIMIT 1) AS song_id,
           count(*) < ${GAME_TOOL_SONGS} AND sum(copies) >= ${GAME_SONG_MIN_COPIES} AS is_song
    FROM per GROUP BY plan_guid;
    DROP TABLE IF EXISTS game_song; CREATE TABLE game_song AS
    WITH game_copy AS (
      SELECT c.song_id, o.plan_guid, o.name GLOB '*_MUSIC_NAME' AND upper(o.name) = o.name AS keyed
      FROM content c JOIN occurrence o ON o.content_id = c.id
      WHERE o.mm_group = 1 AND o.plan_guid IN (SELECT plan_guid FROM game_plan WHERE is_song)),
    copies AS (
      SELECT c.song_id, count(*) AS total FROM content c JOIN occurrence o ON o.content_id = c.id
      WHERE c.song_id IS NOT NULL GROUP BY c.song_id),
    per AS (
      SELECT song_id, count(*) AS from_game, sum(keyed) AS keyed,
             (SELECT g2.plan_guid FROM game_copy g2 WHERE g2.song_id = g.song_id
              GROUP BY g2.plan_guid ORDER BY count(*) DESC LIMIT 1) AS plan_guid
      FROM game_copy g GROUP BY song_id)
    -- An item's main song, or a song whose copies still carry the game's own
    -- text key for a name: "MOVE_DEW_SHIMMERS_MUSIC_NAME" is in 388 copies of
    -- item 197129 spread over 20 songs, the parts and versions the item holds.
    SELECT per.song_id, per.plan_guid
    FROM per JOIN copies USING (song_id)
    WHERE per.from_game * 2 > copies.total
      AND (per.song_id IN (SELECT song_id FROM game_plan WHERE is_song) OR per.keyed * 2 > copies.total);
    CREATE UNIQUE INDEX game_song_id ON game_song(song_id);`);

  db.exec(`DROP TABLE IF EXISTS song; CREATE TABLE song AS
    WITH sl AS (
      SELECT DISTINCT c.song_id, lr.slot_id
      FROM content c JOIN occurrence o ON o.content_id = c.id JOIN level_resource lr ON lr.sha = o.sha
      WHERE c.song_id IS NOT NULL),
    agg AS (
      SELECT sl.song_id, count(*) AS n_levels, sum(l.plays) AS plays, sum(l.unique_plays) AS unique_plays,
             sum(l.hearts) AS hearts, min(${SEEN_AT}) AS first_seen, max(${SEEN_AT}) AS last_seen
      FROM sl JOIN level l ON l.slot_id = sl.slot_id GROUP BY sl.song_id),
    -- MUSIC_SEQUENCER_NAME is the default name; other upper-case LAMS keys
    -- (MOVE_..._MUSIC_NAME) come out of the game: they count only when nothing else does.
    names AS (
      SELECT c.song_id, o.name, row_number() OVER (PARTITION BY c.song_id
             ORDER BY (o.name GLOB '*_NAME' AND upper(o.name) = o.name), count(*) DESC) AS rn
      FROM content c JOIN occurrence o ON o.content_id = c.id
      WHERE o.name <> '' AND o.name <> 'MUSIC_SEQUENCER_NAME' GROUP BY c.song_id, o.name),
    authors AS (
      SELECT song_id, author, row_number() OVER (PARTITION BY song_id ORDER BY rank) AS rn,
             row_number() OVER (PARTITION BY song_id ORDER BY n_instances DESC, rank) AS rn_common
      FROM song_author),
    variants AS (
      SELECT song_id, count(*) AS n_variants FROM content WHERE song_id IS NOT NULL GROUP BY song_id),
    instances AS (
      SELECT c.song_id, count(*) AS n_instances FROM content c JOIN occurrence o ON o.content_id = c.id
      WHERE c.song_id IS NOT NULL GROUP BY c.song_id),
    rep AS (
      SELECT sr.song_id, c.id AS rep_content_id, c.tempo, c.n_tracks, c.n_notes, c.length_steps, c.instruments
      FROM song_rep sr JOIN content c ON c.id = sr.content_id),
    overrides AS (
      SELECT c.song_id, max(ao.author) AS author
      FROM author_override ao JOIN content c ON c.content_hash = ao.content_hash GROUP BY c.song_id),
    -- by hand first, then the game, then the rule over the signatures
    owner AS (
      SELECT v.song_id, coalesce(ov.author, CASE WHEN gs.song_id IS NOT NULL THEN '${GAME_AUTHOR}' END, a.author) AS author
      FROM variants v LEFT JOIN overrides ov ON ov.song_id = v.song_id
      LEFT JOIN game_song gs ON gs.song_id = v.song_id LEFT JOIN authors a ON a.song_id = v.song_id AND a.rn = 1),
    -- ❗ The origin is a level where the song carries its maker's name, not the
    -- oldest level of all, which is often a copier's ("Inner Space" landed in
    -- roxurface's). The maker's own level first, then their most linked
    -- account's (FJMusic, 122 of Festerd_Jester's songs), then the oldest proof.
    origin AS (
      SELECT c.song_id, lr.slot_id, row_number() OVER (PARTITION BY c.song_id
             ORDER BY coalesce(o.author = ow.author, 0) DESC, coalesce(l.author = ow.author, 0) DESC,
                      coalesce(al.songs, 0) DESC, ${SEEN_AT} IS NULL, ${SEEN_AT}, l.slot_id) AS rn
      FROM content c JOIN occurrence o ON o.content_id = c.id
      JOIN level_resource lr ON lr.sha = o.sha JOIN level l ON l.slot_id = lr.slot_id
      LEFT JOIN owner ow ON ow.song_id = c.song_id
      LEFT JOIN author_alias al ON al.level_author = l.author AND al.seq_author = ow.author
      WHERE c.song_id IS NOT NULL)
    -- ⚠️ A game song was born in a story level, which is on the disc and not in
    -- the archive: no published level is its origin.
    SELECT v.song_id AS id, n.name, ow.author AS sequencer_author,
           ov.author IS NOT NULL AS author_overridden, gs.song_id IS NOT NULL AS from_game, gs.plan_guid AS game_plan,
           ac.author AS most_common_author,
           v.n_variants, i.n_instances, coalesce(g.n_levels, 0) AS n_levels,
           g.plays, g.unique_plays, g.hearts, g.first_seen, g.last_seen,
           CASE WHEN gs.song_id IS NULL THEN o.slot_id END AS origin_slot_id,
           CASE WHEN gs.song_id IS NULL THEN ol.name END AS origin_level,
           CASE WHEN gs.song_id IS NULL THEN ol.author END AS origin_level_author,
           r.rep_content_id, r.tempo, r.n_tracks, r.n_notes, r.length_steps, r.instruments
    FROM variants v
    JOIN instances i ON i.song_id = v.song_id
    LEFT JOIN agg g ON g.song_id = v.song_id
    LEFT JOIN origin o ON o.song_id = v.song_id AND o.rn = 1
    LEFT JOIN level ol ON ol.slot_id = o.slot_id
    LEFT JOIN names n ON n.song_id = v.song_id AND n.rn = 1
    LEFT JOIN authors a ON a.song_id = v.song_id AND a.rn = 1
    LEFT JOIN overrides ov ON ov.song_id = v.song_id
    LEFT JOIN game_song gs ON gs.song_id = v.song_id
    LEFT JOIN owner ow ON ow.song_id = v.song_id
    LEFT JOIN authors ac ON ac.song_id = v.song_id AND ac.rn_common = 1
    LEFT JOIN rep r ON r.song_id = v.song_id;
    CREATE INDEX song_plays ON song(plays);`);
}

/** Set a song's maker by hand (or clear it with ''); held on its main variant, so it survives re-clustering. */
export function setAuthor(db: DatabaseSync, songId: number, author: string, note?: string): string {
  const rep = db.prepare(
    'SELECT c.content_hash, s.name FROM song s JOIN content c ON c.id = s.rep_content_id WHERE s.id = ?',
  ).get(songId) as { content_hash: string; name: string | null } | undefined;
  if (!rep) throw new Error(`no song ${songId}`);
  db.prepare('DELETE FROM author_override WHERE content_hash IN (SELECT content_hash FROM content WHERE song_id = ?)')
    .run(songId);
  if (author) db.prepare('INSERT INTO author_override VALUES (?, ?, ?)').run(rep.content_hash, author, note ?? null);
  return rep.name ?? `song ${songId}`;
}
