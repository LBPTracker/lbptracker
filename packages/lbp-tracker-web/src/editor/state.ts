/**
 * What the editor is looking at, and the history behind it.
 *
 * ❗ **The song is a plain object, not a reactive one.** The board and the piano
 * roll are canvases redrawn on a change signal, and a `Song` wrapped in Vue's
 * proxies would make every note a proxy and every drag a cascade of dependency
 * tracking for no listener; see *Vue, and where it is not allowed* in
 * steering/tracker-architecture.md. The panels that ARE Vue read the song
 * through `version`, a counter that ticks on every change, and write through
 * `edit`.
 *
 * Undo is by snapshot: the song is small enough (`Ascetic`, the corpus's
 * largest, is 1,150 clips and 91,000 points, a few hundred kilobytes) that a
 * structured clone per edit is cheaper than a command log and impossible to
 * get out of step.
 */

import { ref } from 'vue';
import { addRow, removeRow, type Clip, type Song, type SongNote, type SongPoint } from '@lbptracker/lib/song.ts';

/**
 * What an edit touched, so the page knows what to do about it: the plan has
 * to be rebuilt for a note, a placement or an instrument; the mixer and the
 * clock are applied live for a setting; the output stage is one message.
 *
 * ❗ **`look` is a change to the song that nothing plays** -- a chip's tint,
 * the author. It marks the song dirty and redraws the canvases like any other
 * edit, and `daw/session.ts` deliberately does nothing with it: rebuilding a
 * plan for a colour would cut the voices a chip is sounding.
 */
export type ChangeKind = 'notes' | 'settings' | 'effects' | 'selection' | 'mix' | 'look';

export interface Selection {
  /**
   * The board row the roll follows: while the song plays, the chip the
   * playhead is inside on this row is the one shown. Row 0 to begin with.
   */
  row: number;
  /**
   * The clip whose grid the piano roll shows: the one clicked last, or the
   * one the playhead is inside on the selected row.
   */
  clipId: number | null;
  /**
   * The board's selection: the chips chosen as a block, by a click, a
   * Shift+drag rectangle or Ctrl+click, which the board's keys and a drag act
   * on as one. `clipId` is normally in it -- clicking a chip selects it
   * alone -- but not always: the playhead moves `clipId` on and leaves a
   * block where it is, so the roll can follow the song while a block waits.
   */
  clips: Set<number>;
  /**
   * **The selection is a set of points, not of notes**: for each note id, the
   * indices of its selected points. A note counts as selected when every one
   * of its points is in here, which is what clicking its line does.
   *
   * ⚠️ It was a set of note ids until 2026-09-07. The rectangle then took
   * whole notes, so there was no way to grab the tail of a glide and leave
   * its head alone -- which is most of what editing a chain of control points
   * is for.
   */
  points: Map<number, Set<number>>;
  /** The one point the inspector edits: the last one touched. */
  point: { noteId: number; index: number } | null;
  /** The board's cursor: where the next instrument goes. */
  cursor: { cell: number; row: number } | null;
}

export class EditorState {
  song: Song;
  /** Ticks on every change; the Vue panels depend on it. */
  readonly version = ref(0);
  readonly selection: Selection = {
    row: 0, clipId: null, clips: new Set(), points: new Map(), point: null, cursor: null,
  };
  /** The piano roll's grid: thirds of a step when on, whole steps when off. */
  triplets = false;
  /**
   * Rows muted and soloed, for listening only.
   *
   * ⚠️ Not the song's: the game has no mute or solo, so neither is written to
   * the song file or the MIDI. They decide which rows reach the player's plan
   * and the render -- what is heard -- and any solo outranks every mute.
   */
  readonly mutedRows = new Set<number>();
  readonly soloRows = new Set<number>();
  /**
   * A section of the board to go round while playing, in timeline steps,
   * dragged out on the board's ruler; null for none.
   *
   * ⚠️ Not the song's either: the game's `Loop` is a flag over the whole
   * song, and this is ours, for listening. Whole cells, like a chip's section,
   * so its step count is even and the swing lines up between passes (`Player`).
   */
  loopRegion: { start: number; end: number } | null = null;
  dirty = false;

  private undoStack: Song[] = [];
  private redoStack: Song[] = [];
  private lastKey: string | undefined;
  private lastAt = 0;
  private readonly listeners = new Set<(kind: ChangeKind) => void>();

  constructor(song: Song) {
    this.song = song;
  }

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether a row is heard, under the mutes and solos as they stand. */
  rowAudible(row: number): boolean {
    return this.soloRows.size > 0 ? this.soloRows.has(row) : !this.mutedRows.has(row);
  }

