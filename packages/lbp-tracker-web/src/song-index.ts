/**
 * The song index: every music sequencer published to the official servers, as
 * songs with their variants, read from static files the site serves.
 *
 * ❗ **No server, and no copy of the music.** The index says *where* a song is
 * — for every variant and every level, a resource SHA-1 and the sequencer's
 * uid — and the tracker opens it the way a `?level=<sha1>&seq=<uid>` link
 * does, out of the Internet Archive. So the files stay small (one list of every
 * song, then one detail file per song opened: steering/level-sources.md has the sizes)
 * and what plays is the song itself, with the game's samples.
 *
 * The files are built from the archive's whole download by
 * `@lbptracker/tools` (`npm run song-index`; steering/tools.md has how,
 * steering/level-sources.md what it found); this module only reads their
 * format, and holds the search, so `node --test` can check it with no browser
 * and no fetch.
 *
 * ⚠️ **Every name in here was typed by a player and arrives over the network.**
 * The panel interpolates them as text and never as markup.
 */

import { authorHandle } from '@lbptracker/cwlib/sequencer/project.ts';

/** What `index.json` says: the only file read fresh every time. */
export interface IndexHead {
  readonly format: number;
  /** The directory the rest lives in. A new export writes a new one. */
  readonly version: string;
  readonly generated: string;
  readonly songs: number;
  readonly shards: number;
}

/**
 * The formats this reader understands; an export in another one is refused.
 * 2: a variant row has fixed positions (no copy to open is `null, null`) and
 * ends with how the variant joined its song.
 * 3: `songs.json` has a `game` column (2 is read as having none).
 */
export const INDEX_FORMATS: readonly number[] = [2, 3];

/** One song in the list: what the search and the sort look at. */
export interface SongRow {
  readonly id: number;
  /** The name most copies carry, or '' when nobody named it. */
  readonly name: string;
  /** Who made it, as the index decided (steering/level-sources.md, *Song index*). */
  readonly author: string;
  readonly variants: number;
  readonly levels: number;
  readonly plays: number;
  /** The year of the oldest level version that holds it; 0 when unknown. */
  readonly year: number;
  readonly tempo: number;
  readonly notes: number;
  /** The level it was published in first by its author, and that level's creator. */
  readonly origin: string;
  readonly originAuthor: string;
  /** Up to three other names its copies carry, joined by " / ". */
  readonly alt: string;
  /**
   * A song out of the game itself ("Dew Shimmers", from LBP2's story): every
   * copy was placed from the game's own item, whoever's level it is in. Its
   * `author` is the game's `MM_Studio` and it has no origin level, the story
   * being on the disc and not in the archive.
   */
  readonly game: boolean;
}

/** `songs.json` is column-major: one array per field, all the same length; `game` is 0 or 1. */
export type SongColumns = { readonly [K in Exclude<keyof SongRow, 'game'>]: readonly SongRow[K][] } & {
  readonly game?: readonly number[];
};

/** Who to show as a song's maker: a PSN name, or the game for a song out of it. */
export const makerOf = (row: SongRow): string => (row.game ? 'LittleBigPlanet (the game)' : row.author || 'unknown');

export function rowsFrom(cols: SongColumns): SongRow[] {
  return cols.id.map((id, i) => ({
    id,
    name: cols.name[i],
    author: cols.author[i],
    variants: cols.variants[i],
    levels: cols.levels[i],
    plays: cols.plays[i],
    year: cols.year[i],
    tempo: cols.tempo[i],
    notes: cols.notes[i],
    origin: cols.origin[i],
    originAuthor: cols.originAuthor[i],
    alt: cols.alt[i],
    game: cols.game?.[i] === 1,
  }));
}

/** Where a copy of a song is: open `sha1` from the archive and pick `uid`. */
export interface Target {
  readonly sha1: string;
  readonly uid: number;
}

