/**
 * The song picker's rows and its two label rules.
 *
 * Split out of the component so that the imperative façade in `seq-picker.ts`
 * can own the state and the pages can keep calling `setRows` / `value` /
 * `select` — three pages drive this from event handlers, and a `ref` they can
 * write is a better fit there than props flowing down from a root that does not
 * exist.
 */

import { reactive } from 'vue';

export interface SeqRow {
  /**
   * What identifies this row, and it is NOT the uid.
   *
   * ⚠️ **A uid is unique inside a level and not across a backup.** Opening a
   * folder of forty levels routinely gives two sequencers numbered 7, and a
   * picker keyed on the uid shows one row where there are two and hands the
   * caller the wrong song. `../cwlib-ts/src/backup.ts` builds these as
   * `file#uid`; a page with one level can pass the uid as a string.
   */
  readonly key: string;
  readonly name: string;
  readonly tracks: number;
  /**
   * The sequencer's own number in its level, shown because it is what a link
   * names a song by (`seq=` in `src/link.ts`). Optional: a page that has no
   * uids to give -- there is none today -- still gets rows.
   */
  readonly uid?: number;
  /** The level it came from, shown when a backup holds more than one. */
  readonly file?: string;
}

export interface PickerState {
  rows: readonly SeqRow[];
  chosen: string;
  /**
   * Whether these songs can be linked to, which decides if the copy button is
   * there at all. ❗ **Only a level fetched from the online archive or from
   * Bonsai can**: a level opened off this machine has no name anybody else
   * could open it by.
   */
  linkable: boolean;
}

export const pickerState = (): PickerState =>
  reactive<PickerState>({ rows: [], chosen: '', linkable: false });

export const title = (row: SeqRow): string => row.name || '(untitled)';

/**
 * What to show for the file a sequencer came out of.
 *
 * ⚠️ **A resource is named after its SHA-1**, so its honest name is 40 hex
 * digits with a save folder in front — 63 characters of noise beside "12
 * instruments", on every row, and a backup of plans is 56 rows of it. Eight
 * digits tell two rows apart, which is this column's only job; identity runs on
 * `key`, which is untouched.
 */
const shortFile = (file: string): string => {
  const leaf = file.slice(file.lastIndexOf('/') + 1);
  return /^[0-9a-f]{40}$/.test(leaf) ? leaf.slice(0, 8) : leaf;
};

export const detail = (row: SeqRow): string =>
  // ❗ The level's name when a backup holds several: two songs called `Intro`
  // in one folder are told apart by the file they came out of and nothing else.
  `${row.tracks} instrument${row.tracks === 1 ? '' : 's'}` +
  `${row.file ? ` · ${shortFile(row.file)}` : ''}`;

/** The uid as it is shown and searched for: `#9819`, or nothing to show. */
export const uidLabel = (row: SeqRow): string => (row.uid === undefined ? '' : `#${row.uid}`);

/**
 * Does this row match what was typed?
 *
 * ❗ **The uid is searchable because it is now an identifier a reader
 * handles**: it is in the link to a song, so `9819` pasted back into the box
 * has to find the row it came from, with or without the `#`. ⚠️ It matches
 * from the *start* of the number and not anywhere inside it -- `98` finds
 * `#9819`, `819` does not -- because a uid is a number a reader is copying,
 * not prose to search through.
 */
export const matches = (row: SeqRow, needle: string): boolean => {
  const q = needle.trim().toLowerCase();
  if (q === '') return true;
  if (title(row).toLowerCase().includes(q)) return true;
  return row.uid !== undefined && `#${row.uid}`.includes(q.startsWith('#') ? q : `#${q}`);
};
