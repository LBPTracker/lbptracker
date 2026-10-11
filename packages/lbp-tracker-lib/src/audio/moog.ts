/**
 * The sequencer's filter: a 4-pole Moog ladder low-pass.
 *
 * Reproduced from `0x3070`-`0x3259` in `fmodextinput.prx`, which is the
 * Stilson/Smith approximation published on musicdsp.org as "Moog VCF,
 * variation 1" -- constant for constant, including the `5.6` in the resonance
 * compensation and the `b4 - b4³/6` cubic saturation. See
 * steering/synth-engine.md, *The filter*.
 *
 * This is what `Params[3..10]` are for, and what the ten floats at voice record
 * `+0xa4` … `+0xc8` were: two ladders of five states each, one per channel.
 *
 * ⚠️ **The saturation makes this non-linear, so it is not a filter you can swap
 * for "a low-pass".** Driving it hard is part of the sound of every synth patch
 * the game ships. Keep the cube.
 *
 * ⚠️ **Its input domain is `[-1, +1]`, and past about ±1.4 it runs away to
 * NaN.** That is a property of the approximation, not a bug in the
 * transcription -- the reference documents the same domain and the engine
 * carries the same cube. What keeps the engine inside it is a hard clip:
 * `0x2e00`-`0x2e2d` clamps the record's summed layers to ±1 before the two
 * ladders see them, and `Voice` in `mixer.ts` does the same. The boundary is
 * pinned in packages/lbp-tracker-lib/test/moog.test.ts. Do not add a clamp
 * *inside* the ladder, which the engine does not have.
 *
 * ❗ **The module computes all of it in float32, and there are two ladders
 * here.** `MoogLadder32` and `ladderCoefficients32Into` are the module's
 * arithmetic, rounded where it rounds and in its order; `Voice` runs them on
 * the engine's clock (`VoiceSpec.engine`). `MoogLadder` and
 * `ladderCoefficientsInto` are the same formula in double, which the default
 * clock keeps. Why each, and what it costs: *The filter* in
 * steering/synth-engine.md.
 */

import type { Param32 } from '../engine-record.ts';
import { param32 } from '../engine-record.ts';

const f = Math.fround;

/** `v0x4630`, `v0x4650`, `v0x4660`: the reference's decimal constants, as the module holds them. */
const P_SCALE = f(0.8);
const COMPENSATION = f(5.6);
const SATURATION = f(0.166667);

/** The two coefficients the ladder actually runs on. */
export interface LadderCoefficients {
  /** `p` in the reference: the per-stage gain. */
  readonly p: number;
  /** `f` in the reference: the per-stage feedback. */
  readonly f: number;
  /** The resonance feedback around all four stages. */
  readonly q: number;
}

/** What `Voice` needs of either ladder. */
export interface Ladder {
  process(input: number, coefficients: LadderCoefficients): number;
  reset(): void;
}

/**
 * The cutoff above which the engine does not run the ladder at all.
 *
 * `0x2ea9` compares the clamped cutoff against **0.99** and `0x2ed7` branches on
 * it. The fall-through path is a self-contained loop at `0x2f00`-`0x2f9b` that
 * touches **none** of the ladder's constants -- no `0.8`, no `5.6`, no `1/6` --
 * so it is the unfiltered path, and it is the one taken when the cutoff is
 * above the threshold. A wide-open lowpass is skipped rather than computed.
 *
 * That the compared value is the cutoff is not inferred from the shape: `xmm9`
 * receives `freq` at `0x2a32` and is not written again before `0x2aa9` clamps it
 * into the slot the comparison reads.
 *
 * ⚠️ **This is not a micro-optimisation, it is audible.** This ladder at
 * `freq = 1` is not transparent: a unit impulse comes out at 0.833 and it still
 * rings after half a second. `keys/piano.rinst` has a cutoff of exactly 1.0 at
 * both ends of its range, so every one of its notes was being coloured by a
 * filter the engine never runs.
 *
 * The constant is `0.99f` (`v0x4620`), a hair above 0.99. The comparison is
 * `0.99f < freqStart && 0 <= freqEnd` (`0x2ea1`-`0x2ebf`); the second half is
 * always true of a clamped cutoff, so the block's start alone decides.
 */
export const FILTER_BYPASS_CUTOFF = f(0.99);

/**
 * Coefficients for a normalised cutoff and resonance, both `0..1`, in double.
 *
 * `freq` is **not** a frequency in Hz. It is the engine's normalised value, and
 * the engine never converts it to one -- the cutoff is whatever this
 * approximation gives at that number and at the output sample rate, which is
 * part of why the filter has to be reproduced rather than substituted.
 */
export function ladderCoefficients(freq: number, res: number): LadderCoefficients {
  return ladderCoefficientsInto(freq, res, { p: 0, f: 0, q: 0 });
}