  toggleMute(row: number): void {
    if (!this.mutedRows.delete(row)) this.mutedRows.add(row);
    this.notify('mix');
  }

  toggleSolo(row: number): void {
    if (!this.soloRows.delete(row)) this.soloRows.add(row);
    this.notify('mix');
  }

  /** Set the loop region, or clear it with null or an empty span. */
  setLoopRegion(start: number | null, end = 0): void {
    const next = start !== null && end > start ? { start, end } : null;
    const was = this.loopRegion;
    if (next?.start === was?.start && next?.end === was?.end) return;
    this.loopRegion = next;
    this.notify('selection');
  }

  /** One more row under the last. */
  addRow(): void {
    this.edit('settings', (song) => { addRow(song); });
  }

  /**
   * Take a row out, chips and all. The mutes and solos below it move up with
   * their rows; the selection moves to the row now in its place.
   */
  removeRow(row: number): void {
    if (row < 0 || row >= this.song.boardRows || this.song.boardRows <= 1) return;
    const shift = (rows: Set<number>) => {
      const next = [...rows].filter((r) => r !== row).map((r) => (r > row ? r - 1 : r));
      rows.clear();
      for (const r of next) rows.add(r);
    };
    shift(this.mutedRows);
    shift(this.soloRows);
    if (this.selection.cursor && this.selection.cursor.row >= row) {
      this.selection.cursor = this.selection.cursor.row === row
        ? null
        : { ...this.selection.cursor, row: this.selection.cursor.row - 1 };
    }
    this.edit('notes', (song) => { removeRow(song, row); });
    this.pruneClips();
    // The selection may name the chips that went; a row's worth of them.
    if (!this.clip()) {
      this.selection.clipId = null;
      this.selection.points = new Map();
      this.selection.point = null;
    }
    if (this.selection.row >= row) {
      this.selectRow(Math.min(this.song.boardRows - 1, Math.max(0, this.selection.row === row ? row : this.selection.row - 1)));
    }
  }

  private notify(kind: ChangeKind): void {
    this.version.value += 1;
    for (const listener of this.listeners) listener(kind);
  }

  /** Something other than the song changed -- the selection, the grid switch. */
  touch(kind: ChangeKind = 'selection'): void {
    this.notify(kind);
  }

