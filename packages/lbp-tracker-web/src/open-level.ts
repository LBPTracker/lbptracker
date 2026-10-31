/**
 * One drop zone that takes a level, a backup folder, or a zip of one.
 *
 * A creator's backup is a directory of resources named after their SHA-1, so
 * "open your level" means "find the right extensionless file among forty and
 * guess". This takes the whole thing instead: drop the folder, drop a zip of
 * it, or drop one file if that is what you have.
 *
 * ⚠️ **Shared on purpose.** Three pages open levels and the last time two of
 * them grew their own copy of something this small it cost a day -- the same
 * reason `packages/lbp-tracker-web/src/assets.ts` and `packages/lbp-tracker-web/src/seq-picker.ts` exist.
 *
 * ⚠️ **Nothing here may import Vue, or anything that touches `document`.**
 * `render-worker.ts` imports `openedTitle` from this file, and a worker has no
 * document: pulling the drop zone's component in here crashed the renderer
 * with `ReferenceError: document is not defined` from inside Vue's runtime,
 * and nothing in the build says so — the bundle is happy, the worker is not.
 * The mounting half lives in `widgets/open-panel.ts` for exactly that reason.
 *
 * ❗ **Nothing is uploaded.** Every byte is read from the `File` the browser
 * hands over, in the page, and the reading is `../cwlib-ts/src/sequencer/backup.ts` which knows
 * nothing about files at all. See `steering/game-assets.md`.
 */

import {
  readBackup, readBackupZip, type BackupFile, type BackupResult,
} from '@lbptracker/cwlib/sequencer/backup.ts';
import { webInflate, webInflateRaw } from '@lbptracker/cwlib/platform/web.ts';
import { looksLikeSongJson, sequencerFromSong, songFromJson } from '@lbptracker/lib/song.ts';
// A type and nothing else: the render worker imports this file (see the
// header), and the address bar `link.ts` writes to is no business of a worker.
import type { LinkedLevel } from './link.ts';
import type { Credit } from './song-index.ts';

/**
 * Files bigger than this are skipped without being read.
 *
 * ⚠️ A backup holds photographs, audio and video as well as levels, and a
 * corpus level is under 4 MB. Reading a 600 MB capture into memory to look at
 * its first four bytes is how a page dies on a folder somebody dragged in by
 * accident.
 */
const BIGGEST = 64 * 1024 * 1024;

/** How deep a dropped folder is walked. Backups are flat or nearly so. */
const DEEPEST = 8;

export interface Opened {
  /** What to call it on screen: the file's name, or the folder's. */
  readonly label: string;
  readonly files: readonly BackupFile[];
  /** True when the source was a folder or an archive rather than one file. */
  readonly many: boolean;
  /**
   * Set when this came out of the Internet Archive or off Bonsai, the only
   * sources whose songs can be linked to: `archive-panel.ts` puts the hash it
   * fetched here and `bonsai-panel.ts` the level number, and the page turns it
   * into the URL (`link.ts`). A level off this machine has no name anybody else
   * could open, and says so by leaving this out.
   */
  readonly link?: LinkedLevel;
  /** Set when the song index opened it: its maker, for a sequencer the level names nobody for. */
  readonly credit?: Credit;
}

/**
 * The loader's steps for reading what was opened and making its song playable
 * (`openLevel` in `daw.ts`), and what each usually takes: the bar's weights
 * (`widgets/loading.ts`). Measured on a demo song (16 instruments, 9,180
 * notes) opened from the dev server, 2026-10-24: the read 0.3 s, the
 * instruments 0.6 s and the voice pass 0.15 s. The instruments are given
 * double, since off the deployed site their samples cross a network.
 */
export const PLAN_STEPS = [
  { key: 'instruments', seconds: 1.2 },
  { key: 'voices', seconds: 0.3 },
] as const;
export const OPEN_STEPS = [
  { key: 'assets', seconds: 0.2 },
  { key: 'read', seconds: 0.4 },
  ...PLAN_STEPS,
] as const;
/** What a route that fetches first gives the open that follows: the same time, so the bar runs once. */
export const OPEN_SECONDS = OPEN_STEPS.reduce((sum, s) => sum + s.seconds, 0);
/** A root level from the archive or Bonsai: about 1.7 s before the first byte and 0.5 s of body. */
export const FETCH_SECONDS = 2.2;
/** The dependency walk, when it runs: "Music Gallery #3"'s 17 plans took 7 s (`open_` in `archive-panel.ts`). */
export const WALK_SECONDS = 7;

const read = async (file: File, name = file.name): Promise<BackupFile | undefined> =>
  (file.size > BIGGEST || file.size === 0
    ? undefined
    : { name, bytes: new Uint8Array(await file.arrayBuffer()) });

/**
 * Everything under a dropped directory entry.
 *
 * ⚠️ **`readEntries` returns a PAGE, not the directory.** It hands back at most
 * a hundred entries and has to be called again until it returns none; a reader
 * that calls it once opens the first hundred files of a backup and silently
 * ignores the rest. That is the classic bug with this API and it looks like a
 * backup that is missing levels.
 */
async function walk(
  entry: FileSystemEntry,
  prefix: string,
  depth: number,
  out: BackupFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject));
    const found = await read(file, `${prefix}${entry.name}`);
    if (found) out.push(found);
    return;
  }
  if (!entry.isDirectory || depth >= DEEPEST) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, depth + 1, out);
  }
}

