/**
 * The page's own query string: what a link to a song says, and how it is read.
 *
 * ❗ **A link names a level by the name its store gives it, and a song by its
 * uid**, because that is all either of them has for a name here:
 * `?level=<40 hex digits>` fetches a published level out of the Internet
 * Archive (`lbparchive.ts` has where from and why it needs no server),
 * `?bonsai=<number>` fetches one off Bonsai by the number in its page's address
 * (`bonsai.ts`), `&seq=<uid>` picks one of the sequencers inside it, and
 * `&deep=1` also fetches the resources the level depends on. Nothing else is
 * encoded, so a link costs this site nothing, survives a redeploy, and works
 * from any copy of the page including a dev server.
 *
 * ⚠️ **Everything read out of here is validated, not trusted.** The hash and
 * the number go into a fetch URL and the uid into a map key, and all three
 * arrive from whatever somebody pasted into the address bar.
 *
 * The address bar is written back to as the reader opens things
 * (`rememberLevel`, `rememberSequencer`), so the URL is always the link to what
 * is on screen. ⚠️ **`replaceState`, never `pushState`**: opening a level is
 * not a page the Back button should have to step through.
 */

import { isLevelId } from './bonsai.ts';

export const LEVEL_PARAM = 'level';
export const BONSAI_PARAM = 'bonsai';
export const DEEP_PARAM = 'deep';
export const SEQ_PARAM = 'seq';

/**
 * A level somebody else can fetch, named the way its store names it.
 *
 * ❗ **The only kind of level a link can carry.** A level off this machine has
 * no name anybody else could open, and says so by not being one of these.
 */
export type LinkedLevel =
  | { readonly from: 'archive'; readonly sha1: string; readonly deep: boolean }
  | { readonly from: 'bonsai'; readonly id: number; readonly deep: boolean };

/** Whether two links name the same level, whatever their walk says. */
export function sameLevel(a: LinkedLevel | undefined, b: LinkedLevel | undefined): boolean {
  if (!a || !b) return false;
  if (a.from === 'archive' && b.from === 'archive') return a.sha1 === b.sha1;
  if (a.from === 'bonsai' && b.from === 'bonsai') return a.id === b.id;
  return false;
}

/** A sequencer inside a backup: unique on `file#uid`, and often just the uid. */
export type WantedSong = { readonly key: string } | { readonly uid: number };

/**
 * The level a URL asks for, if it asks for one.
 *
 * ⚠️ **The walk is off unless the link says otherwise.** It costs seconds and
 * duplicate rows on most levels; only a link that asks for it pays that. See
 * `open_` in `archive-panel.ts` for the measurement.
 *
 * A link this page writes names one store (`levelParams` clears the other
 * parameter); one written by hand with both is read as the archive's, so the
 * answer does not depend on the order they were typed in.
 */
export function levelFromQuery(search: string): LinkedLevel | undefined {
  const params = new URLSearchParams(search);
  const flag = params.get(DEEP_PARAM);
  const deep = flag === '1' || flag === 'true';
  const sha1 = params.get(LEVEL_PARAM)?.trim() ?? '';
  if (/^[0-9a-f]{40}$/i.test(sha1)) return { from: 'archive', sha1: sha1.toLowerCase(), deep };
  const number = params.get(BONSAI_PARAM)?.trim() ?? '';
  const id = /^\d{1,10}$/.test(number) ? Number(number) : NaN;
  if (isLevelId(id)) return { from: 'bonsai', id, deep };
  return undefined;
}

/** The parameters that name a level: its store's set, the other store's cleared. */
function levelParams(level: LinkedLevel): Record<string, string | undefined> {
  return {
    [LEVEL_PARAM]: level.from === 'archive' ? level.sha1 : undefined,
    [BONSAI_PARAM]: level.from === 'bonsai' ? String(level.id) : undefined,
    [DEEP_PARAM]: level.deep ? '1' : undefined,
  };
}

/**
 * The song a URL asks for, if it asks for one.
 *
 * ❗ **Two spellings, because a uid is unique inside a level and not across a
 * backup** (`sequencersOf` in `../cwlib-ts/src/sequencer/backup.ts`): `seq=7` means
 * "the sequencer numbered 7", which is unambiguous for the one level a `?level=`
 * link opens, and `seq=<file>#7` names the file too, which is what a backup of
 * several levels needs. A link written by this page is the short form whenever
 * the short form can only mean one thing.
 */