  /**
   * Mutate the song under one undo entry.
   *
   * `key` coalesces: consecutive edits with the same key inside a second share
   * one entry, so a slider dragged across fifty values undoes in one step.
   */
  edit(kind: ChangeKind, fn: (song: Song) => void, key?: string): void {
    const now = Date.now();
    if (key === undefined || key !== this.lastKey || now - this.lastAt > 1000) {
      this.undoStack.push(structuredClone(this.song));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastKey = key;
    this.lastAt = now;
    fn(this.song);
    this.dirty = true;
    this.notify(kind);
  }

  /**
   * A drag: one undo entry taken at the start, then mutations applied directly
   * with `during`, and `endDrag` to say what kind of change it was.
   */
  beginDrag(): void {
    this.undoStack.push(structuredClone(this.song));
    this.redoStack = [];
    this.lastKey = undefined;
  }

  during(fn: (song: Song) => void): void {
    fn(this.song);
    this.notify('selection');
  }

  endDrag(kind: ChangeKind, changed = true): void {
    if (!changed) {
      // Nothing moved: the entry taken at the start would undo nothing.
      this.undoStack.pop();
      this.notify('selection');
      return;
    }
    this.dirty = true;
    this.notify(kind);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.song);
    this.song = previous;
    this.lastKey = undefined;
    this.afterRestore();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.song);
    this.song = next;
    this.lastKey = undefined;
    this.afterRestore();
  }

  /** A new song altogether: opened, or started blank. */
  replace(song: Song): void {
    this.song = song;
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = undefined;
    this.dirty = false;
    // The chip nearest the start of the song, and its row: the roll opens on
    // the first thing that will sound, not on whatever the file listed first
    // (on Ascetic that was a chip at bar 175). Row 0 when the song is empty.
    const first = [...song.clips].sort((a, b) => a.cell - b.cell || a.row - b.row)[0];
    this.selection.row = first?.row ?? 0;
    this.selection.clipId = first?.id ?? null;
    this.selection.clips = new Set(first ? [first.id] : []);
    this.mutedRows.clear();
    this.soloRows.clear();
    this.loopRegion = null;
    this.selection.points = new Map();
    this.selection.point = null;
    this.selection.cursor = null;
    this.followPlayhead = true;
    this.notify('notes');
  }

  private afterRestore(): void {
    // The selection may name things the restored song no longer has.
    this.pruneClips();
    const clip = this.clip();
    if (!clip) {
      this.selection.clipId = this.song.clips[0]?.id ?? null;
      if (this.selection.clips.size === 0 && this.selection.clipId !== null) {
        this.selection.clips.add(this.selection.clipId);
      }
      this.selection.points = new Map();
      this.selection.point = null;
    } else {
      const ids = new Set(clip.notes.map((n) => n.id));
      for (const id of [...this.selection.points.keys()]) if (!ids.has(id)) this.selection.points.delete(id);
      if (this.selection.point && !ids.has(this.selection.point.noteId)) this.selection.point = null;
    }
    this.dirty = true;
    this.notify('notes');
  }

  // --------------------------------------------------------------- lookups

  clip(id: number | null = this.selection.clipId): Clip | undefined {
    return id === null ? undefined : this.song.clips.find((c) => c.id === id);
  }

  note(clip: Clip, id: number): SongNote | undefined {
    return clip.notes.find((n) => n.id === id);
  }

  /** The selected point, resolved. */
  point(): { clip: Clip; note: SongNote; point: SongPoint; index: number } | undefined {
    const clip = this.clip();
    const sel = this.selection.point;
    if (!clip || !sel) return undefined;
    const note = this.note(clip, sel.noteId);
    const point = note?.points[sel.index];
    if (!note || !point) return undefined;
    return { clip, note, point, index: sel.index };
  }

  /** The chip on a row nearest the start of the song. */
  firstClipOnRow(row: number): Clip | undefined {
    return this.song.clips
      .filter((c) => c.row === row)
      .sort((a, b) => a.cell - b.cell)[0];
  }

  /**
   * Whether the roll moves to the chip the playhead is inside.
   *
   * ❗ **A state, not a rule** -- the same decision `editor/follow.ts` records
   * for the scroll, and for the same reason: it used to win over the person.
   * Clicking a chip means "show me this one", so it switches the follow off;
   * choosing a row means "watch this row", so it switches it back on, as does
   * opening a song, the button in the panel head, and landing back on the chip
   * the playhead is in.
   *
   * ⚠️ Before this it was neither on nor off. A chip clicked on the playhead's
   * own row was shown until the playhead crossed into the next chip, which
   * yanked the view away mid-edit; a chip clicked on another row was overridden
   * on the very next frame if the playhead happened to be inside a chip there,
   * and held forever if it was not.
   */
  followPlayhead = true;
  /** True only while listeners are told about a chip the follow switched to: the roll opens it without searching. */
  followedNow = false;
  /** The chip the playhead is inside, if any: set by the page, which owns the player. */
  liveChipId: () => number | null = () => null;

  /** Select a clip alone, and with it the row it sits on. Any block selected before goes. */
  selectClip(id: number | null): void {
    const clip = this.clip(id);
    if (clip) this.selection.row = clip.row;
    // The person is pointing at a chip: stop following until asked again -- unless it is the
    // chip the playhead is in, which is where following would take the roll anyway.
    // ⚠️ After the row: `liveChipId` looks on the selected row, and the old one is the wrong one.
    this.followPlayhead = clip !== undefined && this.liveChipId() === clip.id;
    this.selection.clips = new Set(clip ? [clip.id] : []);
    if (this.selection.clipId === id) {
      this.notify('selection');
      return;
    }
    this.selection.clipId = id;
    this.selection.points = new Map();
    this.selection.point = null;
    this.notify('selection');
  }

  /**
   * Select a row: the roll moves to its first chip unless the selected chip
   * is already on it.
   */
  selectRow(row: number): void {
    const current = this.clip();
    this.selection.row = row;
    if (current && current.row === row) {
      this.followPlayhead = true;
      this.notify('selection');
      return;
    }
    this.selectClip(this.firstClipOnRow(row)?.id ?? null);
    // ❗ **Choosing a row is "watch this row", so it follows** -- `selectClip`
    // has just switched that off for the chip it picked, and this is the one
    // caller that means the opposite.
    this.followPlayhead = true;
    this.notify('selection');
  }

  /**
   * The roll follows the playhead into another chip. A chip selected alone
   * follows with it, as the selection always has; a block stays where it is,
   * so the song can play on while a block waits to be moved or copied.
   *
   * ⚠️ Not `selectClip`: that collapses the block, and the playhead crosses
   * a chip every few seconds.
   */
  followClip(id: number): void {
    if (this.selection.clipId === id) return;
    const was = this.selection.clipId;
    const { clips } = this.selection;
    if (clips.size === 0 || (clips.size === 1 && was !== null && clips.has(was))) {
      this.selection.clips = new Set([id]);
    }
    this.selection.clipId = id;
    this.selection.points = new Map();
    this.selection.point = null;
    this.followedNow = true;
    try {
      this.notify('selection');
    } finally {
      this.followedNow = false;
    }
  }

  /**
   * Replace the board's selection with these chips. `lead` is the one the
   * roll shows; without one the roll keeps its chip if it is in the set and
   * takes the set's first by position otherwise. An empty set leaves the roll
   * where it is.
   */
  selectClips(ids: Iterable<number>, lead?: number): void {
    const next = new Set<number>();
    for (const id of ids) if (this.clip(id)) next.add(id);
    this.selection.clips = next;
    let show = lead !== undefined && next.has(lead) ? lead : this.selection.clipId;
    if (next.size > 0 && (show === null || !next.has(show))) show = this.boardSelection()[0].id;
    if (show !== this.selection.clipId) {
      this.selection.clipId = show;
      this.selection.points = new Map();
      this.selection.point = null;
    }
    const shown = this.clip();
    if (shown) this.selection.row = shown.row;
    // A chip pointed at (`lead`) that is the one the playhead is in keeps it following, as in
    // `selectClip`; a block taken any other way -- a rectangle, everything, a copy -- stops it,
    // or a follow the person switched off would come back on with it.
    this.followPlayhead = lead !== undefined && shown?.id === lead && this.liveChipId() === lead;
    this.notify('selection');
  }

  /** Ctrl+click: a chip into the block, or out of it. */
  toggleClip(id: number): void {
    const next = new Set(this.selection.clips);
    if (!next.delete(id)) next.add(id);
    this.selectClips(next, next.has(id) ? id : undefined);
  }

  /** The chips selected on the board, in board order: by cell, then by row. */
  boardSelection(): Clip[] {
    return this.song.clips
      .filter((c) => this.selection.clips.has(c.id))
      .sort((a, b) => a.cell - b.cell || a.row - b.row);
  }

  /** Drop from the board's selection whatever the song no longer holds. */
  private pruneClips(): void {
    const ids = new Set(this.song.clips.map((c) => c.id));
    for (const id of [...this.selection.clips]) if (!ids.has(id)) this.selection.clips.delete(id);
  }

  // ------------------------------------------------------------ selecting

  /** Replace the selection with these points, and say which one the inspector shows. */
  selectPoints(points: Iterable<readonly [number, number]>, point: Selection['point'] = null): void {
    const next = new Map<number, Set<number>>();
    for (const [noteId, index] of points) {
      const set = next.get(noteId) ?? new Set<number>();
      set.add(index);
      next.set(noteId, set);
    }
    this.selection.points = next;
    this.selection.point = point;
    this.notify('selection');
  }

  /** Select whole notes: every point of each. The gesture for clicking a line. */
  selectNotes(ids: Iterable<number>, point: Selection['point'] = null): void {
    const clip = this.clip();
    const next = new Map<number, Set<number>>();
    for (const id of ids) {
      const note = clip && this.note(clip, id);
      if (!note) continue;
      next.set(id, new Set(note.points.map((_, i) => i)));
    }
    this.selection.points = next;
    this.selection.point = point;
    this.notify('selection');
  }

  isSelected(noteId: number, index: number): boolean {
    return this.selection.points.get(noteId)?.has(index) ?? false;
  }

  /** Whether every point of a note is in the selection: the note as a whole. */
  isNoteSelected(note: SongNote): boolean {
    const set = this.selection.points.get(note.id);
    return !!set && note.points.every((_, i) => set.has(i));
  }

  /** How many points are selected, across every note. */
  get selectedCount(): number {
    let n = 0;
    for (const set of this.selection.points.values()) n += set.size;
    return n;
  }

  /** The selection as [note, indices] pairs, resolved against the clip. */
  selectedPoints(): { note: SongNote; indices: number[] }[] {
    const clip = this.clip();
    if (!clip) return [];
    const out: { note: SongNote; indices: number[] }[] = [];
    for (const [id, set] of this.selection.points) {
      const note = this.note(clip, id);
      if (!note) continue;
      const indices = [...set].filter((i) => i < note.points.length).sort((a, b) => a - b);
      if (indices.length) out.push({ note, indices });
    }
    return out;
  }
}