/** What a drop gave us: one file, an archive, or a folder. */
export async function fromDrop(transfer: DataTransfer): Promise<Opened | undefined> {
  const items = [...transfer.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const folders = entries.filter((e): e is FileSystemEntry => e?.isDirectory === true);
  if (folders.length > 0) {
    const out: BackupFile[] = [];
    for (const folder of folders) await walk(folder, '', 0, out);
    return { label: folders.map((f) => f.name).join(', '), files: out, many: true };
  }
  const files = [...transfer.files];
  return fromFiles(files);
}

/** What an `<input type="file">` gave us, single or `webkitdirectory`. */
export async function fromFiles(list: readonly File[]): Promise<Opened | undefined> {
  if (list.length === 0) return undefined;
  if (list.length === 1 && !isZip(list[0])) {
    const one = await read(list[0]);
    return one ? { label: list[0].name, files: [one], many: false } : undefined;
  }
  const out: BackupFile[] = [];
  for (const file of list) {
    // `webkitRelativePath` is the path inside the folder that was picked, and
    // it is the only place the folder's own name survives.
    const found = await read(file, file.webkitRelativePath || file.name);
    if (found) out.push(found);
  }
  const first = list[0].webkitRelativePath.split('/')[0];
  return {
    label: first || (list.length === 1 ? list[0].name : `${list.length} files`),
    files: out,
    many: true,
  };
}

/**
 * Whether this is an archive rather than a resource. Read by extension only.
 *
 * A Craftworld Toolkit `.mod` is a zip; `readBackupZip` tells the two apart.
 */
export function isZip(file: File | { name: string }): boolean {
  return /\.(zip|mod)$/i.test(file.name);
}

/** Whether this is one of this tracker's own song files. Read by extension only. */
export function isSongFile(file: File | { name: string }): boolean {
  return /\.json$/i.test(file.name);
}

/**
 * Whatever was opened, as the pile of sequencers every page reads.
 *
 * ❗ **One reader for the app's drop zone.** A zip is a backup to unpack; a single
 * `.json` is one of this tracker's own song files, which comes back as a level
 * of one sequencer so that the picker, the player, the renderer and the
 * exporter need not know it was ever anything else; anything else is a pile
 * of resources for `readBackup`. Three pages and the render worker each
 * carried the zip-or-pile branch before the song file arrived, which is
 * exactly the copy that would have learned about it one page at a time.
 *
 * A `.json` that is not a song file is reported in `failed`, like a level
 * that would not open, rather than being tried as a resource.
 */
export async function readOpened(files: readonly BackupFile[]): Promise<BackupResult> {
  const only = files.length === 1 ? files[0] : undefined;
  if (only && isSongFile(only)) {
    const text = new TextDecoder().decode(only.bytes);
    const empty = { projects: [], quiet: 0, other: 0, saves: [] } as const;
    if (!looksLikeSongJson(text)) {
      return { ...empty, failed: [{ name: only.name, why: 'not an LBP Tracker song file' }] };
    }
    try {
      const sequencer = sequencerFromSong(songFromJson(text));
      return {
        ...empty,
        projects: [{ file: only.name, kind: 'level', sequencers: [sequencer] }],
        failed: [],
      };
    } catch (error) {
      return { ...empty, failed: [{ name: only.name, why: String((error as Error).message) }] };
    }
  }
  if (only && isZip(only)) return readBackupZip(only.bytes, webInflate, webInflateRaw);
  return readBackup(files, webInflate);
}

/**
 * What to say about the save games in a pile: nothing, when they opened.
 *
 * ❗ **A PS3 save is not an unreadable backup**, though this said it was on
 * all three pages. Its level is an XXTEA'd `FAR4` archive with a key that is a
 * constant, `savearchive.ts` opens it, and the levels simply appear in the list.
 * Only a save that would NOT open is worth a sentence -- and then the sentence
 * has to say what went wrong, because at that point it is a bug here.
 */
export function saveNote(result: Pick<BackupResult, 'saves'>): string {
  const bad = result.saves.find((save) => save.why);
  if (!bad) return '';
  return `${bad.name ?? bad.folder} is a save game that would not open: ${bad.why}`;
}

/**
 * The line over the drop zone: what was opened, and what came out of it.
 *
 * ⚠️ **"56 levels" was wrong the day plans started opening.** A backup of a
 * music gallery is one plan per song, and calling those levels is a lie the
 * three pages would each have told differently. The level count only appears
 * when there is something to tell it apart from.
 */
export function openedTitle(result: BackupResult, sequencers: number, fallback: string): string {
  const of = (kind: string) => result.projects.filter((project) => project.kind === kind).length;
  const levels = of('level');
  const others: [number, string][] = [[of('plan'), 'plan'], [of('chunk'), 'chunk']];
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (levels > 1 || (levels > 0 && others.some(([n]) => n > 0))) parts.push(count(levels, 'level'));
  for (const [n, what] of others) if (n > 0) parts.push(count(n, what));
  parts.push(count(sequencers, 'sequencer'));
  return `${openedLabel(result, fallback)}: ${parts.join(', ')}`;
}

/**
 * What to call what was opened: the save's own name when there is one.
 *
 * A backup zip is called `32406766.zip` and the level inside it is called "FJ's
 * Music Hub by Festerd_Jester". `PARAM.SFO` is not encrypted, so the second one
 * is free.
 */
export function openedLabel(result: Pick<BackupResult, 'saves'>, fallback: string): string {
  const named = result.saves.filter((save) => save.name !== undefined);
  return result.saves.length === 1 && named.length === 1 ? named[0].name! : fallback;
}
