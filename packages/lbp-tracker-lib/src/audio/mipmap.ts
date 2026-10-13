/**
 * The game's sampler, reproduced.
 *
 * `packages/lbp-tracker-lib/src/audio/interpolate.ts` holds interpolators as a family so they can be
 * compared. This file holds something different: **one function that does what
 * `0x3780` in `fmodextinput.prx` does**, including the parts that are not
 * "quality" choices at all -- the octave mipmapping and the exact shape of the
 * loop wrap. See *The sampler* in steering/synth-engine.md.
 *
 * The two halves of the design only make sense together. Linear interpolation
 * alone measures 19 dB SNR at 4 kHz, which is poor; the game never asks it to
 * stretch further than one octave, because past that it swaps the source for a
 * pre-decimated copy. Implementing the lerp without the mipmapping reproduces
 * the weakness and not the compensation, which is worse than either.
 */

/**
 * A sample at successive halvings: `chain[0]` is the sample's own rate,
 * `chain[1]` is decimated by 2, `chain[2]` by 4.
 */
export type MipChain = readonly Float32Array[];

/** The game keeps three. Measured: two thresholds, scales 0.5 and 0.25. */
export const MIP_LEVELS = 3;

/**
 * Pitch ratios at which the source is swapped, **measured** from rodata:
 * `v0x458c = 2.0` selects the /2 copy (compared at `0x37de`) and `v0x4584 = 4.0`
 * the /4 copy (`0x37d4`).
 */
export const MIP_THRESHOLDS = [2, 4] as const;

/** Which mip a voice reads at this playback rate. */
export function mipLevelFor(playbackRate: number): number {
  if (playbackRate >= MIP_THRESHOLDS[1]) return 2;
  if (playbackRate >= MIP_THRESHOLDS[0]) return 1;
  return 0;
}

/**
 * **MEASURED: the copies are a pair average.**
 *
 * The builder is `fmodextinput.prx` `0x12e0`, and it is a plain average of
 * adjacent frames:
 *
 * ```
 * 0x1303  len/2 -> [rdi+0x28], [rdi+0x40]      ; the halved copy's length (stored 0x131f, 0x132b)
 * 0x1310  len/4 -> [rdi+0x50], [rdi+0x68]      ; and the quartered one's (0x132f, 0x133b)
 * 0x136e  esi = (int16)src[2i]
 * 0x1379  edx = (int16)src[2i | 2]             ; the next frame of that channel
 * 0x137d  edx += esi
 * 0x13b4  ebx = edx; ebx >>>= 31; ebx += edx; ebx >>= 1
 * 0x13bd  dst[i] = (int16)ebx
 * ```
 *
 * The `| 2` rather than `+ 1` is because the buffer is **interleaved stereo**:
 * elements `2i` and `2i|2` are consecutive frames of the same channel, and
 * `0x13c0` onward repeats the whole thing on the odd elements for the other.
 * Per channel it is exactly `(a + b) / 2`.
 *
 * ⚠️ **The arithmetic is int16 and rounds toward zero.** The `shr` by one after
 * adding the sign bit is a signed halve that works because only the low 16 bits
 * are kept, so the result lands back on the sample grid. `(a + b) * 0.5` in
 * floats differs by under an LSB, which is still a difference the brief cares
 * about.
 *
 * The `.smp` files almost certainly hold level 0 only: they are plain RIFF with
 * a single `data` chunk, and their `smpl` loop points land where a loop belongs
 * in the audible material rather than in the first 57% that extra levels would
 * leave.
 */
export function decimateBy2(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    // The engine averages the pair in **int16**, not in floats:
    //
    //   esi = (int16)src[2i]; edx = (int16)src[2i|2]; edx += esi
    //   ebx = edx; ebx >>>= 31; ebx += edx; ebx >>= 1     ; toward zero
    //   dst[i] = (int16)ebx
    //
    // so the result lands on the sample grid, rounded toward zero rather than
    // to nearest. The difference from `(a + b) * 0.5` is under one LSB, but the
    // brief asks for bit-exact sample data and this is what bit-exact means
    // here.
    const sum = Math.round(data[i * 2] * 32768) + Math.round(data[i * 2 + 1] * 32768);
    out[i] = Math.trunc(sum / 2) / 32768;
  }
  return out;
}

/** Build `levels` successive halvings, `chain[0]` being `data` itself. */
export function buildMipChain(data: Float32Array, levels = MIP_LEVELS): Float32Array[] {
  const chain: Float32Array[] = [data];
  for (let i = 1; i < levels; i += 1) {
    const previous = chain[i - 1];
    // A one-frame level cannot be halved again, and a lerp needs two taps.
    chain.push(previous.length >= 4 ? decimateBy2(previous) : previous);
  }
  return chain;
}