/** `ladderCoefficients` writing into a caller-owned object. Same arithmetic. */
export function ladderCoefficientsInto(
  freq: number,
  res: number,
  out: { p: number; f: number; q: number },
): LadderCoefficients {
  const t = 1 - freq;
  const p = freq + 0.8 * freq * t;
  out.p = p;
  out.f = p + p - 1;
  out.q = res * (1 + 0.5 * t * (1 - t + 5.6 * t * t));
  return out;
}

/**
 * The coefficients as the module computes them: `0x3124`-`0x317c` on the
 * constant path and `0x346b`-`0x34bf` per sample on the ramp, the same sequence
 * both times, every operation float32:
 *
 * ```
 * t = 1 - freq
 * p = freq + (freq · 0.8) · t
 * f = (p + p) + -1
 * q = res · ((t · 0.5) · ((1 - t) + (t · t) · 5.6) + 1)
 * ```
 *
 * `Math.fround` of an operation on two float32 values is the float32 operation
 * exactly -- double carries more than twice the bits, so the two roundings
 * never disagree -- so each `f(a · b)` here is the module's `vmulps`.
 */
export function ladderCoefficients32Into(
  freq: number,
  res: number,
  out: { p: number; f: number; q: number },
): LadderCoefficients {
  const fr = f(freq);
  const t = f(1 - fr);
  const p = f(fr + f(f(fr * P_SCALE) * t));
  out.p = p;
  out.f = f(f(p + p) - 1);
  out.q = f(f(res) * f(f(f(t * 0.5) * f(f(1 - t) + f(f(t * t) * COMPENSATION))) + 1));
  return out;
}

/**
 * One ladder, in double. Five states, `b0` being the previous input.
 *
 * Coefficients are passed per sample rather than held, because the engine ramps
 * them across a block whenever they change (`0x33d6` onward re-derives the
 * coefficients per sample from a linear ramp of `freq` and `res`; `0x310b` is
 * the constant path taken when the block's two ends agree) -- holding them
 * would quantise a filter sweep to the block size, which is audible on exactly
 * the patches that sweep.
 */
export class MoogLadder implements Ladder {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;

  process(input: number, coefficients: LadderCoefficients): number {
    const { p, f, q } = coefficients;
    const x = input - q * this.b4;

    const t1 = this.b1;
    this.b1 = (x + this.b0) * p - this.b1 * f;
    const t2 = this.b2;
    this.b2 = (this.b1 + t1) * p - this.b2 * f;
    const t3 = this.b3;
    this.b3 = (this.b2 + t2) * p - this.b3 * f;
    this.b4 = (this.b3 + t3) * p - this.b4 * f;

    // The saturation. Without it the ladder blows up at high resonance instead
    // of settling into self-oscillation.
    this.b4 -= (this.b4 * this.b4 * this.b4) / 6;
    this.b0 = x;
    return this.b4;
  }

  reset(): void {
    this.b0 = 0;
    this.b1 = 0;
    this.b2 = 0;
    this.b3 = 0;
    this.b4 = 0;
  }
}

/**
 * One ladder as the module runs it, float32. Per sample, `0x31c6`-`0x327d` for
 * L and `0x3289`-`0x32ec` for R (the ramp's copy is `0x34c9`-`0x35e3`), every
 * operation one `vmulps`/`vaddps`/`vsubps`:
 *
 * ```
 * x  = in - q · b4
 * b1 = p · (b0 + x)   - f · b1
 * b2 = p · (b1 + b1') - f · b2        ; b1' the new b1, and so on down
 * b3 = p · (b2 + b2') - f · b3
 * b4 = p · (b3 + b3') - f · b4
 * b4 = b4 - (b4 · (b4 · b4)) · 0.166667
 * b0 = x
 * ```
 *
 * ⚠️ The saturation's constant is `0.166667f` (`v0x4660`, `0x3e2aaac1`), 22 ulps
 * above a sixth (`0x3e2aaaab`): the reference's decimal, not `1/6`.
 *
 * The record holds L's five at `+0xa4` (b1) … `+0xb0` (b4), `+0xb4` (b0), and
 * R's at `+0xb8` … `+0xc8` in the same order (`0x2e2f`-`0x2e90`, stored back at
 * `0x2fc3`).
 */
export class MoogLadder32 implements Ladder {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;

  process(input: number, coefficients: LadderCoefficients): number {
    const { p, f: fb, q } = coefficients;
    const x = f(f(input) - f(q * this.b4));
    const b1 = f(f(p * f(this.b0 + x)) - f(fb * this.b1));
    const b2 = f(f(p * f(this.b1 + b1)) - f(fb * this.b2));
    const b3 = f(f(p * f(this.b2 + b2)) - f(fb * this.b3));
    const b4 = f(f(p * f(this.b3 + b3)) - f(fb * this.b4));
    const y = f(b4 - f(f(b4 * f(b4 * b4)) * SATURATION));
    this.b0 = x;
    this.b1 = b1;
    this.b2 = b2;
    this.b3 = b3;
    this.b4 = y;
    return y;
  }

