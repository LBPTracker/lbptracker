/**
 * The sequencer's step clock as `fmodextinput.prx` runs it: where a note
 * starts, where its gate closes and where the walk takes a record, in frames.
 *
 * ❗ **The render's and the live player's clock since 2026-10-12** (*3 / 3b*
 * in steering/answered-questions.md): `RenderOptions.engineClock`, on by
 * default, places every voice on it, and the player runs it under its
 * transport (`placeOnClock` in `engine-place.ts`). Off, the tracker places
 * onsets and gates on their own frame, kept for an A/B. It was
 * measured, not only read: run through `tools/prxrun.py`, the module starts a
 * note on step 2 of a 180 bpm song at frame 8,192 where the step falls at
 * 8,000, and one on step 0 at 256.
 *
 * The clock, transcribed in float32 from `0x0ba0`-`0x0c4c`:
 *
 * ```
 * L   = 720000 / tempo                         ; frames per step (v0x44b4)
 * L'  = L + L * swing * 0.5 * (floor(p) even ? 1 : -1)   ; v0x44b8, v0x44f0
 * N   = min(trunc((1 - frac(4p)) * L' + 1), left in the block)
 * p  += N / L'
 * ```
 *
 * in blocks of 256 frames (`0xa90`, `mov esi, 0x100`), whatever FMOD asks
 * for. `N` is meant to stop a chunk at the next quarter step and does not --
 * it multiplies where it should divide -- so a block is split only when `p` is
 * within `256 / L'` quarter steps of a boundary. After each chunk, which
 * renders every record first (`0x0c84`), the walk runs if `floor(p)` changed
 * (`0x0e8d`), so:
 *
 * - **the walk for step `s`** is at the end of the chunk that took `p` to
 *   `s` or past it; for the step a song starts on, at the end of its first
 *   chunk (the restart, `0x1a48`);
 * - **a note at `s + k/3`** is first rendered at the top of the first chunk
 *   after that walk whose end passes `k/3` into the step (`0x1c9b`-`0x1cb9`;
 *   the in-chunk offset `0x1cc6` computes is always 0) -- `k = 0` is the next
 *   chunk, a sub-step is up to a chunk early;
 * - **a gate due at `g`** closes at the walk for `floor(g)` (`0x3a4b`), or for
 *   a sub-step end, after the first chunk past it whose end passes `frac(g)`
 *   (`0x2988`-`0x29b1`); the record reads it at the next chunk's top
 *   (`0x1f65`).
 */

/** What a render needs from the clock, in frames from the clock's start. */
export interface EngineClock {
  /** The end of the chunk whose walk takes the records of whole step `step`. */
  walkFrame(step: number): number;
  /** The first frame rendered for a note at `position` (`step + subStep / 3`). */
  onsetFrame(position: number): number;
  /** The first frame rendered with the gate closed, for a gate due at `position`. */
  gateFrame(position: number): number;
  /**
   * The frame at which the playhead passes `position`, inside the chunk it
   * falls in -- where a slide, linear in `p`, has reached that position.
   */
  frameAt(position: number): number;
  /**
   * The first whole step whose walk finds free a record the renderer gives
   * back after the chunk holding `frame` (`0x3093`, at the end of `0x1c60`).
   * The walk of step `k` runs after the first chunk whose end reaches `k`, so
   * it finds the record free exactly when that chunk began before `k`.
   */
  freedBy(frame: number): number;
  /**
   * Every chunk start that is not a block's: where `N` cut a block short. A
   * record's ramps are evaluated per chunk, so a voice on this clock ends its
   * segments here too (`VoiceSpec.engineGrid`).
   */
  readonly splits: readonly number[];
  /** Every chunk and the float32 playhead at its ends: see {@link EngineChunks}. */
  readonly chunks: EngineChunks;
  /**
   * `splits` and `chunks` between two frames: what one voice living there
   * needs, for a caller that posts it across a thread. The chunks run from the
   * one holding `from` to the first starting at or past `to`; a voice that
   * outlives them reads the last one's playhead on along it, and segments on
   * the block grid, which only a long release's last splits would notice.
   */
  window(from: number, to: number): { readonly splits: readonly number[]; readonly chunks: EngineChunks };
}

/**
 * The clock's chunks, for a voice that evaluates its slides the engine's way
 * (`EngineRecord` in `audio/mixer.ts`): chunk `c` runs from `starts[c]` to
 * `starts[c + 1]`, and the playhead the module holds is `playheads[c]` at its
 * top and `playheads[c + 1]` at its end -- one entry more than there are
 * chunks. ❗ The playhead is the float32 one: it is what `0x0c35`/`0x0c48` take
 * the fraction of for every record's ramps, and at step 141 it advances 6.7e-5
 * slower than `N / L` would.
 */