/** Half-open, in **level-0 frames** -- the units the voice's position is in. */
export interface LoopSpan {
  readonly start: number;
  readonly end: number;
  /**
   * The sample's own length, the slot's `+0x78`, when the buffer is longer than
   * it -- as a looped buffer is, by the 16 frames the loader's patch writes past
   * the loop. `0x37be` tests the wrapped index against this and not against the
   * buffer; see note 3 on `readMipped`.
   */
  readonly frames?: number;
}

/**
 * Read one frame, the way the game does.
 *
 * `position` is in level-0 frames whatever the mip: the engine keeps the voice
 * position in the sample's own rate (a `double` at voice record `+0x40`,
 * compared against the slot's frame count) and converts at read time, so the
 * loop arithmetic never has to know which copy is being read.
 *
 * ⚠️ **Two details here are the engine's, not conventional sampler practice.**
 * Both were read off `0x3780` and both are audible at the wrap:
 *
 * 1. **Only the integer index is wrapped; the second tap is not.** At the last
 *    frame of the loop the engine interpolates towards the frame that follows
 *    it *in the buffer* -- and the eboot's loader has put the loop's first
 *    frame there (`patchLoop` in `wav.ts`: 16 frames of the loop's start
 *    copied past its end), so on a buffer built by `engineSample` the join is
 *    seamless by construction. On a raw buffer it reads whatever follows the
 *    loop in the file, which is what this did for every sample until
 *    2026-09-08.
 * 2. **The wrap triggers on `>` , not `>=`.** Index `loop.end` is read
 *    directly -- the patched frame, equal to `loop.start`'s -- and the frame
 *    after it maps to `loop.start + 1`, so the two readings agree and the
 *    period is exactly `end − start` frames.
 * 3. **Then an index at or past the sample's length reads silence** (`0x37be`,
 *    `jge` to a `ret` with `xmm0` still zero), and that test comes after the
 *    wrap. So when a loop ends on the sample's last frame -- every single-cycle
 *    waveform the game ships -- index `loop.end` is not read as the patched
 *    frame but as **zero**, for one interpolation step. The engine never
 *    rewinds the voice's position, only this index, so past the first trip
 *    round the loop the index is always beyond `loop.end` and wrapped: the gap
 *    happens **once per note**, at the first wrap. Found 2026-10-11 by running
 *    `fmodextinput.prx` beside the tracker (`tools/prxrun.py`): one sample of
 *    `kenny_square_a4` read as 0.0 where this read +0.25.
 *
 * `gapless` closes that gap -- **ours, not the game's**, and the voice asks for
 * it with `declick`: index `loop.end` reads the patched frame there, the loop's
 * first, so the first trip round is the same as every later one. 18 of the 79
 * looped samples the game ships end their loop on their last frame, and on
 * `harp_fsharp4` the gap is a click on every note from 49 to 64 (Indigo's
 * opening arpeggio); the project's owner took it for an accident of the
 * engine's and asked for it gone (*61* in steering/open-questions.md).
 *
 * ⚠️ The caller must pass the voice's **unwrapped** position for any of this to
 * hold: wrapping it first hides the gap, and keeps a float32 precision on long
 * looped notes that the engine, converting its ever-growing double, has lost.
 */
export function readMipped(
  chain: MipChain,
  position: number,
  level: number,
  loop?: LoopSpan,
  gapless = false,
): number {
  const full = chain[0];
  // ❗ **The engine hands the sampler a float32.** The voice keeps its position
  // as a double (`+0x40 + 8i`, stepped by `vaddsd` at `0x2d59`) but the call at
  // `0x2c72` converts it with `vcvtsd2ss`, and `0x3780` truncates, floors and
  // subtracts in single precision. So the interpolation fraction has the
  // precision of a float at that position: a 256th of a frame between 32,768
  // and 65,535, a 32nd of a frame past 131,072 -- a small, real roughness on
  // long samples that a double would not have. `Math.fround` is that
  // conversion exactly; the difference below it is representable.
  const at32 = Math.fround(position);
  let index = Math.trunc(at32);
  const frac = at32 - Math.floor(at32);

  if (loop) {
    const span = loop.end - loop.start;
    // `>` and not `>=`: see note 2 above.
    if (span > 0 && index > loop.end) {
      index = loop.start + ((index - loop.start) % span);
    }
  }
  const gap = !(gapless && loop !== undefined && index === loop.end);
  if (index < 0 || (gap && index >= (loop?.frames ?? full.length))) return 0;

  let source = full;
  let at = index;
  let t = frac;
  if (level > 0) {
    const divisor = 1 << level;
    source = chain[Math.min(level, chain.length - 1)];
    at = Math.trunc(index / divisor);
    // `0x3825`/`0x384c`: the sum is a float add, so it rounds like one; the
    // scale by 0.25 or 0.5 is exact either way.
    t = Math.fround(frac + (index % divisor)) / divisor;
  }

  const a = at >= 0 && at < source.length ? source[at] : 0;
  const b = at + 1 >= 0 && at + 1 < source.length ? source[at + 1] : 0;
  return a + (b - a) * t;
}
