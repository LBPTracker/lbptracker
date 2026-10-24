/**
 * The instrument's ADSR -- `Params[11..14]`, reproduced from `0x16b0` in
 * `fmodextinput.prx`.
 *
 * This is the envelope the project went four sessions without: until it was
 * found, `Mixer` faked a note's shape with a linear release and an optional
 * exponential decay, both marked as ours rather than the game's. Both are
 * superseded by this. See steering/sequencer-engine-inputs.md for the evidence,
 * which is the disassembly plus two independent checks against the 68
 * instruments the game ships.
 *
 * Two things about it are worth knowing before reading the code:
 *
 * - **The stages are linear in level, not exponential.** A piano modelled this
 *   way decays along a straight line, not a curve. That is what the engine
 *   does; it is not a simplification made here.
 * - **The stage time is the parameter squared**, which is how a 0..1 knob turns
 *   into a usable range of times.
 */

import type { InstrumentParam } from '@lbptracker/cwlib/resources/rinstrument.ts';

/** One evaluated envelope. Times are in seconds; `sustain` is a level, 0..1. */
export interface Adsr {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/**
 * `Params` indices for the amplitude envelope.
 *
 * Established three ways that agree: the four are loaded together at `0x1ed3`
 * and passed to `0x16b0` in this order; `Params[13]` separates struck from
 * sustained instruments at Cohen's d = -3.54, further than anything else in the
 * block; and its values are exactly 1.0 on `choir`, `brass` and `clarinet`,
 * exactly 0.0 on `glockenspiel`, `marimba` and `vibraphone`, and 0.070 on the
 * piano.
 */
export const ADSR_PARAMS = { attack: 11, decay: 12, sustain: 13, release: 14 } as const;

/**
 * A second envelope with the same shape, at `Params[7..10]`: the **filter**
 * envelope.
 *
 * ✔ Measured: `0x213d`-`0x21cd` interpolate these four and `0x21ed` and
 * `0x2227` call the same evaluator with them; its returns, kept at
 * `[rbp-0xb70]` and `[rbp-0xb60]`, are the `envelopeB` of `filterAt`'s
 * `envFactor` at the two ends (`0x29e8`, `0x2a72`). See `FILTER_PARAMS` in
 * `audio/moog.ts` for how it was told apart from the key tracking.
 */
export const ADSR_PARAMS_B = { attack: 7, decay: 8, sustain: 9, release: 10 } as const;

/**
 * Seconds per unit of the engine's envelope clock.
 *
 * ✔ **Measured, 2026-09-02.** This used to say "derived, not measured", with
 * the other `dt` constant in the same code (`1/48,000,000`, 250x smaller) named
 * as the thing that could overturn it. Reading both in context settles it:
 *
 * ```
 * 0x1ff8  the amplitude ADSR's four Params, interpolated
 * 0x201f  dt = xmm5   * 1/48,000,000        -> the block's START
 * 0x203f  call 0x16b0                        ; the envelope, with `held` in edi
 * 0x204c  dt = frames * 1/192,000            -> the block's END
 * 0x2089  call 0x16b0                        ; and again
 * ```
 *
 * The envelope is evaluated **twice per block**, once at each end, and the two
 * results are ramped across it -- which is the same shape the filter block uses
 * with two modulations. The second call's `dt` closes the arithmetic:
 * `frames / 192,000` units x **4 seconds per unit** = `frames / 48,000` seconds,
 * which is exactly the block's duration at 48 kHz. The unit is four seconds
 * because that is the only value that makes the engine's own `dt` equal real
 * time.
 *
 * ⚠️ The 250x-smaller constant is the block *start* -- a 250th of the block,
 * "where the envelope is now" -- and it is not a plain read: the call advances
 * the state by that much, so the engine's envelopes run a 250th faster than
 * its clock, and an attack of zero stands at full level from the first frame.
 *
 * ✔ `Voice` in `audio/mixer.ts` makes the same two calls per segment and ramps
 * the gain between their two levels, which is the engine's arithmetic. Where a
 * stage turns inside a segment the ramp cuts the corner, as the engine's does.
 */
export const ENVELOPE_SECONDS_PER_UNIT = 4;

/**
 * The two `dt` constants as the module holds them, float32: `frames ·
 * 1/48,000,000` for the block's start (`0x201f`, `v0x4560`) and `frames ·
 * 1/192,000` for its end (`0x2054`, `v0x4564`), the frames being the engine's
 * own at 48 kHz. `Envelope.advance32` takes them.
 */
export const ENGINE_DT_START = Math.fround(1 / 48e6);
export const ENGINE_DT_END = Math.fround(1 / 192000);

/**
 * A `Params` pair is a **range**, and the note picks a point inside it.
 *
 * `mod` comes from bits 24..27 of the note word divided by 15, so it has
 * sixteen positions. Where `x === y` -- most instruments, most params -- the
 * parameter is fixed and `mod` does nothing.
 *
 * ✔ **`x + mod*(y - x)`, and the direction is measured on every one of the 27
 * parameters, not inferred from one.** `fmodextinput.prx` loads `.x` then `.y`
 * and subtracts `y - x` at 27 distinct sites; the four filter parameters load
 * into xmm8..xmm14 first and combine later, at `0x29c2`, `0x29ec`, `0x2a03` and
 * `0x2a36`, which is why a scan for "the `vsubss` right after the `.y` load"
 * finds only 23. Getting the direction backwards would invert every range in the
 * game at once, silently, on the 19% of notes that carry a modulation.
 */
export function evaluateParam(param: InstrumentParam, mod: number): number {
  return param.x + mod * (param.y - param.x);
}

/** Evaluate one of the two envelopes for a note whose modulation is `mod`. */
export function evaluateAdsr(
  params: readonly InstrumentParam[],
  indices: typeof ADSR_PARAMS | typeof ADSR_PARAMS_B,
  mod: number,
): Adsr {
  const at = (i: number) =>
    evaluateParam(params[i] ?? { x: 0, y: 0 }, mod) ** 2 * ENVELOPE_SECONDS_PER_UNIT;
  return {
    attack: at(indices.attack),
    decay: at(indices.decay),
    // The sustain is a LEVEL, so it is not squared and not a time.
    sustain: evaluateParam(params[indices.sustain] ?? { x: 0, y: 0 }, mod),
    release: at(indices.release),
  };
}

/**
 * The level an envelope has reached after `seconds` with the gate still open.
 *
 * ❗ **This is how long a voice holds one of the engine's 32 records.** The
 * engine frees a record when the voice's level reaches zero (`sub_0x1c60`
 * `0x20e0` on the envelope's own return, then `0x3093` writes `0xff`), and the
 * release falls **linearly from wherever the level was**, so the tail after the
 * gate closes is `release x level`, not `release`. A note released from a
 * sustain of 0.2 holds its record for a fifth as long as one released from 1.
 *
 * The same three phases `advance` runs, solved instead of stepped: the attack
 * from 0 to 1 over `attack`, the decay from 1 to `sustain` over
 * `decay x (1 - sustain)`, and then the sustain.
 */
export function envelopeLevelAt(adsr: Adsr, seconds: number): number {
  if (seconds <= 0) return 0;
  if (adsr.attack > 0) {
    if (seconds < adsr.attack) return seconds / adsr.attack;
  }
  const after = seconds - Math.max(0, adsr.attack);
  const falling = adsr.decay * (1 - adsr.sustain);
  if (adsr.decay <= 0 || after >= falling) return adsr.sustain;
  return 1 - after / adsr.decay;
}

/**
 * The engine's envelope generator, state and all.
 *
 * The stored value is **mirrored around 1**, exactly as the engine stores it:
 * `0..1` is the attack running upward, and `1..2` is the decay running upward
 * while the level it represents runs *down*. Keeping that representation rather
 * than a tidier one is deliberate -- the handover from attack to decay depends
 * on it, and a rewrite into an explicit stage enum was where a subtle
 * difference would hide.
 */
export class Envelope {
  private stored = 0;
  private done = false;

