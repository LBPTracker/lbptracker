/**
 * Where the song index's data lives, and the database it is built in.
 *
 * ⚠️ **No defaults for the big folders, on purpose**: the archive's copy is
 * about 30 GB and the database 250 MB, on whichever disk had room; a default
 * would be a path that exists on nobody else's machine. steering/tools.md,
 * *Environment variables*, says what each one is.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
export const REPO = path.resolve(HERE, '..', '..', '..', '..');
/** Where `export` writes and the page reads: `fixtures/songindex`, served in dev and staged on deploy. */
export const DEFAULT_OUT = path.join(REPO, 'fixtures', 'songindex');

export function required(name: string, what: string): string {
  const value = process.env[name];
  if (value) return value;
  console.error(`${name} is not set: it is ${what} (steering/tools.md, *Environment variables*).`);
  process.exit(2);
}

/** `dry.db`, the archive's own index of every slot (archive.org/details/dry23db). */
export const dryDb = () => required('LBP_DRY_DB', "the archive's index, dry.db");
/** The local copy of the archive: `res/aa/bb/<sha1>`, `levels/<id>.json`, `zipindex.db`. */
export const archiveDir = () => required('LBP_ARCHIVE', 'the folder the archive is downloaded into');
/** The song index's own database; by default beside the archive. */
export const songDb = () => process.env.LBP_SONG_DB ?? path.join(archiveDir(), 'songindex.db');
/** Where every resource is in the zips (2.4 GB); by default beside the archive, and shareable between copies of it. */
export const zipIndexFile = () => process.env.LBP_ZIP_INDEX ?? path.join(archiveDir(), 'zipindex.db');

export const resourcePath = (archive: string, sha1: string): string =>
  path.join(archive, 'res', sha1.slice(0, 2), sha1.slice(2, 4), sha1);

/**
 * The tables, created if missing. Columns added after the first index are
 * added here too, so an older database keeps working; they stay NULL until
 * the resources are read again.
 */
const SCHEMA = `
-- a slot of the archive whose resources were read, with what dry.db says of it
CREATE TABLE IF NOT EXISTS level (
  slot_id INTEGER PRIMARY KEY, name TEXT, author TEXT, game INTEGER,
  plays INTEGER, unique_plays INTEGER, hearts INTEGER, thumbsup INTEGER,
  first_published INTEGER, last_updated INTEGER, n_sequencers INTEGER);
-- every resource read once, whatever it was, so a re-run skips it
CREATE TABLE IF NOT EXISTS resource (
  sha TEXT PRIMARY KEY, magic TEXT, n_sequencers INTEGER, problems INTEGER, error TEXT) WITHOUT ROWID;
-- a level's resources that hold at least one sequencer
CREATE TABLE IF NOT EXISTS level_resource (
  slot_id INTEGER, sha TEXT, PRIMARY KEY (slot_id, sha)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS level_resource_sha ON level_resource(sha);
-- one distinct copy (a variant): equal content_hash, identical copies
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY, content_hash TEXT UNIQUE, music_hash TEXT,
  tempo REAL, swing REAL, n_tracks INTEGER, n_notes INTEGER, length_steps INTEGER,
  instruments TEXT, minhash BLOB, song_id INTEGER, similarity REAL, relation TEXT);
CREATE INDEX IF NOT EXISTS content_music ON content(music_hash);
CREATE INDEX IF NOT EXISTS content_song ON content(song_id);
-- every sequencer found in a resource
CREATE TABLE IF NOT EXISTS occurrence (
  sha TEXT, uid INTEGER, content_id INTEGER, name TEXT, author TEXT, plan_guid INTEGER, mm_group INTEGER);
CREATE INDEX IF NOT EXISTS occurrence_sha ON occurrence(sha);
CREATE INDEX IF NOT EXISTS occurrence_content ON occurrence(content_id);
-- a song's maker set by hand, where the rule is wrong. On a variant's
-- content_hash, because song ids change at every cluster.
CREATE TABLE IF NOT EXISTS author_override (content_hash TEXT PRIMARY KEY, author TEXT NOT NULL, note TEXT);
`;

const ADDED: readonly [table: string, column: string][] = [
  ['content', 'relation TEXT'],
  ['occurrence', 'plan_guid INTEGER'],
  ['occurrence', 'mm_group INTEGER'],
];

export function openSongDb(file = songDb()): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  for (const [table, column] of ADDED) {
    const name = column.split(' ')[0];
    const has = (db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(name)) !== undefined;
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
  return db;
}

/** A row out of `node:sqlite`, typed by the caller: the driver gives `Record<string, SQLOutputValue>`. */
export const row = <T>(value: unknown): T => value as T;