/**
 * How a variant joined its song: it is the song's most widespread copy; it
 * plays the same notes with other instruments, tempo or placement; it plays
 * nearly the same notes; or it is the same music made longer or shorter, which
 * is why its similarity can be low (a version three times as long shares only
 * a third of its notes).
 */
export type Relation = 'center' | 'same_music' | 'similar' | 'extended' | 'shortened' | '';

export interface Variant {
  /** How close it is to the song's main variant, 0..1; null when too short to compare. */
  readonly similarity: number | null;
  readonly relation: Relation;
  readonly tempo: number;
  readonly notes: number;
  readonly levels: number;
  readonly year: number;
  readonly target?: Target;
  readonly name: string;
  readonly author: string;
}

export interface SongAuthor {
  readonly author: string;
  readonly copies: number;
  readonly levels: number;
  /** Milliseconds; the oldest level version where a copy carries this name. */
  readonly firstSeen: number;
  /** Close enough to the oldest to have been the original (within 30 days). */
  readonly candidate: boolean;
}

export interface SongLevel {
  readonly slot: number;
  readonly name: string;
  readonly author: string;
  readonly plays: number;
  /** 0 LBP1, 1 LBP2, 2 LBP3, as the archive's `slot.game`. */
  readonly game: number;
  readonly seen: number;
  readonly target?: Target;
  /** This is the level the song was first published in by its author. */
  readonly origin: boolean;
}

export interface SongDetail {
  readonly variants: readonly Variant[];
  readonly authors: readonly SongAuthor[];
  /** Every one, the origin first and then by plays (the export kept fifty until 2026-10-31). */
  readonly levels: readonly SongLevel[];
}

const SHA1 = /^[0-9a-f]{40}$/;

/**
 * A target out of the file, checked: the hash goes into a fetch URL and the
 * uid into a link, so neither is trusted just because the file is ours.
 */
function targetFrom(sha1: unknown, uid: unknown): Target | undefined {
  if (typeof sha1 !== 'string' || !SHA1.test(sha1)) return undefined;
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return undefined;
  return { sha1, uid };
}

/** One song's entry in a detail file (`{ o, v, a, l }`, arrays of positional rows). */
export function detailFrom(raw: { o: number; v: unknown[][]; a: unknown[][]; l: unknown[][] }): SongDetail {
  return {
    variants: raw.v.map((r) => ({
      similarity: r[0] as number | null,
      tempo: r[1] as number,
      notes: r[2] as number,
      levels: r[3] as number,
      year: r[4] as number,
      target: targetFrom(r[5], r[6]),
      name: r[7] as string,
      author: r[8] as string,
      relation: (r[9] ?? '') as Relation,
    })),
    authors: raw.a.map((r) => ({
      author: r[0] as string,
      copies: r[1] as number,
      levels: r[2] as number,
      firstSeen: r[3] as number,
      candidate: r[4] === 1,
    })),
    levels: raw.l.map((r) => ({
      slot: r[0] as number,
      name: r[1] as string,
      author: r[2] as string,
      plays: r[3] as number,
      game: r[4] as number,
      seen: r[5] as number,
      target: targetFrom(r[6], r[7]),
      origin: r[0] === raw.o,
    })),
  };
}

/**
 * The copy "open" means with no more said: the one in the level the song was
 * first published in by its maker, else the main variant's, else the first
 * that can be fetched. `original` says which, for the button.
 *
 * ❗ **The origin level before the main variant's copy**, because the export
 * puts a variant's copy in its most played level: "Haze - Velvet--Audio" opened
 * in kitanohydros' "LittleBigCity 2" rather than in Velvet--Audio's Music
 * Gallery (V.2), where it came from. The origin's copy may be another variant
 * than the main one; it is still the song as its maker placed it.
 */
export function openTarget(detail: SongDetail): { readonly target: Target; readonly original: boolean } | undefined {
  const origin = detail.levels.find((l) => l.origin && l.target)?.target;
  if (origin) return { target: origin, original: true };
  const target = detail.variants.find((v) => v.target)?.target;
  return target && { target, original: false };
}