export function songFromQuery(search: string): WantedSong | undefined {
  const raw = new URLSearchParams(search).get(SEQ_PARAM)?.trim();
  if (!raw) return undefined;
  const hash = raw.lastIndexOf('#');
  if (hash > 0) return { key: raw };
  // A uid is an unsigned 32-bit Thing number; anything else is not one.
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return undefined;
  return { uid };
}

/** The row a link asked for, out of the rows a backup actually gave. */
export function pickWanted<T extends { key: string; uid: number }>(
  rows: readonly T[],
  wanted: WantedSong | undefined,
): T | undefined {
  if (!wanted) return undefined;
  if ('key' in wanted) return rows.find((r) => r.key === wanted.key);
  // Rows come sorted biggest first, so the first match is the likeliest one
  // when two levels in a backup happen to share a uid.
  return rows.find((r) => r.uid === wanted.uid);
}

/**
 * Rewrite the address bar.
 *
 * A key given as `undefined` is removed; a key left out of `changes` is left
 * alone, which is the difference `rememberLevel` turns on.
 */
function rewrite(changes: Record<string, string | undefined>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, '', url);
}

/**
 * Put an opened level's name in the address bar, so the URL is the link.
 *
 * ⚠️ **`seq` survives only a re-open of the same level.** It named a
 * song inside the level that was there before, and dropping it on a *different*
 * level is not tidiness: this runs before the level is read, so a stale `seq`
 * left in the URL is one the reader never asked for and the open would then act
 * on. Re-opening the same level -- which is what a `?level=…&seq=…` link does --
 * has to keep it, or the link could never reach the song it names.
 */
export function rememberLevel(level: LinkedLevel): void {
  const changes = levelParams(level);
  if (!sameLevel(levelFromQuery(window.location.search), level)) changes[SEQ_PARAM] = undefined;
  rewrite(changes);
}

/**
 * Put the song being edited in the address bar, beside the level it came from.
 *
 * ⚠️ **Only when the level itself is in the link.** A level opened from a file
 * on this machine has no shareable name, and a bare `?seq=` would be a link
 * that says which song out of a backup nobody else can open.
 */
export function rememberSequencer(row: { key: string; uid: number } | undefined, unique: boolean): void {
  if (!levelFromQuery(window.location.search)) return;
  rewrite({ [SEQ_PARAM]: row ? (unique ? String(row.uid) : row.key) : undefined });
}

/**
 * Name a song in the address bar BEFORE its level is fetched.
 *
 * The demo button's route: `openLevel` reads `?seq=` to decide which of a
 * level's songs to show, and `rememberLevel` keeps a `seq` that came with the
 * same hash, so writing both first makes the button one more reader of the
 * link route rather than a second way in.
 */
export function rememberSong(sha1: string, uid: number): void {
  rewrite({ ...levelParams({ from: 'archive', sha1, deep: false }), [SEQ_PARAM]: String(uid) });
}

/** Is there a link to make? Only a level fetched from a store has one. */
export const linkable = (): boolean => levelFromQuery(window.location.search) !== undefined;

/**
 * The link to one song of the level that is open, ready to be handed to
 * somebody.
 *
 * ❗ **Built from the row, not from the address bar.** The reader may be
 * copying the link to a song they have not opened -- the picker copies whatever
 * row is chosen -- so only the level and the walk come out of the URL.
 */
export function songLink(row: { key: string; uid: number } | undefined, unique: boolean): string | undefined {
  const level = levelFromQuery(window.location.search);
  if (!level || !row) return undefined;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(levelParams(level))) {
    if (value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  url.searchParams.set(SEQ_PARAM, unique ? String(row.uid) : row.key);
  return url.toString();
}

/**
 * Stop the URL claiming a level.
 *
 * ❗ **What is open now did not come from a store**, so the link that is in
 * the address bar is to something else entirely -- a level from this machine or
 * a new song. Left there, the picker would offer to copy a link to a song
 * nobody is looking at.
 */
export function forgetLevel(): void {
  rewrite({
    [LEVEL_PARAM]: undefined,
    [BONSAI_PARAM]: undefined,
    [DEEP_PARAM]: undefined,
    [SEQ_PARAM]: undefined,
  });
}
