/**
 * The piano roll: one placement's note grid, drawn on a canvas.
 *
 * What it draws is the game's own picture of a note: a chain of control
 * points joined by straight lines, each point's size its volume and its
 * colour its timbre -- blue at 0, orange at 15 -- with a keyboard down the
 * left and a step grid that can be switched between whole steps and thirds.
 * The engine glides linearly between consecutive points, so the straight
 * line is not a drawing convention: it is what will sound -- and the line
 * carries the glide, swelling with the volume and shifting hue with the
 * timbre from one point to the next.
 *
 * ❗ **A canvas the size of the viewport, not of the grid.** 128 pitch rows by
 * 128 steps is a 3,000 by 1,700 pixel surface, twice that on a high-density
 * screen, and the playhead redraws thirty times a second; so the canvas is
 * `position: sticky` inside a scroller whose spacer sets the scroll size, and
 * only the visible window is painted, offset by the scroll. The keyboard and
 * the ruler are painted over the content at the canvas's own edges, which is
 * what makes them stay put.
 *
 * The pointer's vocabulary, all of it visible in the hint under the grid:
 *
 * | on              | plain             | shift            | alt              | right click |
 * |-----------------|-------------------|------------------|------------------|-------------|
 * | empty           | draw a note; drag for its end | rectangle (ctrl too: add to the selection) | — | — |
 * | a point         | move it, or the whole selection when there is one | volume (up/down) | timbre (up/down) | delete it |
 * | a line          | move the note, or the whole selection | —          | —                | delete note |
 * | double-click    | line: add a point; point: delete it                    |             |
 *
 * Ctrl on a point or a line adds that note to the selection, or takes it out.
 * The rectangle catches a note by a point inside it **or by a line crossing
 * it**, so a held note is caught by a rectangle drawn across its middle.
 *
 * The commands the page's keys reach are at the end of the class:
 * `deleteSelection`, `nudge`, `adjust`, `selectAll`, `copy`, `cut`, `paste`,
 * `duplicateSelection`.
 */

import {
  addNote,
  addPoint,
  lastThirds,
  moveNote,
  movePoint,
  movePoints,
  pointShiftLimits,
  removeNote,
  removePoint,
  sortPoints,
  type Clip,
  type SongNote,
  type SongPoint,
} from '@lbptracker/lib/song.ts';
import {
  PITCHES,
  STEPS_PER_BAR,
  TRIPLET_THIRDS,
  ghostWindow,
  onGrid,
  gridUnit,
  isBlackKey,
  noteName,
  bestNoteWindow,
  pointLineHalf,
  pointRadius,
  positionLabel,
  rollPitchAt,
  rollSize,
  rollStepX,
  rollThirdsAt,
  rollX,
  rollY,
  segmentDistance,
  snapThirds,
  timbreColour,
  type RollLayout,
} from './geometry.ts';
import { SCALE_TABLES, quantise } from '@lbptracker/lib/scale.ts';
import { STEPS_PER_CELL } from '@lbptracker/cwlib/sequencer/project.ts';
import { capture, release } from './pointer.ts';
import type { EditorState } from './state.ts';

export interface RollCallbacks {
  /** The ruler was clicked: a step within the clip. */
  onSeek(stepInClip: number): void;
  /** A note was placed or clicked: play it. */
  onAudition(clip: Clip, note: SongNote): void;
  /** A key on the keyboard was pressed: play that pitch on the clip's instrument. */
  onAuditionPitch(clip: Clip, pitch: number): void;
  /** Something to say under the grid about what is under the pointer. */
  onHover(text: string): void;
  /** The clipboard was filled or emptied: nothing in the song changed, so no state change says so. */
  onClipboard?(): void;
}

/**
 * How far through the ghosts of the next chips are drawn.
 *
 * ⚠️ Measured on the canvas rather than guessed at: at 0.45 the bluest pixel
 * of a ghost came back (54,116,210) against the note blue's (66,140,255) --
 * an 18% difference, which reads as "a note" rather than "not yours". This is
 * the value where the two cannot be confused.
 */
const GHOST_ALPHA = 0.28;
/**
 * A note of the open clip that is off the grid being shown (a triplet under the
 * step grid, or the other way round): see-through too, but half way between a
 * note and a ghost, because it is still this clip's and still editable. The two
 * levels must not be confused -- at 0.3 this was the ghosts' 0.28 again.
 */
const OFF_GRID_ALPHA = 0.6;

const KEYS = 56;
const RULER = 20;
const STEP_W = 22;
const ROW_H = 13;
const HIT = 4;

/** What a plain click and drag on the grid does; `D`, `V` and `E` pick one. */
export type RollTool = 'draw' | 'select' | 'erase';

/** How far the grid zooms: pixels per step across, pixels per semitone down. */
const STEP_W_RANGE = [8, 64] as const;
const ROW_H_RANGE = [8, 32] as const;
/** The audition while a point is dragged is a note per row crossed; not faster than this. */
const DRAG_AUDITION_MS = 70;

type Drag =
  | { mode: 'create'; note: SongNote; startThirds: number; startPitch: number; lastPitch: number; extended: boolean }
  /**
   * Dragging the selected points. One mode, whether that is one point or fifty.
   * `origin` is the selection as it was when the drag began, drawn faint where
   * it came from so the distance travelled reads at a glance.
   */
  | {
    mode: 'move'; startThirds: number; startPitch: number; lastThirds: number; lastPitch: number;
    moved: boolean; origin: SongNote[];
  }
  | { mode: 'volume' | 'timbre'; startY: number; startValues: Map<string, number>; moved: boolean }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { mode: 'erase' };

export class RollView {
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly cb: RollCallbacks;
  private layout: RollLayout = {
    keys: KEYS, ruler: RULER, stepW: STEP_W, rowH: ROW_H, steps: 32, head: 0, tail: 0, triplets: false,
  };
  /**
   * What the row's other chips hold before and after this clip; see
   * `ghostWindow`.
   *
   * ⚠️ **Kept between frames rather than recomputed in `draw`.** A busy row of
   * `Ascetic` holds thousands of notes and the roll paints thirty times a
   * second while the song plays; this changes only when the song or the chip
   * does, which `state.version` counts.
   */
  private ghosts: { note: SongNote; shift: number }[] = [];
  private ghostKey = '';
  /** The open clip's row, the clip included: the ruler numbers each bar by the clip it is in. */
  private rowClips: Clip[] = [];
  private ghostHead = 0;
  private ghostTail = 0;
  private playStep: number | null = null;
  private drag: Drag | null = null;
  private hoverPitch: number | null = null;
  private heldKey: number | null = null;
  private frame = 0;
  private lastClipId: number | null = null;
  /** Notes copied with Ctrl+C, relative to their first position. */
  private clipboard: SongNote[] = [];
  /** Where they were lifted from, so a cut and a paste put them back. */
  private clipboardAt = 0;
  /** The pitch of the clipboard's earliest point: the one a paste puts under the pointer. */
  private clipboardPitch = 60;
  /** The grid position under the pointer (snapped), or null when it is not over the grid. */
  /** The pointer over the grid: `raw` is where it is, `thirds` where the grid's own snap puts it. */
  private cursor: { thirds: number; raw: number; pitch: number } | null = null;
  /** Shift and Alt as last seen, which lock the paste preview to one axis. */
  private mods = { shift: false, alt: false };
  private tool: RollTool = 'draw';
  /** What the pointer is doing, said beside it while a drag is under way: canvas coordinates. */
  private readout: { cx: number; cy: number; text: string } | null = null;
  private lastDragAudition = 0;