  /** The audible level, 0..1. */
  get level(): number {
    return this.stored > 1 ? 2 - this.stored : this.stored;
  }

  /** True once a released envelope has reached zero; the voice can be freed. */
  get finished(): boolean {
    return this.done;
  }

  /**
   * Advance by `dt` seconds and return the new level.
   *
   * `gate` is the note still being held -- in the engine, `voice[+0x10] == 0`,
   * the flag the sequencer sets when the note's chain of records ends.
   */
  advance(dt: number, gate: boolean, adsr: Adsr): number {
    if (!gate) {
      // Release: the audible level falls, and hitting zero ends the voice.
      if (adsr.release <= 0) {
        this.stored = 0;
        this.done = true;
        return 0;
      }
      const next = this.level - dt / adsr.release;
      if (next < 0) {
        this.stored = 0;
        this.done = true;
        return 0;
      }
      this.stored = next;
      return next;
    }

    let remaining = dt;
    if (this.stored <= 1) {
      // Attack. `need` is the time still required to reach full level.
      const need = adsr.attack * (1 - this.stored);
      if (adsr.attack > 0 && need > remaining) {
        this.stored += remaining / adsr.attack;
        return this.level;
      }
      // The attack completes inside this step; the leftover drives the decay.
      // An attack of zero from a standing start jumps straight to full.
      if (need > 0) remaining -= need;
      this.stored = 1;
    }

    // Decay, running toward the sustain level.
    const floor = 2 - adsr.sustain;
    if (adsr.decay <= 0) {
      this.stored = floor;
    } else {
      this.stored = Math.min(floor, this.stored + remaining / adsr.decay);
    }
    return this.level;
  }

