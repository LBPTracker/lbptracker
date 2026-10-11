/**
 * A record's own float32 arithmetic, as `fmodextinput.prx` does it: what the
 * note walk `0x3930` writes into the record at every step, and what the stack
 * loop `0x1a70` and the renderer `0x1c60` make of it -- the pitch ratio, the
 * detune, the LFO phases and every layer's rate.
 *
 * For `RenderOptions.engineClock` (`EngineRecord` in `audio/mixer.ts`). Two
 * things on that clock need it, both measured against the module running
 * (`tools/prxsynth.py`, 2026-10-11):
 *
 * - **A layer's rate is a float32 widened to double** (`0x27c5`, `0x285e`) and
 *   only stepped in double. On a held note every chunk rounds the same way, so
 *   the error is a drift, not a noise: `mosquito` held four seconds at 240 bpm
 *   ran 0.0056 frames ahead of the module in double and lands on its position
 *   to 1e-5 frames here, and the song (281831) was the worst of sixteen.
 * - **A slide is read off the float32 playhead**: `t` is `frac(p)` at the
 *   chunk's two ends (`0x0c35`, `0x0c48`, `0x1ce7`-`0x1d03`), less the spawn's
 *   sub-step until the first walk -- not the frames since the record. On
 *   `Vision`'s two-octave glides the two differ by 2e-6 steps, a rate error of
 *   3e-6 that drifted the phase to -40 dB of the clip's loudest window.
 *
 * Every constant is the module's own word, read by address.
 */

const f = Math.fround;
const word = (u: number): number => new Float32Array(new Uint32Array([u]).buffer)[0];

/** `v0x4558`, `v0x45ac`: a third, as the sub-step and the span read it. */
export const THIRD32 = word(0x3eaaaaab);
/** `v0x45b0`: the catch-up's negative third (`0x3ecd`). */
const NEG_THIRD32 = word(0xbeaaaaab);
/** `v0x455c`: the pitch formula's twelfth (`0x1db7`). */
const TWELFTH32 = word(0x3daaaaab);
/** `v0x45a0`: velocity over 127 (`0x3c32`, `0x3d9a`). */
const VELOCITY32 = word(0x3c010204);
/** `v0x45a4`: the modulation nibble over 15 (`0x3c79`, `0x3de5`). */
const MODULATION32 = word(0x3d888889);
/** `v0x4540`: `rand()` to U(0, 1) (`0x1aee`). */
const RAND32 = word(0x30800000);
/** `v0x4550`: `rand()` to a phase, 2π / 2^30 (`0x1bfa`). */
const PHASE32 = word(0x31c90fdb);
/** `v0x4544`, `v0x4580`: the detune's and LFO 1's 0.05 (`0x1b59`, `0x2780`). */
const TWENTIETH32 = word(0x3d4ccccd);
/** `v0x4574`: 2π, the layer fan (`0x2301`). */
const TWO_PI32 = word(0x40c90fdb);
/** `v0x4568`: seconds per frame, the LFO increment's (`0x20ce`). */
const FRAME_SECONDS32 = word(0x37aec33e);
/**
 * The three LFO rates' scales: `v0x456c` for the first two (`0x2267`, reused
 * at `0x229b`), `v0x4570` for the third (`0x22c7`).
 */
const LFO_SCALE32 = [100, 100, 50] as const;

/** One `Params` range, as the instrument record holds it: two float32s. */
export interface Param32 {
  readonly x: number;
  readonly y: number;
}

/**
 * `x + mod · (y − x)`, the shape of all 60 reads (`0x1ab9`-`0x1ac3` and every
 * other): `y − x` first, then times the modulation, then plus `x`.
 */
export function param32(p: Param32 | undefined, mod: number): number {
  if (p === undefined) return 0;
  return f(p.x + f(mod * f(p.y - p.x)));
}

/** `+0x28` from a record's nibble: `(float)nibble · (1/15)` (`0x3c71`-`0x3c79`). */
export function modulation32(nibble: number): number {
  return f(nibble * MODULATION32);
}

/** U(0, 1) as `0x1ae6`-`0x1af6` forms it from one draw in [0, 1). */
export function unit32(draw: number): number {
  return f(f(draw * 2 ** 30) * RAND32);
}

/** An LFO's phase at the spawn, `0x1bf2`-`0x1c3e`, from one draw in [0, 1). */
export function phase32(draw: number): number {
  return f(f(draw * 2 ** 30) * PHASE32);
}