export interface EngineChunks {
  readonly starts: Float64Array;
  readonly playheads: Float32Array;
}

const BLOCK = 256;
const THIRD = Math.fround(1 / 3);
const f = Math.fround;

/**
 * Run the clock from `start` (in steps) for `frames` frames.
 *
 * `swing` is clamped as the eboot clamps it before the module sees it.
 */
export function engineClock(tempo: number, swing: number, frames: number, start = 0): EngineClock {
  const t = f(tempo);
  const s = f(Math.min(swing, 0.99));
  const L = f(720000 / t);
  const half = f(f(L * s) * 0.5);
  // One row per chunk: its first frame, its end, and the playhead at both ends.
  const chunkStart: number[] = [];
  const chunkEnd: number[] = [];
  const pStart: number[] = [];
  const pEnd: number[] = [];
  const lengths: number[] = [];
  let p = f(start);
  let frame = 0;
  const limit = frames + 4 * BLOCK;
  while (frame < limit) {
    let left = BLOCK;
    while (left > 0) {
      const lp = f(L + f(half * ((Math.trunc(Math.floor(p)) & 1) === 0 ? 1 : -1)));
      const q = f(p * 4);
      const toQuarter = f(f(f(Math.floor(q) - q) + 1) * lp);
      const n = Math.min(Math.trunc(f(toQuarter + 1)), left);
      const next = f(p + f(n / lp));
      chunkStart.push(frame);
      chunkEnd.push(frame + n);
      pStart.push(p);
      pEnd.push(next);
      lengths.push(lp);
      p = next;
      frame += n;
      left -= n;
    }
  }
  const count = chunkStart.length;
  const splits = chunkStart.filter((at) => at % BLOCK !== 0);
  const starts = new Float64Array(count + 1);
  const playheads = new Float32Array(count + 1);
  starts.set(chunkStart);
  playheads.set(pStart);
  starts[count] = frame;
  playheads[count] = p;
  // The first chunk whose end playhead is at least `x` -- monotonic, so a bisection.
  const firstEndingAtOrPast = (x: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pEnd[mid] >= x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const walkChunk = (step: number): number =>
    step <= Math.floor(f(start)) ? 0 : firstEndingAtOrPast(step);
  // Whether a chunk's end has passed `offset` into the step it started in,
  // as `0x1c9b` compares them: the end's fraction, plus one when it wrapped.
  const passes = (c: number, offset: number): boolean => {
    const a = f(pStart[c] - Math.floor(pStart[c]));
    let b = f(pEnd[c] - Math.floor(pEnd[c]));
    if (b < a) b = f(b + 1);
    return b > offset;
  };
  const subOffset = (position: number): number => {
    const k = Math.round((position - Math.floor(position)) * 3);
    return f(k * THIRD);
  };
  // The last chunk starting at or before `frame`.
  const chunkHolding = (frame: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunkStart[mid] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    splits,
    chunks: { starts, playheads },
    window(from, to) {
      const a = chunkHolding(from);
      let b = chunkHolding(to);
      if (b < count && chunkStart[b] < to) b += 1;
      if (b <= a) b = Math.min(count, a + 1);
      return {
        splits: splits.filter((at) => at >= from && at < to),
        chunks: { starts: starts.slice(a, b + 1), playheads: playheads.slice(a, b + 1) },
      };
    },
    walkFrame(step) {
      return chunkEnd[walkChunk(Math.floor(step))];
    },
    onsetFrame(position) {
      const offset = subOffset(position);
      let c = walkChunk(Math.floor(position)) + 1;
      while (c < count - 1 && offset > 0 && !passes(c, offset)) c += 1;
      return chunkStart[Math.min(c, count - 1)];
    },
    gateFrame(position) {
      const offset = subOffset(position);
      const w = walkChunk(Math.floor(position));
      if (offset === 0) return chunkEnd[w];
      let c = w + 1;
      while (c < count - 1 && !passes(c, offset)) c += 1;
      return chunkEnd[Math.min(c, count - 1)];
    },
    frameAt(position) {
      const c = firstEndingAtOrPast(position);
      return chunkStart[c] + (position - pStart[c]) * lengths[c];
    },
    freedBy(frame) {
      return Math.floor(pStart[chunkHolding(frame)]) + 1;
    },
  };
}