/**
 * Who the index says made the song a copy plays, for that copy alone: the
 * sequencer `uid` in the resource `sha1`, which a walk names its file after.
 */
export interface Credit extends Target {
  readonly author: string;
}

/**
 * The credit a song opened from the index carries: its maker as a handle, or
 * nothing for a song out of the game (no person to name) or one with no maker.
 */
export function creditOf(row: SongRow, target: Target): Credit | undefined {
  const author = row.game ? '' : authorHandle(row.author);
  return author ? { ...target, author } : undefined;
}

/**
 * A sequencer with the index's maker where the level names nobody.
 *
 * ❗ **Only where the file is silent.** The author is read off the sequencer's
 * group chain (`sequencerAuthor` in cwlib), and a sequencer nobody ever
 * grouped has none: 7 of the 31 in Velvet--Audio's Music Gallery (V.2), Haze
 * among them, carry only the gadget's `MM_Studio`. The index decided the maker
 * over every copy of the song (steering/level-sources.md), so it can fill that
 * gap; it never overrides a name the file does carry.
 */
export function credited<S extends { readonly uid: number; readonly author: string }>(
  seq: S,
  file: string,
  credit: Credit | undefined,
): S {
  return credit && !seq.author && file === credit.sha1 && seq.uid === credit.uid ? { ...seq, author: credit.author } : seq;
}

/** The detail file a song is in, under the version's directory. */
export const shardFile = (id: number, shards: number): string =>
  `song/${String(id % shards).padStart(3, '0')}.json`;

export type SortKey = 'levels' | 'plays' | 'variants' | 'year' | 'notes' | 'tempo' | 'name';

export interface SongFilter {
  readonly query: string;
  readonly sort: SortKey;
  readonly descending: boolean;
  /** 0 or 1 means no limit. */
  readonly minVariants: number;
  readonly minLevels: number;
  /** 0 means any year. */
  readonly year: number;
}

/**
 * Lower case, accents off, anything else a space: "Pokémon" is found by
 * "pokemon", and "inner-space" is two words like "Inner Space".
 */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

/**
 * Everything a search word may be found in, folded once per row, with a space
 * in front so that `' ' + word` matches only where a word starts.
 */
const haystacks = new WeakMap<SongRow, string>();
const haystack = (row: SongRow): string => {
  let hay = haystacks.get(row);
  if (hay === undefined) {
    hay = ' ' + fold([row.name, row.alt, row.author, row.origin, row.originAuthor].join(' '));
    haystacks.set(row, hay);
  }
  return hay;
};

/**
 * The rows a filter keeps, in its order.
 *
 * ❗ **Every word has to start a word somewhere in the row** — the name, the
 * other names its copies carry, its author, its origin level or that level's
 * creator — so "inner space festerd" finds the song and "festerd" finds all of
 * his. ⚠️ The start, not anywhere: "inner" inside "Award Winner" found an
 * unrelated song. A song with no name sorts after the named ones by name.
 */
export function searchSongs(rows: readonly SongRow[], filter: SongFilter): SongRow[] {
  const words = fold(filter.query).split(' ').filter(Boolean).map((w) => ' ' + w);
  const kept = rows.filter((row) =>
    row.variants >= filter.minVariants
    && row.levels >= filter.minLevels
    && (filter.year === 0 || row.year === filter.year)
    && (words.length === 0 || words.every((w) => haystack(row).includes(w))));
  const sign = filter.descending ? -1 : 1;
  const key = filter.sort;
  kept.sort((a, b) => {
    if (key === 'name') {
      if (!a.name !== !b.name) return a.name ? -1 : 1;
      return sign * a.name.localeCompare(b.name) || a.id - b.id;
    }
    // A year of 0 is unknown, not ancient: it goes last either way.
    if (key === 'year' && !a.year !== !b.year) return a.year ? -1 : 1;
    return sign * (a[key] - b[key]) || b.levels - a.levels || a.id - b.id;
  });
  return kept;
}