  /**
   * `0x16b0` itself, in float32: `advance` as the module computes it, for a
   * record on the engine's clock. `dt` is in the module's units --
   * `frames · ENGINE_DT_START` or `frames · ENGINE_DT_END` -- and `a`, `d`,
   * `s`, `r` are the four `Params` values at the chunk's start modulation,
   * squared here as `0x16e6`, `0x1712` and `0x1750` square them.
   *
   * The branches are the module's, which `advance` also has but for one: a
   * standing start goes to 1 only from exactly 0, with no attack and a decay
   * not below 0 (`0x171a`-`0x1736`); `advance` takes any level at or under 1
   * there when the attack is 0, which no shipped instrument reaches.
   */
  advance32(dt: number, gate: boolean, a: number, d: number, s: number, r: number): number {
    const f = Math.fround;
    if (!gate) {
      // `0x1750`-`0x1792`: the level un-mirrored, less `dt / r²`, 0 ends it.
      const R = f(r * r);
      if (R > 0) {
        const level = this.stored > 1 ? f(2 - this.stored) : this.stored;
        const next = f(level - f(dt / R));
        if (next >= 0) {
          this.stored = next;
          return next;
        }
      }
      this.stored = 0;
      this.done = true;
      return 0;
    }
    const A = f(a * a);
    let stored = this.stored;
    // `0x16f6`: what the attack still needs, against this call's `dt`.
    const need = f(A * f(1 - stored));
    if (need > dt && A > 0) {
      stored = f(stored + f(dt / A));
      this.stored = stored;
      return stored > 1 ? f(2 - stored) : stored;
    }
    const D = f(d * d);
    if (stored === 0 && !(A > 0) && D >= 0) stored = 1;
    let rest = dt;
    if (need > 0) {
      // `0x1744`: the attack completes, and what is left of `dt` decays.
      stored = 1;
      rest = f(dt - need);
    }
    const floor = f(2 - s);
    let out = floor;
    if (D > 0) {
      out = f(f(rest / D) + stored);
      if (!(out < floor)) out = floor;
    }
    this.stored = out;
    return out > 1 ? f(2 - out) : out;
  }

  /** Restart the envelope for a new note. */
  reset(): void {
    this.stored = 0;
    this.done = false;
  }
}