/**
 * A layer's detune, `+0x68 + 4i`: `1 + 0.05 · (u · 2r − r)` in the module's
 * order (`0x1b0e`-`0x1b61`), `r` being `Params[0]` at the spawn's modulation.
 */
export function detune32(r: number, u: number): number {
  return f(f(f(f(u * f(r + r)) - r) * TWENTIETH32) + 1);
}

/** The slot the record plays, as `0x1d71`-`0x1e1f` read it. */
export interface PitchSlot {
  /** `slot + 0x8c`, in semitones. */
  readonly fineTune: number;
  /** `slot + 0x84`, the root note -- an integer, converted at `0x1daa`. */
  readonly root: number;
  /** `slot + 0x90`. Unpitched, the ratio is exactly 1 whatever the slide. */
  readonly pitched: boolean;
  /** `tempo / slot + 0x88`, float32, when `slot + 0x91` syncs it; else undefined. */
  readonly tempoRatio?: number;
}

/**
 * The record's playback ratio at one end of a chunk, from `+0x08 + t · +0x30`
 * already summed (`0x1d8c`-`0x1d99`): `exp2f(((pitch + fine) − root) / 12)`,
 * times the tempo ratio when the slot is synced.
 *
 * `exp2f` is the console's own (`libc.prx`, stub `0x150`); `fround(2 ** x)`
 * agrees with it on 19,988 of 20,000 random arguments in [−6, 6] and is one
 * ulp off on the rest (`tools/prxrun.py`, 2026-10-11).
 */
export function ratio32(slot: PitchSlot, pitch: number): number {
  let ratio = 1;
  if (slot.pitched) ratio = f(2 ** f(f(f(pitch + slot.fineTune) - slot.root) * TWELFTH32));
  return slot.tempoRatio === undefined ? ratio : f(ratio * slot.tempoRatio);
}

/** `sinf` as the module calls it, `_FSin(x, 0)` (stub `0x130`): 19,993 of 20,000 agree. */
export function sin32(x: number): number {
  return f(Math.sin(x));
}

/** `+0x08` and the other two, then their slides, as one walk leaves them. */
export interface EngineWalk {
  /** The voice frame this walk's values hold from: 0 for the spawn, then each walk's chunk end. */
  readonly frame: number;
  readonly pitch: number;
  readonly pitchSlide: number;
  readonly gain: number;
  readonly gainSlide: number;
  readonly mod: number;
  readonly modSlide: number;
}

/** One record of a note's chain, in the clip's own units and in the clip's order. */
export interface WalkPoint {
  /** The record's step within its clip, 0..127 -- the walk compares it with an integer. */
  readonly step: number;
  /** 0, 1 or 2. */
  readonly subStep: number;
  /** `quantise(note, scale) + root − 12`, the integer `0x3c57` converts. */
  readonly pitch: number;
  /** Bits 16..23. */
  readonly velocity: number;
  /** Bits 24..27. */
  readonly nibble: number;
}

/**
 * `0x3930` for one note, from the spawn to the walk that closes its gate: what
 * it writes to `+0x08`/`+0x0c`/`+0x28` and their slides `+0x30`/`+0x2c`/
 * `+0x34`, all float32. `firstWalk` is the step, in the clip's own count, of
 * the walk after the spawn; the result has the spawn first and one row per
 * walk after it, `frame` left for the caller (0 here).
 *
 * ```
 * 0x3a41  if walk > rec[cursor].step:              ; the integer step
 * 0x3a46    if rec[cursor] ends the note: close the gate   ; and still write
 *           else cursor += 1                       ; one record per walk
 * 0x3c1c  cur = walk < rec[cursor].step && cursor > 0 ? cursor − 1 : cursor
 * 0x3c3a  gain = vel/127 ; 0x3c63 pitch = (float)pitch ; 0x3c81 mod = nibble/15
 * 0x3d25  if rec[cur] ends, or no later record follows: slides = 0 (0x3f06)
 * 0x3e50  inv = 1 / (pos(next) − pos(cur))         ; pos = step + sub · ⅓, float32
 * 0x3e66  slide = inv · (next − this), for each of the three
 * 0x3e9b  if rec[cur].step < walk <= rec[next].step:
 * 0x3ed9    e = walk + (sub · −⅓ − step)           ; caught up to the whole step
 *           value += e · slide
 * ```
 *
 * The spawn is the same walk on the note's own step, which advances nothing
 * and catches nothing up. ⚠️ The steps must be the clip's own: the catch-up's
 * `sub · −⅓ − step` rounds differently at step 141 than at the same record's clip step, 29.
 */
