/**
 * The editor's two grids as arithmetic: where a cell, a step or a pitch sits
 * on a canvas, and back. No DOM here, so `test/editor-geometry.test.ts` can
 * hold it.
 *
 * The board is the game's: a cell is 16 steps, two of the game's 8-step bars,
 * half of one of its 105-unit tiles, and a row is one placement high
 * (../cwlib-ts/steering/sequencer-data-model.md, *The timeline* and *The tile*). The piano roll is the placement's own note grid: positions
 * in thirds of a step, because that is the record's resolution, and one row
 * per pitch.
 */

import { STEPS_PER_CELL } from '@lbptracker/cwlib/sequencer/project.ts';
import { BARS_PER_CELL, STEPS_PER_BAR } from '@lbptracker/lib/song.ts';

export { BARS_PER_CELL, STEPS_PER_BAR, STEPS_PER_CELL };

// ------------------------------------------------------------------ the board

export interface BoardLayout {
  /** Pixels per cell, each way. */
  readonly cellW: number;
  readonly cellH: number;
  /** The row-number gutter on the left, and the bar ruler above. */
  readonly gutter: number;
  readonly ruler: number;
  readonly cols: number;
  readonly rows: number;
}

export function boardSize(layout: BoardLayout): { width: number; height: number } {
  return {
    width: layout.gutter + layout.cols * layout.cellW,
    height: layout.ruler + layout.rows * layout.cellH,
  };
}

/** The cell under a canvas point, or null off the grid. */
export function boardCellAt(
  layout: BoardLayout,
  x: number,
  y: number,
): { cell: number; row: number } | null {
  const cell = Math.floor((x - layout.gutter) / layout.cellW);
  const row = Math.floor((y - layout.ruler) / layout.cellH);
  if (cell < 0 || row < 0 || cell >= layout.cols || row >= layout.rows) return null;
  return { cell, row };
}

export function boardRect(
  layout: BoardLayout,
  cell: number,
  row: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: layout.gutter + cell * layout.cellW,
    y: layout.ruler + row * layout.cellH,
    w: layout.cellW,
    h: layout.cellH,
  };
}

/** A step on the timeline to a board x. Fractional steps welcome: the playhead. */
export function boardX(layout: BoardLayout, step: number): number {
  return layout.gutter + (step / STEPS_PER_CELL) * layout.cellW;
}

/** A rectangle on a canvas, in content pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A chip's rectangle on the board: from its cell to the end of its grid, one row high. */
export function boardChipRect(layout: BoardLayout, chip: { cell: number; row: number; steps: number }): Rect {
  const r = boardRect(layout, chip.cell, chip.row);
  return { ...r, w: Math.max(1, chip.steps / STEPS_PER_CELL) * layout.cellW };
}