  reset(): void {
    this.b0 = 0;
    this.b1 = 0;
    this.b2 = 0;
    this.b3 = 0;
    this.b4 = 0;
  }
}

/** The instrument's filter settings, before the envelope and the note modulate them. */
export interface FilterSettings {
  /** `Params[3]`, 0..1. **Squared** on the way to the cutoff. */
  readonly cutoff: number;
  /** `Params[4]`, 0..1. Zero in 60 of the game's 68 instruments. */
  readonly resonance: number;
  /** `Params[5]`, 0..1: how far the cutoff follows the note. */
  readonly keyTrack: number;
  /** `Params[6]`, 0..1: how far envelope B moves the cutoff. */
  readonly envAmount: number;
}

/**
 * Cutoff and resonance for one sample, given the filter envelope's current
 * level and the voice's playback rate.
 *
 * ```
 * keytrack  = 1 + (pitchRatio - 1) * keyTrack
 * envFactor = 1 + envAmount * (envelopeB - 1)
 * freq = clamp(cutoff² * keytrack * envFactor, 0, 1)
 * res  = clamp(resonance      * envFactor,     0, 1)
 * ```
 *
 * Read out of `fmodextinput.prx` at `0x29c2`-`0x2a50`. Every parameter arrives
 * through the same lerp-and-broadcast shape, `vsubss; vmulss xmm7; vaddss;
 * vpshufd 0`, which is `x + mod * (y - x)`:
 *
 * ```
 * 0x29e8   xmm4 = (1 - envAmount) + envB * envAmount      ; envFactor
 * 0x29ff   xmm6 = cutoff * cutoff                         ; cutoff²
 * 0x2a2a   xmm1 = 1 + (pitchRatio - 1) * keyTrack         ; keytrack
 * 0x2a2e   xmm1 = cutoff² * keytrack
 * 0x2a32   xmm9 = envFactor * xmm1                        ; freq
 * 0x2a50   xmm1 = xmm4 * resonance                        ; res = envFactor * resonance
 * ```
 *
 * ⚠️ **`xmm4` is `envFactor`, not `keytrack`, and the two are indistinguishable
 * from the arithmetic alone** — both are `1 + (X - 1) * p`. A session read them
 * the wrong way round, concluded that the resonance takes the key tracking, and
 * swapped `Params[5]` and `[6]` to match. What settles it is the identity of
 * `X`: `[rbp-0xa90]` starts at 1.0 and is multiplied by a frequency ratio, so it
 * is the pitch; `[rbp-0xb70]` is the return of the envelope evaluator called at
 * `0x21ed` with `Params[7..10]`, so it is envelope B. See `FILTER_PARAMS`.
 *
 * **The clamps are the engine's**, not ours as this said. `0x2aa9`-`0x2af2`
 * clamps all four block values -- the start and end of both the cutoff and the
 * resonance ramp -- with `vminps` against 1.0 and `vmaxps` against zero.
 */
export function filterAt(
  settings: FilterSettings,
  envelopeB: number,
  pitchRatio: number,
): { freq: number; res: number } {
  return filterAtInto(settings, envelopeB, pitchRatio, { freq: 0, res: 0 });
}

/**
 * `filterAt` writing into a caller-owned object instead of allocating one.
 *
 * The voice loop calls this once per frame per voice, and an object per call
 * there is a measurable share of the render: allocation plus the garbage it
 * makes. The arithmetic is identical -- this is the same function with the
 * result written rather than returned.
 */
export function filterAtInto(
  settings: FilterSettings,
  envelopeB: number,
  pitchRatio: number,
  out: { freq: number; res: number },
): { freq: number; res: number } {
  const keytrack = 1 + (pitchRatio - 1) * settings.keyTrack;
  const envFactor = 1 + settings.envAmount * (envelopeB - 1);
  const freq = settings.cutoff * settings.cutoff * keytrack * envFactor;
  const res = settings.resonance * envFactor;
  out.freq = freq < 0 ? 0 : freq > 1 ? 1 : freq;
  out.res = res < 0 ? 0 : res > 1 ? 1 : res;
  return out;
}

/** A segment's cutoff and resonance at its two ends, as the ladder takes them. */
export interface FilterEnds {
  freqS: number;
  freqE: number;
  resS: number;
  resE: number;
}