export function engineWalks(points: readonly WalkPoint[], firstWalk: number): EngineWalk[] {
  const n = points.length;
  if (n === 0) return [];
  const last = n - 1;
  const position = (p: WalkPoint) => f(p.step + f(p.subStep * THIRD32));
  const state = (cur: number, walk: number): EngineWalk => {
    const a = points[cur];
    let gain = f(a.velocity * VELOCITY32);
    let pitch = a.pitch;
    let mod = modulation32(a.nibble);
    const b = points[cur + 1];
    if (cur === last || b === undefined || b.step * 4 + b.subStep <= a.step * 4 + a.subStep) {
      return { frame: 0, pitch, pitchSlide: 0, gain, gainSlide: 0, mod, modSlide: 0 };
    }
    const inv = f(1 / f(position(b) - position(a)));
    const gainSlide = f(inv * f(f(b.velocity * VELOCITY32) - gain));
    const pitchSlide = f(inv * f(b.pitch - pitch));
    const modSlide = f(inv * f(modulation32(b.nibble) - mod));
    if (walk > a.step && walk <= b.step) {
      const e = f(walk + f(f(a.subStep * NEG_THIRD32) - a.step));
      gain = f(gain + f(e * gainSlide));
      pitch = f(pitch + f(e * pitchSlide));
      mod = f(mod + f(e * modSlide));
    }
    return { frame: 0, pitch, pitchSlide, gain, gainSlide, mod, modSlide };
  };
  const out = [state(0, firstWalk - 1)];
  let cursor = 0;
  for (let walk = firstWalk; ; walk += 1) {
    let closes = false;
    if (walk > points[cursor].step) {
      if (cursor === last) closes = true;
      else cursor += 1;
    }
    const cur = cursor > 0 && walk < points[cursor].step ? cursor - 1 : cursor;
    out.push(state(cur, walk));
    if (closes) return out;
  }
}

/**
 * The whole step of the walk that closes a note's gate, from its records'
 * steps in the chain's order. One walk moves the cursor at most one record
 * (`0x3a41`-`0x3a6a`), and only a walk past the last record's step that finds
 * the cursor already on it closes the gate (`0x3a46`-`0x3a4b`): record `i` is
 * reached at `w(i) = max(w(i − 1), step(i − 1)) + 1` from the spawn's step,
 * and the gate closes at `max(w(last), step(last)) + 1`. That is the step after
 * the last record's unless records bunch inside a step: at 6, 6⅓, 6⅔ and 8 the
 * cursor reaches the end at walk 9 and the module closes at walk 10, not 9
 * (`gsub` in `prx-scene.ts`, 2026-10-11).
 */
export function closingWalk(steps: readonly number[]): number {
  let walk = steps[0];
  for (let i = 1; i < steps.length; i += 1) walk = Math.max(walk, steps[i - 1]) + 1;
  return Math.max(walk, steps[steps.length - 1]) + 1;
}

/**
 * The three LFOs' per-chunk constants, from the chunk's start modulation
 * (`0x2247`-`0x236d`): each phase's increment over `frames`, and the fan
 * between two layers. `params` is the instrument's whole `Params` array.
 */
export function lfoStep32(
  params: readonly (Param32 | undefined)[],
  mod: number,
  frames: number,
  layers: number,
  out: { inc: Float32Array; fan: Float32Array },
): void {
  const seconds = f(frames * FRAME_SECONDS32);
  const stack = f(layers);
  for (let n = 0; n < 3; n += 1) {
    out.inc[n] = f(f(seconds * param32(params[15 + 3 * n], mod)) * LFO_SCALE32[n]);
    out.fan[n] = f(f(param32(params[17 + 3 * n], mod) * TWO_PI32) / stack);
  }
}

/**
 * One layer's rate at one end of a chunk, `0x2755`-`0x27c1`: the ratio times
 * the detune plus LFO 1, `depth` being `Params[16]` at that end's modulation.
 */
export function layerRate32(ratio: number, detune: number, depthParam: number, phase: number): number {
  const depth = f(depthParam * TWENTIETH32);
  return f(ratio * f(detune + f(sin32(phase) * depth)));
}