  constructor(
    canvas: HTMLCanvasElement,
    scroller: HTMLElement,
    spacer: HTMLElement,
    state: EditorState,
    cb: RollCallbacks,
  ) {
    this.canvas = canvas;
    this.scroller = scroller;
    this.spacer = spacer;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;
    this.cb = cb;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('dblclick', this.onDouble);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Not passive: Ctrl+wheel is the grid's zoom and must not become the page's.
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    const syncMods = (e: KeyboardEvent) => {
      if (e.shiftKey === this.mods.shift && e.altKey === this.mods.alt) return;
      this.mods = { shift: e.shiftKey, alt: e.altKey };
      if (this.clipboard.length) this.schedule();
    };
    window.addEventListener('keydown', syncMods);
    window.addEventListener('keyup', syncMods);
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerleave', () => {
      this.hoverPitch = null;
      this.cursor = null;
      this.cb.onHover('');
      this.schedule();
    });
    scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(scroller);
    state.onChange(() => {
      const clip = state.clip();
      if ((clip?.id ?? null) !== this.lastClipId) {
        this.lastClipId = clip?.id ?? null;
        // Every clip has its own roll. A clip the person opens is shown as `find the notes`
        // shows it; one the follow switched to opens at its start, the previous clip's last
        // bar in view, and is not searched: nothing but the person moves it after that.
        // ⚠️ The roll never scrolls itself to keep the playhead in view, and a view carried on
        // across the join (the old clip a ghost, the new one slid in) was built and dropped by
        // the owner: one clip, one roll, and its scrolling is the person's.
        const followed = state.followedNow;
        window.requestAnimationFrame(() => {
          if (!followed) {
            this.scrollToNotes();
            return;
          }
          this.measure();
          this.scroller.scrollLeft = this.startLeft();
        });
      }
      this.schedule();
    });
    this.schedule();
  }

  setPlayhead(stepInClip: number | null): void {
    if (this.playStep === stepInClip) return;
    this.playStep = stepInClip;
    this.schedule();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /**
   * Put the notes in view: **the window that holds the most of them**.
   *
   * ⚠️ Centring the pitch range is not the same thing and was what this did.
   * A clip whose bass sits at C1 and whose hats sit at C7 has a midpoint no
   * note is anywhere near, so "find the notes" landed on an empty band with
   * the music off both edges. `bestNoteWindow` counts what each scroll
   * position would actually show and takes the best, and it moves nothing when
   * a tie means the old centring was as good.
   */
  scrollToNotes(vertical = true, horizontal = true): void {
    const clip = this.state.clip();
    this.measure();
    const layout = this.layout;
    const viewH = this.scroller.clientHeight - layout.ruler;
    const viewW = this.scroller.clientWidth - layout.keys;
    if (!clip || !clip.notes.length) {
      // Nothing to find: middle C in the middle, as an empty grid always did.
      const middleC = Math.max(0, rollY(layout, 60) - this.scroller.clientHeight / 2);
      if (vertical) this.scroller.scrollTop = middleC;
      if (horizontal) this.scroller.scrollLeft = this.startLeft();
      return;
    }
    const boxes = clip.notes.map((n) => {
      let lo = 127;
      let hi = 0;
      let first = Infinity;
      let last = 0;
      for (const p of n.points) {
        lo = Math.min(lo, p.pitch);
        hi = Math.max(hi, p.pitch);
        first = Math.min(first, p.thirds);
        last = Math.max(last, p.thirds);
      }
      return {
        rowMin: PITCHES - 1 - hi,
        rowMax: PITCHES - 1 - lo,
        stepMin: Math.floor(first / 3),
        stepMax: Math.floor(last / 3),
      };
    });
    // Where the old rule would have gone, which is where a tie stays.
    const midPitch = boxes.reduce((m, b) => m + (b.rowMin + b.rowMax) / 2, 0) / boxes.length;
    const best = bestNoteWindow(
      boxes,
      {
        rows: Math.max(1, Math.floor(viewH / layout.rowH)),
        cols: Math.max(1, Math.floor(viewW / layout.stepW)),
        rowCount: PITCHES,
        stepCount: layout.steps,
      },
      {
        row: Math.max(0, Math.round(midPitch - viewH / layout.rowH / 2)),
        step: 0,
      },
    );
    if (vertical) this.scroller.scrollTop = Math.max(0, best.row * layout.rowH);
    // ❗ **`best.step` is in the clip's own steps**, and `stepCount` above was
    // its own `steps`: `find the notes` looks at this chip's notes and at
    // nothing in the lead-in or the tail.
    //
    // ⚠️ **Not the whole head added back, only all of it but a bar** (`startLeft`):
    // adding it all would park the previous clip's last bar off the left edge, and
    // that lead-in is the run-up an author wants to see.
    if (horizontal) this.scroller.scrollLeft = this.startLeft() + best.step * layout.stepW;
  }

  /** The other clips of a clip's row: what the grid draws through as ghosts. */
  private rowOthers(clip: Clip): Clip[] {
    return this.state.song.clips.filter((c) => c.row === clip.row && c.id !== clip.id);
  }

  /**
   * Where a clip's view starts: its own grid with the previous clip's last bar
   * before it. The head reaches back over the whole previous clip, and the rest
   * of it is there to be scrolled to.
   */
  private startLeft(): number {
    return Math.max(0, (this.layout.head - STEPS_PER_BAR) * this.layout.stepW);
  }

  /**
   * How far the grid reaches either side of the clip: back to the start of the
   * row's previous clip and on to the end of the next one, no further -- each
   * clip has its own roll, and its neighbours are what it joins.
   */
  private neighbourReach(clip: Clip, others: readonly Clip[]): { head: number; tail: number } {
    const start = clip.cell * STEPS_PER_CELL;
    const end = start + clip.steps;
    let before: number | undefined;
    let after: Clip | undefined;
    for (const c of others) {
      const s = c.cell * STEPS_PER_CELL;
      if (s < start && (before === undefined || s > before)) before = s;
      if (s > start && (!after || s < after.cell * STEPS_PER_CELL)) after = c;
    }
    const tail = after ? Math.max(0, after.cell * STEPS_PER_CELL + after.steps - end) : 0;
    return {
      head: before === undefined ? 0 : start - before,
      tail: Math.ceil(tail / STEPS_PER_BAR) * STEPS_PER_BAR,
    };
  }

  // ----------------------------------------------------------------- drawing

  private measure(): void {
    const clip = this.state.clip();
    // ❗ **Neither side exists unless something is in it.** An empty bar of
    // grid nobody can write in is scroll for nothing, and a row whose chips do
    // not reach past this one keeps the roll it always had.
    const key = `${clip?.id ?? 0}:${this.state.version.value}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      const others = clip ? this.rowOthers(clip) : [];
      const reach = clip ? this.neighbourReach(clip, others) : { head: 0, tail: 0 };
      const window_ = clip
        ? ghostWindow(clip, others, reach.head)
        : { ghosts: [], head: 0, tail: 0 };
      this.ghosts = window_.ghosts;
      this.rowClips = clip ? this.state.song.clips.filter((c) => c.row === clip.row) : [];
      this.ghostHead = window_.head;
      this.ghostTail = Math.min(window_.tail, reach.tail);
    }
    this.layout = {
      ...this.layout,
      steps: clip?.steps ?? 32,
      head: this.ghostHead,
      tail: this.ghostTail,
      triplets: this.state.triplets,
    };
    const full = rollSize(this.layout);
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    this.spacer.style.width = `${full.width}px`;
    this.spacer.style.height = `${Math.max(0, full.height - viewH)}px`;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(viewW * dpr) || this.canvas.height !== Math.round(viewH * dpr)) {
      this.canvas.width = Math.round(viewW * dpr);
      this.canvas.height = Math.round(viewH * dpr);
      this.canvas.style.width = `${viewW}px`;
      this.canvas.style.height = `${viewH}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * One chain's segments, as ribbons rather than strokes.
   *
   * The half-width at each end is that point's volume (`pointLineHalf`) and
   * the colour at each end that point's timbre, so a segment swells and
   * shifts hue exactly as the engine's gliding volume and modulation do
   * between the two -- the engine ramps the modulation as it ramps the volume
   * (steering/synth-engine.md, the slide rates at `+0x2c`).
   *
   * ❗ `px` is passed in rather than taken from the layout: the ghosts of the
   * next chips are the same picture shifted along, and drawing them any other
   * way would be a second copy of this.
   */
  private drawChain(
    pts: readonly SongPoint[],
    alpha: number,
    weight: number,
    px: (thirds: number) => number,
    py: (pitch: number) => number,
  ): void {
    const { ctx, layout } = this;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const ax = px(a.thirds);
      const ay = py(a.pitch);
      const bx = px(b.thirds);
      const by = py(b.pitch);
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      // The normal, to offset each end by its own half-width.
      const nx = (-dy / len) * weight;
      const ny = (dx / len) * weight;
      const ha = pointLineHalf(a.volume, layout.rowH);
      const hb = pointLineHalf(b.volume, layout.rowH);
      if (a.timbre === b.timbre) {
        ctx.fillStyle = timbreColour(a.timbre, alpha);
      } else {
        // Only the 3.9% of notes that automate the timbre pay for a gradient.
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, timbreColour(a.timbre, alpha));
        grad.addColorStop(1, timbreColour(b.timbre, alpha));
        ctx.fillStyle = grad;
      }
      ctx.beginPath();
      ctx.moveTo(ax + nx * ha, ay + ny * ha);
      ctx.lineTo(bx + nx * hb, by + ny * hb);
      ctx.lineTo(bx - nx * hb, by - ny * hb);
      ctx.lineTo(ax - nx * ha, ay - ny * ha);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Notes drawn see-through, for what a paste would put down and where a drag began. */
  private drawPreview(
    notes: readonly SongNote[],
    lineAlpha: number,
    dotAlpha: number,
    px: (thirds: number) => number,
    py: (pitch: number) => number,
  ): void {
    const { ctx, layout } = this;
    for (const note of notes) {
      this.drawChain(note.points, lineAlpha, 1, px, py);
      for (const p of note.points) {
        ctx.fillStyle = timbreColour(p.timbre, dotAlpha);
        ctx.beginPath();
        ctx.arc(px(p.thirds), py(p.pitch), pointRadius(p.volume, layout.rowH), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private draw(): void {
    this.measure();
    const { ctx, layout, state } = this;
    const clip = state.clip();
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    const sx = this.scroller.scrollLeft;
    const sy = this.scroller.scrollTop;
    const styles = getComputedStyle(this.canvas);
    const ink = styles.getPropertyValue('--ink').trim() || '#e8eaee';
    const dim = styles.getPropertyValue('--dimmer').trim() || '#6e7684';
    const accent = styles.getPropertyValue('--accent').trim() || '#6fd3a0';

    ctx.clearRect(0, 0, viewW, viewH);
    if (!clip) {
      ctx.fillStyle = dim;
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('select an instrument on the board to edit its notes', viewW / 2, viewH / 2);
      return;
    }

    // The visible pitch rows and step columns.
    const rowTop = Math.max(0, Math.floor((sy) / layout.rowH));
    const rowBottom = Math.min(PITCHES - 1, Math.ceil((sy + viewH) / layout.rowH));
    // ⚠️ In the CLIP's own steps, which are negative across the lead-in bar.
    const stepLeft = Math.max(-layout.head, Math.floor(sx / layout.stepW) - layout.head);
    const stepRight = Math.min(
      layout.steps + layout.tail,
      Math.ceil((sx + viewW) / layout.stepW) - layout.head,
    );

    // Row shading: black-key rows darker, as the game's grid does.
    // ❗ **And the clip's scale on top of it.** A note written off the scale does
    // not sound where it is drawn: the engine snaps it to the tone the scale's
    // table gives (`quantise`), so the rows that table leaves alone are lifted
    // and the rest darkened -- the grid says where a note will actually land.
    // The key transposes afterwards and does not move which rows are tones.
    const table = clip.scale > 0 ? SCALE_TABLES[clip.scale] : undefined;
    for (let row = rowTop; row <= rowBottom; row += 1) {
      const pitch = PITCHES - 1 - row;
      const y = layout.ruler + row * layout.rowH - sy;
      ctx.fillStyle = isBlackKey(pitch) ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.025)';
      ctx.fillRect(layout.keys, y, viewW - layout.keys, layout.rowH);
      if (table) {
        const within = pitch % 12;
        ctx.fillStyle = table[within] === within ? 'rgba(111,211,160,0.07)' : 'rgba(0,0,0,0.2)';
        ctx.fillRect(layout.keys, y, viewW - layout.keys, layout.rowH);
      }
      if (pitch % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.fillRect(layout.keys, y + layout.rowH - 1, viewW - layout.keys, 1);
      }
    }

    // The grid's lines: every beat firmer, every 8-step bar firm, and between
    // them the cells -- steps, or with the grid set to triplets the three
    // four-third cells of each beat, which is why that grid is sparser.
    ctx.lineWidth = 1;
    for (let step = stepLeft; step <= stepRight; step += 1) {
      const bar = step % STEPS_PER_BAR === 0;
      const beat = step % 4 === 0;
      if (bar || beat || !state.triplets) {
        const x = Math.round(rollStepX(layout, step) - sx) + 0.5;
        ctx.strokeStyle = bar ? 'rgba(255,255,255,0.28)' : beat ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(x, layout.ruler);
        ctx.lineTo(x, viewH);
        ctx.stroke();
      }
      if (state.triplets && beat && step < layout.steps) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        for (const cell of [1, 2]) {
          const tx = Math.round(rollStepX(layout, step + (cell * TRIPLET_THIRDS) / 3) - sx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(tx, layout.ruler);
          ctx.lineTo(tx, viewH);
          ctx.stroke();
        }
      }
    }
    // Outside the clip's own grid there is nothing to place a note on, and the
    // dark over it is what says so -- the ghosts below are drawn on top of it.
    const startX = rollStepX(layout, 0) - sx;
    const endX = rollStepX(layout, layout.steps) - sx;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (startX > layout.keys) {
      ctx.fillRect(layout.keys, layout.ruler, startX - layout.keys, viewH - layout.ruler);
    }
    if (endX < viewW) {
      ctx.fillRect(endX, layout.ruler, viewW - endX, viewH - layout.ruler);
    }

    // The notes: lines first so points sit on top.
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.keys, layout.ruler, viewW - layout.keys, viewH - layout.ruler);
    ctx.clip();
    const selected = state.selection.points;
    const sel = state.selection.point;
    const px = (t: number) => rollX(layout, t) - sx;
    const py = (p: number) => rollY(layout, p) - sy;
    /**
     * A note that is not on this grid's cells is drawn through: on the
     * triplet grid a note with a point off the four-third cells, on the
     * whole-step grid one with a point on a third. It is still there and
     * still editable, it is just not what this grid is for.
     */
    const dimmed = (note: SongNote) => !onGrid(note.points, state.triplets);
    for (const note of clip.notes) {
      // A line is lit when any of the note's points is in the selection; the
      // rings below say which ones, since the selection is of points.
      const on = selected.has(note.id);
      const pts = note.points;
      const fade = dimmed(note) ? OFF_GRID_ALPHA : 1;
      /**
       * A segment is drawn as a ribbon, not a stroke: its half-width at each
       * end is that point's volume (`pointLineHalf`) and its colour at each
       * end that point's timbre, so it swells and shifts hue exactly as the
       * engine's gliding volume and modulation do between the two -- the
       * engine ramps the modulation as it ramps the volume
       * (steering/synth-engine.md, the slide rates at `+0x2c`).
       */
      this.drawChain(pts, (on ? 1 : 0.8) * fade, on ? 1.35 : 1, px, py);
      // ⚠️ Nothing past the last point. The gate closes a step after it, but
      // the game draws no tail: a note's end IS its last point, and a note of
      // one record is one point. A faint tail drawn here read as a second
      // point that was not there, and the owner had it removed.
    }
    for (const note of clip.notes) {
      const chosen = selected.get(note.id);
      const fade = dimmed(note) ? OFF_GRID_ALPHA : 1;
      note.points.forEach((p, i) => {
        const r = pointRadius(p.volume, layout.rowH);
        const x = px(p.thirds);
        const y = py(p.pitch);
        ctx.fillStyle = timbreColour(p.timbre, fade);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (i === 0) {
          // The note-on carries a darker core so a chain reads left to right.
          ctx.fillStyle = `rgba(0,0,0,${0.35 * fade})`;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, r * 0.4), 0, Math.PI * 2);
          ctx.fill();
        }
        if (chosen?.has(i)) {
          const focused = sel && sel.noteId === note.id && sel.index === i;
          ctx.strokeStyle = focused ? accent : '#ffffff';
          ctx.lineWidth = focused ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    }
    // ❗ **The bar after the clip: what the row's other chips hold there.**
    // Drawn through, over the dark that says the region is not writable, and
    // clipped to it so nothing of theirs lands on this clip's own grid. They
    // are not in `clip.notes`, so nothing here can select or move them --
    // which is the whole point: the join between one chip and the next was
    // invisible while it is the thing an author is listening for.
    if (this.ghosts.length > 0) {
      ctx.save();
      // ❗ Two regions, and the clip's own grid is the hole between them: a
      // ghost whose chain crosses a boundary is cut at it, so nothing the
      // author cannot touch is ever drawn over the notes they are editing.
      ctx.beginPath();
      if (startX > layout.keys) {
        ctx.rect(layout.keys, layout.ruler, startX - layout.keys, viewH - layout.ruler);
      }
      if (endX < viewW) ctx.rect(endX, layout.ruler, viewW - endX, viewH - layout.ruler);
      ctx.clip();
      // The thirds on screen, so a row of thousands of notes costs a compare.
      const fromThirds = (stepLeft - 1) * 3;
      const toThirds = (stepRight + 1) * 3;
      for (const { note, shift } of this.ghosts) {
        const pts = note.points;
        if (pts[0].thirds + shift > toThirds) continue;
        if (pts[pts.length - 1].thirds + shift < fromThirds) continue;
        const gx = (t: number) => rollX(layout, t + shift) - sx;
        this.drawChain(pts, GHOST_ALPHA, 1, gx, py);
        for (const p of pts) {
          ctx.fillStyle = timbreColour(p.timbre, GHOST_ALPHA);
          ctx.beginPath();
          ctx.arc(gx(p.thirds), py(p.pitch), pointRadius(p.volume, layout.rowH), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // What Ctrl+V would put down, translucent, where the pointer is.
    const paste = this.pastePlan(clip);
    if (paste && !this.drag) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(startX, layout.keys), layout.ruler, Math.min(endX, viewW) - Math.max(startX, layout.keys), viewH - layout.ruler);
      ctx.clip();
      this.drawPreview(paste, 0.35, 0.4, px, py);
      ctx.restore();
    }
    // Where the points being dragged came from, faint: how far they have gone.
    if (this.drag?.mode === 'move' && this.drag.moved) {
      this.drawPreview(this.drag.origin, 0.22, 0.28, px, py);
    }
    // The marquee.
    if (this.drag?.mode === 'marquee') {
      const d = this.drag;
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(111,211,160,0.08)';
      ctx.lineWidth = 1;
      const x0 = Math.min(d.x0, d.x1) - sx;
      const y0 = Math.min(d.y0, d.y1) - sy;
      ctx.fillRect(x0, y0, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // The playhead.
    if (this.playStep !== null && this.playStep >= 0 && this.playStep <= layout.steps + layout.tail) {
      const x = rollStepX(layout, this.playStep) - sx;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, layout.ruler);
      ctx.lineTo(x, viewH);
      ctx.stroke();
    }
    // What the drag is at, beside the pointer: the number is where the eye is.
    if (this.readout) {
      const { cx, cy, text } = this.readout;
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width + 12;
      const x = cx + 16 + w > viewW - 4 ? cx - 16 - w : cx + 16;
      const y = cy - 30 < layout.ruler + 2 ? cy + 18 : cy - 30;
      ctx.fillStyle = 'rgba(15,18,24,0.92)';
      ctx.fillRect(x, y, w, 20);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 19);
      ctx.fillStyle = ink;
      ctx.fillText(text, x + 6, y + 10.5);
    }
    ctx.restore();

    // The keyboard, over the content, at the canvas's left edge.
    for (let row = rowTop; row <= rowBottom; row += 1) {
      const pitch = PITCHES - 1 - row;
      const y = layout.ruler + row * layout.rowH - sy;
      const black = isBlackKey(pitch);
      const held = this.heldKey === pitch;
      ctx.fillStyle = held ? accent : black ? '#1a1f26' : '#dfe4ea';
      ctx.fillRect(0, y, layout.keys - 1, layout.rowH - 1);
      if (pitch % 12 === 0 || this.hoverPitch === pitch) {
        ctx.fillStyle = black ? '#c8d0d8' : '#3a424c';
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(pitch), layout.keys - 5, y + layout.rowH / 2);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(layout.keys - 1, layout.ruler, 1, viewH);

    // The ruler, over the content, at the top edge: bars and beats.
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, viewW, layout.ruler);
    ctx.fillStyle = dim;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Each clip counts its own bars from 1: over a neighbour's ghost the numbers are the
    // neighbour's, so the ruler restarts where a clip does. The song's bar goes in front.
    const rowClips = this.rowClips;
    const origin = clip.cell * STEPS_PER_CELL;
    // From a beat line: the view can start anywhere, and a label off the beat read `2.2.75`.
    for (let step = Math.ceil(stepLeft / 4) * 4; step < stepRight; step += 4) {
      const x = rollStepX(layout, step) - sx;
      if (x < layout.keys) continue;
      const owner = rowClips.find((c) => c.cell * STEPS_PER_CELL <= origin + step && origin + step < c.cell * STEPS_PER_CELL + c.steps);
      const rel = owner ? origin + step - owner.cell * STEPS_PER_CELL : step;
      const bar = Math.floor(rel / STEPS_PER_BAR) + 1;
      const beat = ((((rel % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR) / 4) + 1;
      // A bar line carries both numbers: the song's bar, as the board counts it, then the clip's own.
      const songBar = Math.floor((origin + step) / STEPS_PER_BAR) + 1;
      ctx.fillStyle = beat === 1 ? ink : dim;
      ctx.fillText(beat === 1 ? `${songBar} · ${bar}` : `${bar}.${beat}`, x + 3, layout.ruler / 2);
    }
    ctx.fillStyle = '#171b21';
    ctx.fillRect(0, 0, layout.keys, layout.ruler);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, layout.ruler - 1, viewW, 1);
  }

  // ------------------------------------------------------------ hit testing

  /** Canvas coordinates to content coordinates. */
  private at(event: MouseEvent): { x: number; y: number; cx: number; cy: number } {
    const box = this.canvas.getBoundingClientRect();
    const cx = event.clientX - box.left;
    const cy = event.clientY - box.top;
    return { x: cx + this.scroller.scrollLeft, y: cy + this.scroller.scrollTop, cx, cy };
  }

  private hitPoint(clip: Clip, x: number, y: number): { note: SongNote; point: SongPoint; index: number } | null {
    // Topmost drawn last, so search backwards; selected notes first so a
    // point can be grabbed out from under an overlapping note.
    const order = [...clip.notes].sort((a, b) =>
      Number(this.state.selection.points.has(a.id)) - Number(this.state.selection.points.has(b.id)));
    for (let n = order.length - 1; n >= 0; n -= 1) {
      const note = order[n];
      for (let i = note.points.length - 1; i >= 0; i -= 1) {
        const p = note.points[i];
        const r = pointRadius(p.volume, this.layout.rowH) + HIT;
        if (Math.hypot(rollX(this.layout, p.thirds) - x, rollY(this.layout, p.pitch) - y) <= r) {
          return { note, point: p, index: i };
        }
      }
    }
    return null;
  }

  private hitLine(clip: Clip, x: number, y: number): { note: SongNote; segment: number } | null {
    for (let n = clip.notes.length - 1; n >= 0; n -= 1) {
      const note = clip.notes[n];
      const pts = note.points;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const d = segmentDistance(
          x, y,
          rollX(this.layout, pts[i].thirds), rollY(this.layout, pts[i].pitch),
          rollX(this.layout, pts[i + 1].thirds), rollY(this.layout, pts[i + 1].pitch),
        );
        if (d <= HIT + 1) return { note, segment: i };
      }
    }
    return null;
  }

  /**
   * **The points a rectangle catches**, as `[note id, index]` pairs.
   *
   * ⚠️ Points, not notes, and not the lines between them. A rectangle used to
   * take a whole note if any part of it was caught, which meant the tail of a
   * glide could not be grabbed without its head -- and shaping one end of a
   * held note against the other is most of what a chain of control points is
   * for. A rectangle drawn across the middle of a held note now catches
   * nothing, which is the honest answer: there is no point there.
   */
  private pointsInRect(
    clip: Clip,
    r: { x0: number; y0: number; x1: number; y1: number },
  ): [number, number][] {
    const x0 = Math.min(r.x0, r.x1);
    const x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    const out: [number, number][] = [];
    for (const note of clip.notes) {
      note.points.forEach((p, i) => {
        const px = rollX(this.layout, p.thirds);
        const py = rollY(this.layout, p.pitch);
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) out.push([note.id, i]);
      });
    }
    return out;
  }

  private snapped(x: number, steps: number): number {
    return snapThirds(rollThirdsAt(this.layout, x), this.state.triplets, steps);
  }

  // ----------------------------------------------------------------- pointer

  private onDown = (event: PointerEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    if (cy < this.layout.ruler) {
      if (cx >= this.layout.keys) this.cb.onSeek(rollThirdsAt(this.layout, x) / 3);
      return;
    }
    if (cx < this.layout.keys) {
      const pitch = rollPitchAt(this.layout, y);
      this.heldKey = pitch;
      this.cb.onAuditionPitch(clip, pitch);
      capture(this.canvas, event);
      this.schedule();
      return;
    }
    const state = this.state;
    const hitP = this.hitPoint(clip, x, y);
    if (event.button === 2) {
      if (hitP) {
        state.edit('notes', () => removePoint(clip, hitP.note, hitP.point));
        state.selectPoints([]);
      } else {
        const hitL = this.hitLine(clip, x, y);
        if (hitL) {
          state.edit('notes', () => removeNote(clip, hitL.note.id));
          state.selectPoints([]);
        }
      }
      return;
    }
    if (event.button !== 0) return;
    capture(this.canvas, event);
    if (this.tool === 'erase') {
      this.drag = { mode: 'erase' };
      this.eraseAt(clip, x, y);
      return;
    }
    if (hitP) {
      const { note, index } = hitP;
      const here = { noteId: note.id, index };
      if (event.ctrlKey || event.metaKey) {
        // Ctrl on a point puts that one point in or takes it out.
        const points = [...state.selection.points]
          .flatMap(([id, set]) => [...set].map((i) => [id, i] as [number, number]));
        const was = state.isSelected(note.id, index);
        state.selectPoints(was ? points.filter(([id, i]) => id !== note.id || i !== index)
                               : [...points, [note.id, index]],
                           was ? null : here);
        return;
      }
      // A point that is not in the selection becomes the selection; one that is
      // keeps it, so a set can be dragged by any of its dots.
      if (!state.isSelected(note.id, index)) state.selectPoints([[note.id, index]], here);
      else state.selectPoints([...state.selection.points]
        .flatMap(([id, set]) => [...set].map((i) => [id, i] as [number, number])), here);
      state.beginDrag();
      if (event.shiftKey || event.altKey) {
        // Volume and timbre take the whole selection, each point from its own
        // starting value, so a set keeps the shape it had.
        const startValues = new Map<string, number>();
        for (const { note: n, indices } of state.selectedPoints()) {
          for (const i of indices) startValues.set(`${n.id}:${i}`, event.shiftKey ? n.points[i].volume : n.points[i].timbre);
        }
        this.drag = { mode: event.shiftKey ? 'volume' : 'timbre', startY: y, startValues, moved: false };
      } else {
        const t = this.snapped(x, clip.steps);
        const p = rollPitchAt(this.layout, y);
        this.drag = {
          mode: 'move', startThirds: t, startPitch: p, lastThirds: t, lastPitch: p,
          moved: false, origin: this.snapshotSelection(),
        };
      }
      this.cb.onAudition(clip, note);
      return;
    }
    const hitL = this.hitLine(clip, x, y);
    if (hitL) {
      const { note } = hitL;
      // A line is the note as a whole: every one of its points.
      const all = note.points.map((_, i) => [note.id, i] as [number, number]);
      if (event.ctrlKey || event.metaKey) {
        const points = [...state.selection.points]
          .flatMap(([id, set]) => [...set].map((i) => [id, i] as [number, number]));
        state.selectPoints(state.isNoteSelected(note)
          ? points.filter(([id]) => id !== note.id)
          : [...points.filter(([id]) => id !== note.id), ...all]);
        return;
      }
      if (!state.isNoteSelected(note)) state.selectPoints(all);
      state.beginDrag();
      const t = this.snapped(x, clip.steps);
      const p = rollPitchAt(this.layout, y);
      this.drag = {
        mode: 'move', startThirds: t, startPitch: p, lastThirds: t, lastPitch: p,
        moved: false, origin: this.snapshotSelection(),
      };
      this.cb.onAudition(clip, note);
      return;
    }
    // The select tool takes a plain drag on empty grid for a rectangle, which
    // is what Shift does under the draw tool.
    if (event.shiftKey || this.tool === 'select') {
      this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, add: event.ctrlKey || event.metaKey };
      this.schedule();
      return;
    }
    // ❗ **Nothing past the clip's own grid.** `snapped` clamps to the last
    // step, so a click in the tail -- or in the empty canvas right of a short
    // grid, which was already possible -- used to draw a note at the end of
    // the clip, several bars from where the pointer was.
    const at = rollThirdsAt(this.layout, x);
    if (at < 0 || at >= clip.steps * 3) return;
    // Empty: a new note, one point, at the snapped position.
    const thirds = this.snapped(x, clip.steps);
    const pitch = rollPitchAt(this.layout, y);
    state.beginDrag();
    let created: SongNote | null = null;
    state.during((song) => {
      created = addNote(song, clip, { thirds, pitch });
    });
    const note = created!;
    state.selectPoints([[note.id, 0]], { noteId: note.id, index: 0 });
    this.drag = { mode: 'create', note, startThirds: thirds, startPitch: pitch, lastPitch: pitch, extended: false };
    this.cb.onAudition(clip, note);
  };

  private onMove = (event: PointerEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    const state = this.state;
    const drag = this.drag;
    if (!drag) {
      if (event.shiftKey !== this.mods.shift || event.altKey !== this.mods.alt) {
        this.mods = { shift: event.shiftKey, alt: event.altKey };
        if (this.clipboard.length) this.schedule();
      }
      this.trackCursor(clip, x, y, cx, cy);
      if (this.heldKey !== null) return;
      const pitch = cy >= this.layout.ruler ? rollPitchAt(this.layout, y) : null;
      if (pitch !== this.hoverPitch) {
        this.hoverPitch = pitch;
        this.schedule();
      }
      if (cx < this.layout.keys || cy < this.layout.ruler) {
        this.cb.onHover(pitch === null ? '' : noteName(pitch));
        return;
      }
      const hitP = this.hitPoint(clip, x, y);
      if (hitP) {
        const p = hitP.point;
        this.cb.onHover(
          `${noteName(p.pitch)} (${p.pitch}) at ${positionLabel(p.thirds)} · volume ${p.volume} · timbre ${p.timbre}` +
          ` · point ${hitP.index + 1} of ${hitP.note.points.length}`
          + (this.state.selectedCount > 1 && this.state.isSelected(hitP.note.id, hitP.index)
            ? `  ·  drag moves all ${this.state.selectedCount}` : ''),
        );
      } else {
        const t = this.snapped(x, clip.steps);
        const n = this.state.selectedCount;
        // An off-scale row plays as the tone the scale snaps it to.
        const snapsTo = pitch !== null && clip.scale > 0 ? quantise(pitch, clip.scale) : null;
        const scaleNote = snapsTo !== null && snapsTo !== pitch ? ` (plays as ${noteName(snapsTo)})` : '';
        // With something selected the line says what the keys will do to it:
        // the commands are otherwise only in the help.
        this.cb.onHover(n === 0
          ? `${noteName(pitch ?? 0)}${scaleNote} at ${positionLabel(t)}  ·  shift+drag selects points`
          : `${noteName(pitch ?? 0)}${scaleNote} at ${positionLabel(t)}  ·  ${n} point${n === 1 ? '' : 's'} selected`
            + '  ·  ctrl+D duplicate, ctrl+X cut, ctrl+C copy, ctrl+V paste, Delete removes');
      }
      return;
    }
    switch (drag.mode) {
      case 'create': {
        const thirds = this.snapped(x, clip.steps);
        const pitch = rollPitchAt(this.layout, y);
        if (!drag.extended && thirds === drag.startThirds && pitch === drag.startPitch) return;
        state.during(() => {
          if (!drag.extended) {
            addPoint(clip, drag.note, Math.max(drag.startThirds, thirds));
            drag.extended = true;
          }
          const end = drag.note.points[drag.note.points.length - 1];
          movePoint(clip, drag.note, end, { thirds: Math.max(drag.startThirds, thirds), pitch });
        });
        const end = drag.note.points[drag.note.points.length - 1];
        this.showReadout(cx, cy, `${noteName(end.pitch)} · ${positionLabel(end.thirds)}`);
        if (pitch !== drag.lastPitch) {
          drag.lastPitch = pitch;
          this.auditionDrag(clip, pitch);
        }
        break;
      }
      case 'move': {
        const thirds = this.snapped(x, clip.steps);
        const pitch = rollPitchAt(this.layout, y);
        const dt = thirds - drag.lastThirds;
        const dp = pitch - drag.lastPitch;
        if (dt === 0 && dp === 0) return;
        drag.moved = true;
        /**
         * The whole selection shifts by the same step, so it keeps its shape:
         * the delta each note *could* take is worked out first and the
         * smallest of them is what every note gets. Letting each note clamp
         * itself would slide a chord apart against the clip's edge.
         */
        const chosen = state.selectedPoints();
        let dtOk = dt;
        let dpOk = dp;
        for (const { note, indices } of chosen) {
          const limits = pointShiftLimits(clip, note, indices);
          dtOk = Math.max(limits.minThirds, Math.min(limits.maxThirds, dtOk));
          dpOk = Math.max(limits.minPitch, Math.min(limits.maxPitch, dpOk));
        }
        drag.lastThirds = thirds;
        drag.lastPitch = pitch;
        if (dtOk === 0 && dpOk === 0) break;
        state.during(() => {
          for (const { note, indices } of chosen) movePoints(clip, note, indices, dtOk, dpOk);
        });
        // The point under the pointer is the one the readout and the sound follow.
        const lead = state.point()?.point;
        if (lead) {
          const n = state.selectedCount;
          this.showReadout(cx, cy, `${noteName(lead.pitch)} · ${positionLabel(lead.thirds)}${n > 1 ? ` · ${n} points` : ''}`);
          if (dpOk !== 0) this.auditionDrag(clip, lead.pitch);
        }
        break;
      }
      case 'volume':
      case 'timbre': {
        const field = drag.mode;
        const step = field === 'volume' ? 2 : 8;
        const delta = Math.round((drag.startY - y) / step);
        let last = 0;
        state.during(() => {
          for (const { note, indices } of state.selectedPoints()) {
            for (const i of indices) {
              const from = drag.startValues.get(`${note.id}:${i}`);
              if (from === undefined) continue;
              movePoint(clip, note, note.points[i], { [field]: from + delta });
              last = note.points[i][field];
            }
          }
        });
        drag.moved = true;
        const n = state.selectedCount;
        this.cb.onHover(`${field} ${last}${n > 1 ? ` on ${n} points` : ''}`);
        this.showReadout(cx, cy, `${field} ${last}${field === 'timbre' ? ' / 15' : ''}${n > 1 ? ` · ${n} points` : ''}`);
        break;
      }
      case 'erase':
        this.eraseAt(clip, x, y);
        break;
      case 'marquee': {
        drag.x1 = x;
        drag.y1 = y;
        // The count comes from the same test the drop will use, so the hint
        // cannot say one thing and the selection do another.
        const n = this.pointsInRect(clip, drag).length;
        this.cb.onHover(`${n} point${n === 1 ? '' : 's'}${drag.add ? ' to add' : ''}`);
        this.schedule();
        break;
      }
    }
  };

  private onUp = (event: PointerEvent): void => {
    release(this.canvas, event);
    if (this.heldKey !== null) {
      this.heldKey = null;
      this.schedule();
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.readout = null;
    this.schedule();
    const state = this.state;
    const clip = state.clip();
    switch (drag.mode) {
      case 'erase':
        break;
      case 'create':
        state.endDrag('notes', true);
        break;

      case 'volume':
      case 'timbre':
        state.endDrag('notes', drag.moved);
        break;
      case 'move':
        if (drag.moved) for (const { note } of state.selectedPoints()) sortPoints(note);
        state.endDrag('notes', drag.moved);
        break;
      case 'marquee': {
        if (!clip) break;
        const caught = this.pointsInRect(clip, drag);
        // Ctrl held: the rectangle adds to what is already selected.
        const before: [number, number][] = drag.add
          ? [...state.selection.points].flatMap(([id, set]) => [...set].map((i) => [id, i] as [number, number]))
          : [];
        const last = caught[caught.length - 1];
        state.selectPoints([...before, ...caught],
          last ? { noteId: last[0], index: last[1] } : state.selection.point);
        break;
      }
    }
  };

  private onDouble = (event: MouseEvent): void => {
    const clip = this.state.clip();
    if (!clip) return;
    const { x, y, cx, cy } = this.at(event);
    if (cx < this.layout.keys || cy < this.layout.ruler) return;
    const hitP = this.hitPoint(clip, x, y);
    if (hitP) {
      this.state.edit('notes', () => removePoint(clip, hitP.note, hitP.point));
      this.state.selectNotes(clip.notes.includes(hitP.note) ? [hitP.note.id] : []);
      return;
    }
    const hitL = this.hitLine(clip, x, y);
    if (hitL) {
      const thirds = this.snapped(x, clip.steps);
      let index = 0;
      this.state.edit('notes', () => {
        const p = addPoint(clip, hitL.note, thirds);
        index = hitL.note.points.indexOf(p);
      });
      this.state.selectNotes([hitL.note.id], { noteId: hitL.note.id, index });
    }
  };

  // --------------------------------------------------------------- commands
  // The page's keyboard reaches these; they act on the selection.

  /**
   * Take the selected **points** away. A note whose last point goes with them
   * goes too (`removePoint` does that), so deleting every point of a note is
   * the same as deleting the note.
   */
  deleteSelection(): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip || state.selectedCount === 0) return;
    const chosen = state.selectedPoints();
    state.edit('notes', () => {
      for (const { note, indices } of chosen) {
        // Backwards, so an index still names the point it named before.
        for (const i of [...indices].sort((a, b) => b - a)) {
          const point = note.points[i];
          if (point) removePoint(clip, note, point);
        }
      }
    });
    state.selectPoints([]);
  }

  /** Move the selected points by a grid unit and/or a semitone, as one. */
  nudge(dSteps: number, dPitch: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip || state.selectedCount === 0) return;
    const dt = dSteps * gridUnit(state.triplets);
    const chosen = state.selectedPoints();
    // The smallest allowance decides, so the selection keeps its shape.
    let dtOk = dt;
    let dpOk = dPitch;
    for (const { note, indices } of chosen) {
      const limits = pointShiftLimits(clip, note, indices);
      dtOk = Math.max(limits.minThirds, Math.min(limits.maxThirds, dtOk));
      dpOk = Math.max(limits.minPitch, Math.min(limits.maxPitch, dpOk));
    }
    if (dtOk === 0 && dpOk === 0) return;
    state.edit('notes', () => {
      for (const { note, indices } of chosen) movePoints(clip, note, indices, dtOk, dpOk);
    }, 'nudge');
  }

  /** Volume or timbre of every selected point. */
  adjust(field: 'volume' | 'timbre', delta: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip || state.selectedCount === 0) return;
    const chosen = state.selectedPoints();
    state.edit('notes', () => {
      for (const { note, indices } of chosen) {
        for (const i of indices) {
          const p = note.points[i];
          if (p) movePoint(clip, note, p, { [field]: p[field] + delta });
        }
      }
    }, `adjust-${field}`);
  }

  /** Every point of every note in the chip. */
  selectAll(): void {
    const clip = this.state.clip();
    if (clip) this.state.selectNotes(clip.notes.map((n) => n.id));
  }

  /**
   * The selection as notes, relative to its earliest point.
   *
   * ⚠️ A note contributes **only its selected points**, so half a glide copies
   * as half a glide. Points of one note that are not next to each other still
   * come out as one note: they are what was selected, and a chain with a gap
   * in it is the same chain.
   */
  private lift(): SongNote[] {
    const chosen = this.state.selectedPoints();
    if (!chosen.length) return [];
    const first = Math.min(...chosen.map(({ note, indices }) => note.points[indices[0]].thirds));
    return chosen.map(({ note, indices }) => ({
      id: 0,
      points: indices.map((i) => ({ ...note.points[i], thirds: note.points[i].thirds - first })),
    }));
  }

  copy(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.keep(lifted);
  }

  /** Copy the selection and take it away, as one entry in the undo stack. */
  cut(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.keep(lifted);
    this.deleteSelection();
  }

  private keep(lifted: SongNote[]): void {
    this.clipboard = lifted;
    this.clipboardAt = this.selectionStart();
    const first = lifted.flatMap((n) => n.points).find((p) => p.thirds === 0);
    this.clipboardPitch = first?.pitch ?? 60;
    this.schedule();
    this.cb.onClipboard?.();
  }

  /** Follow the pointer over the grid, for the paste preview. */
  private trackCursor(clip: Clip, x: number, y: number, cx: number, cy: number): void {
    const over = cx >= this.layout.keys && cy >= this.layout.ruler
      && rollThirdsAt(this.layout, x) >= 0 && rollThirdsAt(this.layout, x) < clip.steps * 3;
    const next = over
      ? { thirds: this.snapped(x, clip.steps), raw: rollThirdsAt(this.layout, x), pitch: rollPitchAt(this.layout, y) }
      : null;
    const same = next === this.cursor
      || (next !== null && this.cursor !== null
        && next.thirds === this.cursor.thirds && next.pitch === this.cursor.pitch);
    if (same) return;
    this.cursor = next;
    if (this.clipboard.length) this.schedule();
  }

  /**
   * Which grid a paste snaps to. ⚠️ **The clipboard's own, not the one the roll is set to**: a
   * clip of whole-step notes put down on cells of four thirds lands off the step grid, and the
   * grid then draws them as triplets they never were. Notes all on the step grid paste on it,
   * notes all on the triplet grid on that, and anything else follows the roll's setting.
   */
  private pasteTriplets(): boolean {
    const at = this.clipboardAt;
    const all = this.clipboard.flatMap((n) => n.points.map((p) => p.thirds + at));
    if (all.length === 0) return this.state.triplets;
    if (all.every((t) => t % 3 === 0)) return false;
    if (all.every((t) => t % TRIPLET_THIRDS === 0)) return true;
    return this.state.triplets;
  }

  /** The clipboard as it would land at the pointer, or null when there is nothing to show. */
  private pastePlan(clip: Clip): SongNote[] | null {
    if (!this.cursor || !this.clipboard.length) return null;
    // Shift holds the pitch it was copied at and slides along the time; Alt
    // holds the time and slides along the pitch.
    const thirds = this.mods.alt
      ? this.clipboardAt
      : snapThirds(this.cursor.raw, this.pasteTriplets(), clip.steps);
    const pitch = this.mods.shift ? this.clipboardPitch : this.cursor.pitch;
    const dp = pitch - this.clipboardPitch;
    return this.clipboard.map((n) => ({
      id: 0,
      points: n.points.map((p) => ({
        ...p,
        thirds: Math.min(lastThirds(clip), p.thirds + thirds),
        pitch: Math.max(0, Math.min(127, p.pitch + dp)),
      })),
    }));
  }

  // ------------------------------------------------------------------ tools

  get currentTool(): RollTool {
    return this.tool;
  }

  setTool(tool: RollTool): void {
    this.tool = tool;
    this.canvas.style.cursor = tool === 'select' ? 'default' : tool === 'erase' ? 'not-allowed' : 'crosshair';
    this.schedule();
  }

  /** The selection as it stands, as notes with absolute positions. */
  private snapshotSelection(): SongNote[] {
    return this.state.selectedPoints().map(({ note, indices }) => ({
      id: 0,
      points: indices.map((i) => ({ ...note.points[i] })),
    }));
  }

  private showReadout(cx: number, cy: number, text: string): void {
    this.readout = { cx, cy, text };
    this.schedule();
  }

  /** Play the pitch a drag has just reached, not more often than a note a moment. */
  private auditionDrag(clip: Clip, pitch: number): void {
    const now = performance.now();
    if (now - this.lastDragAudition < DRAG_AUDITION_MS) return;
    this.lastDragAudition = now;
    this.cb.onAuditionPitch(clip, pitch);
  }

  /** The erase tool: the point under the pointer goes, or else the note whose line it is on. */
  private eraseAt(clip: Clip, x: number, y: number): void {
    const state = this.state;
    const hitP = this.hitPoint(clip, x, y);
    if (hitP) {
      state.edit('notes', () => removePoint(clip, hitP.note, hitP.point), 'erase');
      state.selectPoints([]);
      return;
    }
    const hitL = this.hitLine(clip, x, y);
    if (hitL) {
      state.edit('notes', () => removeNote(clip, hitL.note.id), 'erase');
      state.selectPoints([]);
    }
  }

  // -------------------------------------------------------------------- zoom

  private onWheel = (event: WheelEvent): void => {
    // Plain wheel scrolls as it always did. Ctrl zooms the time axis and Alt the
    // pitch axis, never both; a trackpad pinch arrives as Ctrl+wheel and lands
    // on the first.
    if (!event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    const factor = Math.exp(-(event.deltaY || event.deltaX) * 0.0015);
    const box = this.canvas.getBoundingClientRect();
    const pitch = event.altKey;
    this.zoom(pitch ? 1 : factor, pitch ? factor : 1, event.clientX - box.left, event.clientY - box.top);
  };

  /**
   * Scale the grid by `fx` across and `fy` down, keeping what is under
   * (`ax`, `ay`), in canvas pixels, where it is: the middle of the view when
   * no anchor is given.
   */
  zoom(fx: number, fy: number, ax?: number, ay?: number): void {
    const was = this.layout;
    const anchorX = ax ?? was.keys + (this.scroller.clientWidth - was.keys) / 2;
    const anchorY = ay ?? was.ruler + (this.scroller.clientHeight - was.ruler) / 2;
    const unitX = (anchorX + this.scroller.scrollLeft - was.keys) / was.stepW;
    const unitY = (anchorY + this.scroller.scrollTop - was.ruler) / was.rowH;
    const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));
    this.layout = {
      ...was,
      stepW: clamp(was.stepW * fx, STEP_W_RANGE),
      rowH: clamp(was.rowH * fy, ROW_H_RANGE),
    };
    // The spacer has to be the new size before the scroll position can land.
    this.measure();
    const now = this.layout;
    this.scroller.scrollLeft = Math.max(0, now.keys + unitX * now.stepW - anchorX);
    this.scroller.scrollTop = Math.max(0, now.ruler + unitY * now.rowH - anchorY);
    this.schedule();
  }

  /** The grid's own size again, as it opens. */
  resetZoom(): void {
    this.layout = { ...this.layout, stepW: STEP_W, rowH: ROW_H };
    this.measure();
    this.scrollToNotes();
    this.schedule();
  }

  // ------------------------------------------------------------ clipboard

  /** Forget what was copied, preview and all; false when there was nothing. */
  clearClipboard(): boolean {
    if (!this.clipboard.length) return false;
    this.clipboard = [];
    this.schedule();
    this.cb.onClipboard?.();
    return true;
  }

  /** Ctrl+V with the pointer over the grid: put the clipboard down where it is drawn. */
  pasteAtCursor(): boolean {
    const clip = this.state.clip();
    if (!clip || !this.clipboard.length || !this.cursor) return false;
    const plan = this.pastePlan(clip);
    if (!plan) return false;
    this.insert(plan, 0);
    return true;
  }

  /**
   * A copy of the selection, one step past its own end, selected in its place
   * so a second Ctrl+D goes on down the grid. It leaves the clipboard alone:
   * duplicating is not a reason to lose what was copied.
   */
  duplicateSelection(): void {
    const lifted = this.lift();
    if (!lifted.length) return;
    this.insert(lifted, this.afterSelection());
  }

  /** The earliest selected point, or 0 when nothing is selected. */
  private selectionStart(): number {
    const chosen = this.state.selectedPoints();
    return chosen.length
      ? Math.min(...chosen.map(({ note, indices }) => note.points[indices[0]].thirds))
      : 0;
  }

  /** One step past the last selected point, on a whole step. */
  private afterSelection(): number {
    const chosen = this.state.selectedPoints();
    const end = chosen.length
      ? Math.max(...chosen.map(({ note, indices }) => note.points[indices[indices.length - 1]].thirds))
      : -3;
    return Math.ceil((end + 3) / 3) * 3;
  }

  /** Put a lifted set of notes into the clip at a position, and select it. */
  private insert(notes: readonly SongNote[], atThirds: number): void {
    const state = this.state;
    const clip = state.clip();
    if (!clip) return;
    const ids: number[] = [];
    state.edit('notes', (song) => {
      for (const n of notes) {
        const note = addNote(song, clip, { thirds: 0, pitch: 0 });
        note.points = n.points.map((p) => ({
          ...p, thirds: Math.min(lastThirds(clip), p.thirds + atThirds),
        }));
        ids.push(note.id);
      }
    });
    state.selectNotes(ids);
  }

  /**
   * Paste at the playhead when it is in the clip, else one step past the
   * selection -- and with nothing selected, back where the clipboard was
   * lifted from, so a cut followed by a paste puts the notes back rather than
   * dropping them at the start of the grid.
   */
  paste(atThirds?: number): void {
    if (!this.state.clip() || !this.clipboard.length) return;
    const at = atThirds
      ?? (this.state.selectedCount ? this.afterSelection() : this.clipboardAt);
    this.insert(this.clipboard, at);
  }

  get hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }
}
