/**
 * Saving a song as this tracker's own file, from any page.
 *
 * A level's sequencer or the editor's song goes out as
 * `{ format: "lbptracker-song", version: 1, song }` (`@lbptracker/lib/song.ts`),
 * named after the song, through a download the browser owns. Reading one back
 * is `readOpened` in `open-level.ts`, which every page's drop zone goes
 * through -- so a file saved on the renderer opens in the editor, and the
 * other way round.
 *
 * ⚠️ This touches the DOM (`<a download>`), so it stays out of `open-level.ts`,
 * which a worker imports.
 */

import type { Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { songFromSequencer, songToJson, type Song } from '@lbptracker/lib/song.ts';

export const SONG_FILE_SUFFIX = '.lbptracker.json';

/** A file name a song can be saved under: its name, made safe, plus the suffix. */
export function songFileName(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'song'}${SONG_FILE_SUFFIX}`;
}

/** Hand the browser a file to save. */
export function download(name: string, body: Uint8Array | string, type: string): void {
  const blob = new Blob([body as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save a song, or a level's sequencer as one. Returns the file name used. */
export function saveSongFile(source: Song | Sequencer): string {
  const song = 'clips' in source ? source : songFromSequencer(source);
  const name = songFileName(song.name);
  download(name, songToJson(song), 'application/json');
  return name;
}