/**
 * `filterAt` at both ends of a chunk, in float32 and in the module's order --
 * for a record on the engine's clock, which has the float32 `Params`, the two
 * modulations and the start ratio the module has.
 *
 * `0x29c2`-`0x2a50` for the start (`xmm7`, envelope B's `[rbp-0xb70]`),
 * `0x2a54`-`0x2aa5` for the end (`xmm15`, `[rbp-0xb60]`), then `vminps 1`,
 * `vmaxps 0` (`0x2aa9`-`0x2aee`). Each parameter is `param32`'s
 * `x + mod · (y − x)`, and:
 *
 * ```
 * envFactor = (1 − amount) + envB · amount           ; not 1 + amount · (envB − 1)
 * keytrack  = (ratio + −1) · keyTrack + 1            ; the START ratio at both ends
 * freq = envFactor · (cutoff · cutoff · keytrack)
 * res  = envFactor · resonance
 * ```
 *
 * ⚠️ `envFactor` is formed as `(1 − a) + e · a`, which is `filterAt`'s
 * `1 + a · (e − 1)` in exact arithmetic and not in float32.
 */
export function filterEnds32(
  params: readonly (Param32 | undefined)[],
  modS: number,
  modE: number,
  envBS: number,
  envBE: number,
  ratio: number,
  noKeyTrack: boolean,
  out: FilterEnds,
): FilterEnds {
  const r1 = f(f(ratio) - 1);
  const ends = (mod: number, envB: number, freq: boolean): number => {
    const amount = param32(params[FILTER_PARAMS.envAmount], mod);
    const envFactor = f(f(1 - amount) + f(f(envB) * amount));
    if (!freq) return clampPs(f(envFactor * param32(params[FILTER_PARAMS.resonance], mod)));
    const cutoff = param32(params[FILTER_PARAMS.cutoff], mod);
    const keyTrack = noKeyTrack ? 0 : param32(params[FILTER_PARAMS.keyTrack], mod);
    const keytrack = f(f(r1 * keyTrack) + 1);
    return clampPs(f(envFactor * f(f(cutoff * cutoff) * keytrack)));
  };
  out.freqS = ends(modS, envBS, true);
  out.resS = ends(modS, envBS, false);
  out.freqE = ends(modE, envBE, true);
  out.resE = ends(modE, envBE, false);
  return out;
}

/** `vminps x, 1` then `vmaxps x, 0`: a NaN comes out as 1, the second operand of the first. */
function clampPs(x: number): number {
  const low = x < 1 ? x : 1;
  return low > 0 ? low : 0;
}

/**
 * The step a ramped segment adds per sample: `(end − start) · (1.0f / N)`
 * (`0x33e7`-`0x3415`) -- a reciprocal, then a multiply, both float32 -- added
 * after each sample's ladders (`0x36d9`, `0x36ea`), so the ramp accumulates
 * its rounding as the module's does.
 */
export function rampStep32(start: number, end: number, frames: number): number {
  return f(f(end - start) * f(1 / frames));
}

/** `Params` indices, so the mapping lives next to the code that uses it. */
/**
 * Which `Params` index is which filter control.
 *
 * `fmodextinput.prx` loads the four as consecutive `(x,y)` pairs from `rcx` at
 * `0x2945`-`0x297d` and combines them at `0x29c2`-`0x2a50`. The array base is
 * pinned rather than assumed: the same function reads `[rcx+0x540..0x55c]` as
 * the amplitude ADSR (`Params[11..14]`), `[rcx+0x560..0x5a4]` as the LFO
 * triples and `[rcx+0x5a8]` as the output level, which puts `Params[0]` at
 * `rcx+0x4e8` and `Params[3]` at `rcx+0x500`.
 *
 * ⚠️ **The key-tracking and envelope terms are the same shape**, `1 + (X - 1)*p`,
 * so the indices cannot be told apart from the arithmetic — only from what `X`
 * is. This was got wrong once by guessing:
 *
 * - `[rbp-0xa90]` is the **pitch ratio**. It is set to `1.0` at `0x1de5` and
 *   multiplied at `0x1e0a` by `[rbp-0x9d0] / [rcx+rbx+0x88]`, a frequency over
 *   the slot's own base frequency. It pairs with `Params[5]`, so
 *   **`Params[5]` is the key tracking**.
 * - `[rbp-0xb70]` is **envelope B**. `0x213d`-`0x21cd` interpolate
 *   `Params[7..10]` — the filter ADSR — and `0x21ed` calls the envelope
 *   evaluator with them, storing its result there. It pairs with `Params[6]`,
 *   so **`Params[6]` is the envelope amount**.
 *
 * Everything downstream follows from those two, including which of the two
 * factors reaches the resonance at `0x2a50`.
 */
export const FILTER_PARAMS = {
  cutoff: 3,
  resonance: 4,
  keyTrack: 5,
  envAmount: 6,
} as const;