/** Whether two rectangles share any area: a marquee catches a chip by touching it, and an edge is not a touch. */
export function rectsMeet(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The mixer channel a row feeds: the board cut into `channels` bands of equal
 * height, as `channelVolume` computes it. Kept here for drawing the bands;
 * the one that decides the gain is in `@lbptracker/cwlib/sequencer/project.ts`.
 */
export function bandOf(row: number, rows: number, channels: number): number {
  const count = Math.max(1, channels);
  const divisor = Math.max(Math.floor(rows / count), 1);
  return Math.min(count - 1, Math.max(0, Math.floor(row / divisor)));
}

// ------------------------------------------------------------- the piano roll

export interface RollLayout {
  /** The keyboard on the left, and the step ruler above. */
  readonly keys: number;
  readonly ruler: number;
  /** Pixels per step. */
  readonly stepW: number;
  /** Pixels per pitch row. */
  readonly rowH: number;
  /** The clip's grid length. */
  readonly steps: number;
  /**
   * Steps drawn BEFORE the clip's own grid -- one bar of lead-in -- and after
   * it, where what the row's other chips hold is shown through and cannot be
   * touched. Both are 0 when there is nothing to show there.
   *
   * ❗ **Kept apart from `steps` on purpose.** Everything that asks "how long
   * is this clip" -- where a click may land, what `find the notes` may scroll
   * to -- reads `steps`, and reads it unchanged; only the drawn width, and the
   * x a position lands on, know about these.
   */
  readonly head: number;
  readonly tail: number;
  /** Whether the grid's cells are thirds of a step rather than steps. */
  readonly triplets: boolean;
}

export const PITCHES = 128;

/**
 * A triplet cell, in thirds of a step: a third of a BEAT, not of a step. A
 * beat is four steps -- twelve thirds -- so the triplet grid has three cells
 * to the beat, each four thirds (1⅓ steps) wide, and is sparser than the
 * whole-step grid, not three times denser. This is what the record's thirds
 * exist for: the triplet positions 1⅓ and 2⅔ are the sub-steps 1 and 2 the
 * corpus holds in equal measure (../cwlib-ts/steering/sequencer-data-model.md).
 *
 * ⚠️ For a day the triplet grid was thirds of a step, three cells per step;
 * the owner called it far too dense, and it was.
 */
export const TRIPLET_THIRDS = 4;

/** The thirds a position is a multiple of on a grid: 3 for steps, 4 for triplets. */
export const gridUnit = (triplets: boolean): number => (triplets ? TRIPLET_THIRDS : 3);

export function rollSize(layout: RollLayout): { width: number; height: number } {
  return {
    width: layout.keys + (layout.head + layout.steps + layout.tail) * layout.stepW,
    height: layout.ruler + PITCHES * layout.rowH,
  };
}

/** The lead-in: one bar, the game's own 8 steps. */
export const HEAD_STEPS = STEPS_PER_BAR;

/** A note of another chip on the row, and what to add to its positions here. */
export interface Ghost<N> {
  readonly note: N;
  /** Thirds to add to each of its positions to bring it onto this clip's grid. */
  readonly shift: number;
}

/**
 * What the row's other chips hold around this clip: **a bar before it, and
 * everything after it**.
 *
 * ❗ **A chip's clip is not the whole of its row's music.** Chips of one row
 * overlap heavily -- a cell is 16 steps and a clip may hold 128, and `Ascetic`
 * places one every two cells -- so the notes on either side of the one being
 * edited belong to chips this grid does not show, and both joins were
 * invisible. This is the rule for what to draw through: a note of another chip
 * on the row whose own span reaches into the window.
 *
 * The two sides are deliberately not symmetric. **Before** is one bar: enough
 * to see what you are answering, and no more, because the grid would otherwise
 * open somewhere in the middle of the row's history. **After** is everything,
 * to the last note any of the row's other chips holds, rounded up to a bar --
 * what comes next is what an author is writing towards.
 *
 * ⚠️ The head is clamped at the song's start: a chip on cell 0 has no bar
 * before it, and there is no negative time to draw.
 *
 * Generic over the note so this stays pure geometry: it needs a position and
 * nothing else about a note.
 */
export function ghostWindow<N extends { points: readonly { thirds: number }[] }>(
  clip: { cell: number; steps: number },
  others: readonly { cell: number; notes: readonly N[] }[],
  headSteps: number = HEAD_STEPS,
): { ghosts: Ghost<N>[]; head: number; tail: number } {
  const head = Math.min(headSteps, clip.cell * STEPS_PER_CELL);
  const from = -head * 3;
  const end = clip.steps * 3;
  const spans: { note: N; shift: number; first: number; last: number }[] = [];
  let furthest = end;
  for (const other of others) {
    const shift = (other.cell - clip.cell) * STEPS_PER_CELL * 3;
    for (const note of other.notes) {
      if (note.points.length === 0) continue;
      let first = Infinity;
      let last = -Infinity;
      for (const p of note.points) {
        if (p.thirds < first) first = p.thirds;
        if (p.thirds > last) last = p.thirds;
      }
      first += shift;
      last += shift;
      if (last < from) continue;
      spans.push({ note, shift, first, last });
      if (last > furthest) furthest = last;
    }
  }
  const tail = Math.ceil((furthest / 3 - clip.steps) / STEPS_PER_BAR) * STEPS_PER_BAR;
  // ⚠️ A note whose whole span sits inside the clip's own window is another
  // chip sounding UNDER this one, not before or after it, and drawing it would
  // put a ghost the author cannot touch on top of the notes they are editing.
  //
  // ❗ There is no upper bound to test against: the tail was measured from
  // these same notes, so anything reaching past the clip is inside it. An
  // upper bound of `(steps + tail) * 3` looks right and drops the furthest
  // note of the row, which is the one that set the tail in the first place.
  const ghosts = spans
    .filter((s) => s.first < 0 || s.last >= end)
    .map(({ note, shift }) => ({ note, shift }));
  return {
    ghosts,
    head: ghosts.some((g) => g.note.points.some((p) => p.thirds + g.shift < 0)) ? head : 0,
    tail,
  };
}

/**
 * A position in thirds of a step to its canvas x: the CENTRE of its cell, the
 * way the game's grid draws a note.
 *
 * ❗ **Positions stay the clip's own, and the head is an offset applied on the
 * way to the canvas.** A position before the clip's first step is negative,
 * which is exactly what the lead-in bar holds; every clamp, snap and hit test
 * goes on working in the clip's own thirds, and only this, `rollStepX` and
 * `rollThirdsAt` know that the grid no longer starts at x = `keys`. On the triplet grid a point on a triplet
 * cell sits in the centre of that four-third cell; otherwise a point on a
 * whole step sits in the centre of the step, and a point on a third in the
 * centre of the third -- the finest cell it is on.
 *
 * ⚠️ For a day every point sat at the centre of its third, which in a
 * whole-step grid is a sixth of the way into the step -- "all shifted left".
 */
export function rollX(layout: RollLayout, thirds: number): number {
  const unit = layout.triplets && thirds % TRIPLET_THIRDS === 0
    ? TRIPLET_THIRDS
    : thirds % 3 === 0 ? 3 : 1;
  return layout.keys + (layout.head + (thirds + unit / 2) / 3) * layout.stepW;
}

/** A step boundary to its canvas x: the grid lines, the ruler, the playhead. */
export function rollStepX(layout: RollLayout, step: number): number {
  return layout.keys + (layout.head + step) * layout.stepW;
}

/** A canvas x to a continuous position in thirds; `snapThirds` picks the cell. */
export function rollThirdsAt(layout: RollLayout, x: number): number {
  return ((x - layout.keys) / layout.stepW - layout.head) * 3;
}

/** The centre of a pitch's row. Pitch 127 is the top row. */
export function rollY(layout: RollLayout, pitch: number): number {
  return layout.ruler + (PITCHES - 1 - pitch + 0.5) * layout.rowH;
}

/** The pitch whose row holds a canvas y. */
export function rollPitchAt(layout: RollLayout, y: number): number {
  const row = Math.floor((y - layout.ruler) / layout.rowH);
  return Math.max(0, Math.min(PITCHES - 1, PITCHES - 1 - row));
}

/**
 * The grid cell a continuous position falls in: a whole step, or a triplet
 * cell of four thirds when the grid is set to triplets. A click anywhere
 * inside a cell means that cell, as on the game's grid.
 */
export function snapThirds(thirds: number, triplets: boolean, steps: number): number {
  const unit = gridUnit(triplets);
  const snapped = Math.floor(thirds / unit) * unit;
  return Math.max(0, Math.min(steps * 3 - 1, snapped));
}

/** Whether a note sits entirely on a grid's cells. */
export function onGrid(points: readonly { thirds: number }[], triplets: boolean): boolean {
  const unit = gridUnit(triplets);
  return points.every((p) => p.thirds % unit === 0);
}

/** A note's volume as a dot: 0..127 to a radius, never smaller than a target. */
export function pointRadius(volume: number, rowH: number): number {
  const t = Math.max(0, Math.min(127, volume)) / 127;
  return rowH * (0.18 + 0.32 * t);
}

/**
 * The half-width of the line at a point: the same volume the dot shows, so a
 * segment tapers from one point's volume to the next's and the ribbon's
 * thickness is the volume the engine glides through.
 *
 * A fraction of `pointRadius`, so it stays well inside the dot: the dots
 * remain what you read a volume off, and they cover the joints where two
 * segments of different slopes meet.
 */
export function pointLineHalf(volume: number, rowH: number): number {
  return Math.max(0.75, pointRadius(volume, rowH) * 0.42);
}

/**
 * The note's timbre as a colour: blue at 0, orange at 15, as the game paints it.
 *
 * A straight blend in RGB between the two, which passes through a grey in the
 * middle; that is what the in-game grid does too, and it keeps the two ends
 * unmistakable.
 */
export function timbreColour(timbre: number, alpha = 1): string {
  const t = Math.max(0, Math.min(15, timbre)) / 15;
  const blue = [66, 140, 255];
  const orange = [255, 140, 36];
  const c = blue.map((b, i) => Math.round(b + (orange[i] - b) * t));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI numbering: 60 is C4, which is the numbering `basenote` uses. */
export function noteName(pitch: number): string {
  return `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** A position in thirds as "bar.beat.step+third" for a label; a bar is the game's 8 steps. */
export function positionLabel(thirds: number): string {
  const step = Math.floor(thirds / 3);
  const third = thirds - step * 3;
  const bar = Math.floor(step / STEPS_PER_BAR) + 1;
  const beat = Math.floor((step % STEPS_PER_BAR) / 4) + 1;
  const sub = (step % 4) + 1;
  return `${bar}.${beat}.${sub}${third ? `+${third}/3` : ''}`;
}

/** The game's bar a board cell starts at, 1-based, for labels. */
export function barOfCell(cell: number): number {
  return cell * BARS_PER_CELL + 1;
}

/** A note's extent on the grid, in whole rows and whole steps. */
export interface NoteBox {
  readonly rowMin: number;
  readonly rowMax: number;
  readonly stepMin: number;
  readonly stepMax: number;
}

/**
 * Where to scroll a grid so that **the most notes are on screen at once**.
 *
 * The window's origin is what is being chosen, so turn the question inside
 * out: a note is visible from a *rectangle* of origins -- rows
 * `[rowMax - rows + 1, rowMin]` by steps `[stepMax - cols + 1, stepMin]`,
 * clamped -- and the best origin is the one the most of those rectangles
 * cover. Adding 1 over each rectangle in a difference array and taking the 2D
 * prefix sum gives the count for **every** origin at once, so this is exact
 * rather than a search, and it costs `rows x steps + notes` rather than
 * `origins x notes`.
 *
 * Ties go to the origin nearest `prefer`, which the caller sets to whatever it
 * would have done anyway: the view then only moves when moving buys something.
 */
export function bestNoteWindow(
  boxes: readonly NoteBox[],
  view: { rows: number; cols: number; rowCount: number; stepCount: number },
  prefer: { row: number; step: number },
): { row: number; step: number; visible: number } {
  const maxRow = Math.max(0, view.rowCount - view.rows);
  const maxStep = Math.max(0, view.stepCount - view.cols);
  const w = maxStep + 2;
  const diff = new Int32Array((maxRow + 2) * w);
  for (const b of boxes) {
    // ⚠️ **Overlap, not containment.** The origins a note is *visible* from
    // are `[rowMin - rows + 1, rowMax]`; the other way round is the rectangle
    // of origins that hold the note *whole*, and it is empty for anything
    // taller or wider than the window, which quietly dropped exactly the
    // notes a composer most wants to find.
    const r0 = Math.max(0, Math.min(maxRow, b.rowMin - view.rows + 1));
    const r1 = Math.max(0, Math.min(maxRow, b.rowMax));
    const s0 = Math.max(0, Math.min(maxStep, b.stepMin - view.cols + 1));
    const s1 = Math.max(0, Math.min(maxStep, b.stepMax));
    if (r0 > r1 || s0 > s1) continue;
    diff[r0 * w + s0] += 1;
    diff[r0 * w + s1 + 1] -= 1;
    diff[(r1 + 1) * w + s0] -= 1;
    diff[(r1 + 1) * w + s1 + 1] += 1;
  }
  let best = { row: prefer.row, step: prefer.step, visible: -1 };
  let bestDistance = Infinity;
  for (let r = 0; r <= maxRow; r += 1) {
    for (let s = 0; s <= maxStep; s += 1) {
      const above = r > 0 ? diff[(r - 1) * w + s] : 0;
      const left = s > 0 ? diff[r * w + s - 1] : 0;
      const corner = r > 0 && s > 0 ? diff[(r - 1) * w + s - 1] : 0;
      const count = diff[r * w + s] + above + left - corner;
      diff[r * w + s] = count;
      const distance = Math.abs(r - prefer.row) + Math.abs(s - prefer.step);
      if (count > best.visible || (count === best.visible && distance < bestDistance)) {
        best = { row: r, step: s, visible: count };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Distance from a point to a segment, for hit-testing a note's line. */
export function segmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
