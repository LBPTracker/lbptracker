/**
 * The sequencer's two send effects: echo and reverb.
 *
 * Both are now read out of the game rather than inferred. The echo lives inside
 * `fmodextinput.prx`; the reverb is a separate DSP, `fmodsmsreverb.prx`,
 * configured by the eboot at `v0x3fcd50`.
 *
 * ⚠️ **PRX addresses in this file are TRUE ELF vaddrs** (`file = vaddr + 0x7c0`
 * for `fmodsmsreverb.prx`, `+ 0x7e0` for `fmodextinput.prx`). Addresses recorded
 * anywhere in this project before 2026-09-02 used a delta 0x40 too small and are
 * therefore **0x40 too high**. The readings themselves were not wrong — a
 * rip-relative operand resolves through the same delta twice, so the data those
 * disassemblies reported was correct — but the labels do not match a real
 * disassembler. See `steering/eboot-re.md`.
 *
 * **The sends, measured** (`fmodextinput.prx` `0x3b4f`-`0x3d10`). Each voice
 * carries three floats:
 *
 * | field | source | used for |
 * |---|---|---|
 * | `voice+0x1c` | the instrument's Params pair at `+0x5b0`/`+0x5b4`, interpolated by the note's modulation, then offset by the placement's `2*echoSend - 1` and clamped to 0..1 | the **echo** send |
 * | `voice+0x20` | the instrument's Params pair at `+0x5b8`/`+0x5bc`, clamped to 0..1 | the **drive** -- a soft clip on each layer's sample read (`softClip` in `mixer.ts`), not a send |
 * | `voice+0x24` | the placement's `reverbSend`, clamped to 0..1 | the **reverb** send |
 *
 * The mixer at `0x2f00`-`0x2f8f` writes `L, R` into channels 0-1 of the DSP's
 * four-channel output, `L*voice[0x24], R*voice[0x24]` into channels 2-3 — that
 * pair is the reverb send bus — and `L*voice[0x1c], R*voice[0x1c]` into a stereo
 * stack buffer, which is the echo's input. So the reverb send is **post-fader
 * and post-pan**: it is the voice's own stereo output, scaled.
 *
 * ⚠️ The echo send is a **bipolar offset**, not a blend: `0x1607e9` stores
 * `2*echoSend - 1` into the note block, and `0x3ca1` applies it as
 * `v + o*v` when `o < 0` and `v + o*(1 - v)` when `o >= 0`. An `echoSend` of
 * 0.5 therefore leaves the instrument's own send untouched, 0 mutes it and 1
 * forces it to unity.
 */

/**
 * The game's echo, `fmodextinput.prx` `0x0680`, driven from the setup at `0x0f6a`.
 *
 * It is not an FMOD DSP: it lives inside the sequencer's own plugin, on a
 * 768,000-byte ring at `[state+0x1b18]` — **192,000 floats**, and the engine
 * clamps the delay against exactly that number, so the ring is measured in
 * floats and holds **interleaved stereo**: 96,000 frames, 2.0 s at 48 kHz.
 *
 * ## The delay, and the factor of two that hid in it
 *
 * `0x0f6a`-`0x0fc1` builds the length and `0x0fcb`-`0x0fdb` advances the cursor:
 *
 * ```
 * steps  = (int)floor(stored * 16 + 0.5)      ; stored is EchoTime * 0.5
 * fps    = (int)(720000 / tempo)              ; frames in one step
 * len    = (steps * fps) & ~0xf               ; FLOATS, not frames
 * len    = clamp(len, 16, 192000)
 * cursor = (cursor + 2 * n) % len             ; n frames -> 2n floats
 * ```
 *
 * and `0x0680` reads `min(2n, len - cursor)` floats from the ring at `cursor`,
 * processes them as `[L, R, L, R, …]`, and writes them back **at the same
 * cursor**. Read and write at one cursor means the delay is one full trip round
 * the ring, so:
 *
 * **delay in frames = `len / 2`** — and `len / 2` frames is
 * `round(EchoTime * 8) / 2` steps, which at four steps to the beat is
 * **`EchoTime` beats exactly.**
 *
 * ⚠️ Three readings preceded that, and the third was still wrong. First
 * `EchoTime * 0.5` **seconds**, which cannot be right in a tempo-locked
 * sequencer. Then **beats**, argued from the corpus's musical detents. Then
 * **eight steps per unit** — two beats — from `stored * 16`, which corrected the
 * beats reading by a factor of four and was itself a factor of two out, because
 * `len` counts floats and every frame is two of them. The corpus never
 * distinguished these: `EchoTime` is 2.00 on 189 of 338 sequencers, 1.00 on 95
 * and 1.50 on 47, and two beats, two bars and half a bar are all musical. Only
 * the unit of the cursor settles it, and the cursor is a float index.
 *
 * ## Two features that are in the code and off in the game
 *
 * The kernel at `0x07c0` also carries, on the delayed signal:
 *
 * - **two cascaded one-poles**, `s += (x - s) * k` with `k = 1 - [state+0x1a40]`,
 *   feeding both the output and the feedback (states at `+0x1b20`..`+0x1b2c`);
 * - a **ping-pong**: when `[state+0x1a3c] > 0.5` the write-back indices become
 *   `(2i) | 1` and `(2i+1) ^ 1`, so the feedback path swaps L and R each pass.
 *
 * ⚠️ **Neither is reachable.** `0x11fd`/`0x1207` initialise both fields to zero
 * and **nothing writes them**: a scan of the whole eboot finds *no* store to
 * `+0x1a3c` at all, and both of the two state-upload paths (`v0x1c5cf8` and
 * `v0x1c62b7`) write tempo, swing and the three echo fields and skip these. With
 * `[+0x1a40] = 0` the coefficient is 1 and the one-poles are pass-through; with
 * `[+0x1a3c] = 0` the ping-pong is off. So the shipped echo is a plain stereo
 * delay, and this class does not implement either — but they are worth knowing
 * about before someone "discovers" a filter in that loop.
 */
export class Echo {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private cursor = 0;
  /** The delay in output frames — `len / 2`, so always a multiple of 8. */
  readonly frames: number;
  readonly feedback: number;
  readonly mix: number;
  /** The delay actually used, in seconds. Handy for reporting. */
  readonly seconds: number;

  /**
   * @param echoTime the sequencer's field, which is a delay in **beats**.
   * @param framesPerStep the sequencer's step length in output frames.
   */
  constructor(
    sampleRate: number,
    echoTime: number,
    framesPerStep: number,
    feedback: number,
    mix: number,
  ) {
    const steps = Math.max(0, Math.trunc(Math.max(echoTime, 0) * 0.5 * 16 + 0.5));
    // `& ~0xf` is the engine's block granularity, and the clamp's upper bound is
    // the ring's own float count. Both are applied to the FLOAT length.
    const floats = Math.min(
      192000,
      Math.max(16, Math.trunc(steps * Math.trunc(framesPerStep)) & ~0xf),
    );
    this.frames = floats >> 1;
    this.seconds = this.frames / sampleRate;
    this.left = new Float32Array(this.frames);
    this.right = new Float32Array(this.frames);
    // `vmaxss` against 0 then `vminss` against 0.95, at 0x0793-0x079b.
    this.feedback = Math.min(Math.max(feedback, 0), 0.95);
    this.mix = Math.min(Math.max(mix, 0), 1);
  }

  /**
   * Process one frame, returning the wet signal.
   *
   * ⚠️ In the engine this wet is added to **all four** of the plugin's output
   * channels (`0x0846`-`0x0858` builds `{wL, wR, wL, wR}`), and channels 2-3 are
   * the reverb send. **The echo feeds the reverb**, and the caller has to do
   * that; this returns one stereo pair.
   */
  process(l: number, r: number): { left: number; right: number } {
    const wetL = this.left[this.cursor];
    const wetR = this.right[this.cursor];
    this.left[this.cursor] = l + wetL * this.feedback;
    this.right[this.cursor] = r + wetR * this.feedback;
    this.cursor = this.cursor + 1 === this.frames ? 0 : this.cursor + 1;
    return { left: wetL * this.mix, right: wetR * this.mix };
  }
}

/**
 * How much of a written pan survives to the game's stereo output:
 * **`2 - Math.SQRT2` = 0.5857864**, as `p' = 0.5 + (p - 0.5) * PAN_WIDTH`.
 *
 * ✔ **Applied by the game's master bus, the default since 0.2.43**, and not
 * per voice: `master-stage.ts` runs the whole fold as the matrix it is, with
 * {@link FOLD_CENTRE}, after the plugin's clip, the reverb and `SMS
 * WaveHammer`, which is where FMOD's speaker matrix sits. Narrowing each
 * voice's pan instead would put the narrowed image in front of the clip and
 * the compressor's detector, which see the internal one in the game. ⚠️ Our
 * own master bus and `'none'` still leave it out and keep only
 * {@link FOLD_GAIN}: the file's own pans, the listening judgement of
 * 2026-09-06 that *39* in `steering/answered-questions.md` records.
 *
 * ✔ **Measured against the game's own output at four pan values**, and the last
 * two were a *prediction* confirmed out of sample. Two placements at pan 0.40
 * and 0.60 in `Ascetic` gave a channel ratio of 0.5586 where this renderer gave
 * 0.6000; that fixed a one-parameter family, which predicted **0.261204** for a
 * hard-panned voice. A recording of one instrument at pan 0 and another at pan 1
 * then measured, by least squares over the whole file:
 *
 * ```
 *                        pan 0      pan 1     predicted
 *   opposite / dominant  0.261202   0.261202  0.261204
 *   residual / rms       0.0008     0.0008
 *   correlation, lag     1.000000, 0 samples
 * ```
 *
 * Six significant figures on both files. **A constant-power law over a reduced
 * angle -- the one candidate that is not affine -- predicts 0.198 and is
 * refuted.** The residual and the unit correlation say the quiet channel is the
 * loud one times a constant: no delay, no decorrelation, no reverb of its own.
 *
 * The same numbers in the other two forms, all one law: a mono copy of the voice
 * added to both channels at `c = 2^-1.5 = 0.3535534`, or a cross-bleed of
 * `b = 1 / (1 + 2*sqrt2) = 0.2612039`. `2^-1.5` is `0.5 / sqrt2` -- the mono
 * average of a stereo pair folded back in at the textbook -3 dB, which is what a
 * **centre channel** does.
 *
 * ⚠️ **It happens in the stereo fold, not in the sequencer**, and the two halves
 * have different owners. The game renders **7.1**: `v0xa57770`, FMOD's
 * `GetDriverCaps` for its "FMOD Orbis AudioOut Output" driver, reports
 * `FMOD_SPEAKERMODE_7POINT1`, 48 kHz and float, and the game itself calls
 * `System::setSpeakerMode(6)` at `v0x3e76d8` -- FMOD's own default is stereo
 * (`v0xa4fbb4`), so the driver's report alone would not have made it 7.1.
 * Eight channels leave the game, and folding 7.1 to stereo cross-feeds
 * **only through the centre**, at the ITU-R BS.775 coefficient `1/sqrt2` --
 * which is what `2^-1.5 = 0.7071 * (L+R)/2` is. ⚠️ That fold is the
 * platform's, not the game's: shadPS4's is `0.7071f` with the LFE dropped;
 * a real PS4's has not been read.
 *
 * So the centre must carry the mono average, and that part is the *game's*: the
 * sequencer itself cannot do it -- its pan law is exactly `1-p` / `p`
 * (`0x2d21`/`0x2d40`), the pan reaches the voice unmodified (`0x3b29`), and its
 * four output channels are one image plus a scaled copy.
 *
 * ✔ **And FMOD's side is read too, 2026-09-05, so this constant is a derivation
 * rather than a fit.** `System::playDSP` makes the 4-channel Sequencer DSP the
 * channel's own head (`v0x3e6718`), `ChannelSoftware::setPan` asks for a
 * channel-to-speaker matrix (`v0xa243a0`), and the 7.1-by-4-channels case at
 * **`v0xa2599f`** writes `levels[centre] = {k, k, 0, 0}` with **`k = 0.5`**
 * (`v0xefc008`) -- the mono average of the front pair, in FMOD Ex's own code.
 * Three read constants and no free parameter:
 *
 * ```
 *   L = x[(1-p) + k*d],  R = x[p + k*d],   k = 0.5, d = 1/sqrt2
 *   width = 1 / (1 + 2*k*d) = 1 / (1 + 1/sqrt2) = 2 - sqrt2
 * ```
 *
 * The same matrix puts the DSP's channels 2-3 -- the reverb send -- on the four
 * surrounds, which would bleed the send into the dry output. It does not: the
 * reverb DSP shares the buffer and writes `(dry + wet, dry + wet, 0, 0)`,
 * clearing those lanes (`fmodsmsreverb.prx` `0x2335`-`0x235d`). See *22* in
 * steering/answered-questions.md.
 *
 * A stereo listener hears this narrowing on hardware or emulator alike, so the
 * game's **internal** image is wider than what a TV plays. The game's master
 * bus gives what the TV plays; ours and `'none'` the internal image.
 *
 * ❌ **This used to say "width, not gain", and that was half of a linear
 * operator.** `L = ch0 + k·d·(ch0+ch1)` shrinks the difference by
 * `1/(1 + 2·k·d)` and grows the **sum** by `(1 + 2·k·d)`, the same number, so
 * narrowing without the gain rendered everything a flat **−4.645 dB** under the
 * game's own stereo. ⚠️ **We are now deliberately keeping the other half**, which
 * is the same shape of error made on purpose — see {@link FOLD_GAIN}.
 */
export const PAN_WIDTH = 2 - Math.SQRT2;

/**
 * The gain the same fold puts on the sum: **`1 / PAN_WIDTH` = 1.7071068**.
 *
 * `L = ch0 + k·d·(ch0 + ch1)` shrinks the difference by `1/(1 + 2·k·d)` and
 * grows the sum by `(1 + 2·k·d)`, and those are the same number — so the width
 * and this are one linear operator seen from two sides. Applying only the first
 * renders everything a flat **−4.645 dB** under the game's own stereo, at every
 * pan: the ratio is 0.585786 at 0, 0.25, 0.5, 0.75 and 1 alike.
 *
 * ❗ **On its own it is half that operator, and only the master buses that are
 * not the game's use it alone.** Ours and `'none'` multiply both channels by
 * it and keep the file's own image, the listening judgement of 2026-09-06: the
 * game's downmixed **level** with the game's internal **image**. The game's
 * bus runs the whole operator through {@link FOLD_CENTRE}, under which the
 * sum grows by exactly this and the difference not at all.
 *
 * ✔ **Applied where FMOD applies it**: in the speaker matrix, *after* the
 * whole DSP chain — after the plugin's own clip, the reverb and `SMS
 * WaveHammer`. `master-stage.ts` applies it last, for `render.ts` and
 * `mixer-worklet.ts` alike. It was once folded into each voice, which put our
 * clip and our compressor 4.645 dB hotter than the game's (*39* in
 * steering/answered-questions.md).
 *
 * ⚠️ **A narrow image is quieter, and that is the pan law rather than this.**
 * `panGains` is linear (`0x2d21`/`0x2d40`), so a voice at the centre carries
 * `2 × 0.5² = 0.5` of the power a hard-panned one carries: collapsing a song
 * toward mono costs up to **3 dB**. Measured over 30 s from width 1 to 0,
 * `Orb` (the corpus's widest) lost **2.04 dB** and `Zero` **0.12 dB** — which is
 * now moot for playback, and kept because it is what any future width control
 * would run into.
 */
export const FOLD_GAIN = 1 / PAN_WIDTH;

/**
 * What each front channel takes of the pair through the centre speaker:
 * FMOD's `k = 0.5` (`v0xefc008`, the 7.1-by-4-channels case at `v0xa2599f`)
 * times BS.775's `d = 1/sqrt2`, **`2^-1.5` = 0.3535534**.
 *
 * The whole fold a stereo listener hears, as the game's master bus runs it:
 *
 * ```
 *   L' = L + FOLD_CENTRE * (L + R)       the front speaker, and the centre
 *   R' = R + FOLD_CENTRE * (L + R)       folded into it at -3 dB
 * ```
 *
 * The sum grows by `1 + 2 * FOLD_CENTRE`, which is {@link FOLD_GAIN}, and the
 * difference is untouched, so the pan narrows by {@link PAN_WIDTH}. A voice
 * panned hard left comes out with `FOLD_CENTRE / (1 + FOLD_CENTRE)` =
 * **0.261204** of itself on the right: what the captures measured, 0.261202.
 */
export const FOLD_CENTRE = 0.5 * Math.SQRT1_2;

/**
 * The hard clip the sequencer's plugin puts on its own output.
 *
 * `0x0889`-`0x0899`: `vmaxps` against -1, `vminps` against +1, on all four
 * channels at once, applied to the dry mix **plus** the echo's wet, once per
 * frame. Channels 0-1 are what reaches the master and 2-3 are the reverb send,
 * so both are clipped — the reverb is fed a clipped signal.
 *
 * ⚠️ **It is the plugin's own clip and NOT the end of the game's chain.** The
 * channel carries two more DSPs after this one — `Channel::addDSP` is called at
 * `v0x3e67f9` for "SMS Reverb" and at `v0x3e6976` for **"SMS WaveHammer"**, and
 * `addDSP` inserts at the head, so the signal path is `Sequencer → Reverb →
 * WaveHammer → mixer`. The reverb is `Reverb` below; the WaveHammer is a
 * compressor (−18 dB, 10:1, a 64-sample mean square, the limiter bypassed),
 * `compressor.ts`, pinned against the module running and run by the game's
 * master bus after the reverb (`master-stage.ts`).
 *
 * ⚠️ **Nor is it the only clip in the plugin.** `0x2e00`-`0x2e2d` clamps each
 * record's summed layers to ±1 before its ladder; see `Voice` in `mixer.ts`.
 *
 * Whether this clip engages also depends on our absolute level matching the
 * game's, which is not independently verified. `packages/lbp-tracker-lib/dev/render-level.ts` reports how
 * much of the render it touches, and `LBP_NO_CLIP=1` turns it off for an A/B.
 */
export function clipToUnit(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * How a preset's eleven `int32` slots are named, from the DSP configure at
 * `v0x3fcd50` — the code that turns them into the plugin's parameter block.
 */
export const PRESET_SLOT = {
  /**
   * Millibels — the **dry** level, `[param+0x4c]`.
   *
   * `v0x3fd4c0` pushes slots 1-10 into DSP parameters 1-10 and never touches
   * slot 0; the constructor pins it at **-800**. `millibelToLinear`'s floor is
   * on `v*10 > -8000`, so -800 converts to a hard **zero**: the DSP is a pure
   * send effect and emits no dry signal at all.
   */
  dryLevel: 0,
  /** Millibels — the **late** (comb network) level, `[param+0x48]`. */
  lateLevel: 1,
  /**
   * Millibels — the **early reflections** level, `[param+0x50]`, and the engine
   * **divides it by 100** (`v0x3fce41`, `vdivss` against a literal 100).
   *
   * The divide is not a curiosity: the early rows carry gains of 46, -60 and 21,
   * so the hundredth is what brings them back to sane numbers. An earlier
   * revision of this file tried the divide on the *late* level instead and
   * killed the tail.
   */
  earlyLevel: 2,
  /** Index into `REVERB_TAP_SETS` — the late network's delay lengths. */
  tapSet: 3,
  /** Index into `REVERB_EARLY_SETS` — the early reflections. */
  earlySet: 4,
  /** Decay in tenths of a second: RT60 = `slot5 * 0.1` s. The presets give 0.6-5.0 s. */
  decay: 5,
  /**
   * The **output delay in milliseconds**, `[param+0x3c]` — a delay line the
   * summed comb bank passes through before the late level is applied, one per
   * output channel (`state+0x400` and `state+0x440`).
   *
   * This slot was called `unknown6` for a long time. The presets give 1-70 ms,
   * which is exactly the range a reverb's pre-delay lives in.
   */
  outputDelayMs: 6,
  /** Boolean — whether the input notch runs, `[param+0x20]`. Always 1 in the presets. */
  notchEnable: 7,
  /**
   * The notch frequency in hertz, before the engine's own scaling.
   *
   * `v0x3fce8e`-`v0x3fceed`: `f = slot8 / 48000`, then **`f /= 2.2` when
   * `f < 1/96` and `f /= 3.3` otherwise**, then clamp to `[0.0004, 0.49]`. The
   * threshold is 500 Hz, which no preset reaches, so every preset takes the
   * `/2.2` branch: 20 Hz ends up at 19.2 Hz after the clamp, 100 at 45.5 and
   * 400 at 181.8.
   *
   * ⚠️ An earlier revision used `slot8 / 48000` with no divisor, putting the
   * corner 2.2x too high.
   */
  notchHz: 8,
  /** Boolean — whether the damping one-pole runs, `[param+0x24]`. Preset 8 has it **off**. */
  dampEnable: 9,
  /** Hertz, 3000-12000 — the damping corner. `a = exp(-2*PI*hf/48000)`. */
  dampHz: 10,
} as const;

export const REVERB_TAP_SETS: readonly (readonly number[])[] = [
  [23.583, 47.049, 25.481, 27.493, 29.67, 34.518, 32.056, 37.317, 40.358, 19.941], // 0: 10 taps
  [23.161, 18.481, 20.611, 16.035, 26.45, 29.281, 12.957, 33.46], // 1: 8 taps
  [53.703, 67.624, 41.051, 72.937, 84.262, 49.613, 45.85, 57.837, 62.5, 78.724], // 2: 10 taps
  [13.453, 24.966, 28.415, 12.028, 15.817, 17.836, 10.72, 19.719, 9.439, 22.011], // 3: 10 taps
  [54.208, 28.707, 21.029, 49.33, 44.418, 35.918, 12.332, 66.457, 40.313, 60.051], // 4: 10 taps
  [70.539, 46.457, 52.802, 39.727, 76.939, 58.518, 64.33, 31.62, 90.769, 83.537], // 5: 10 taps
  [46.463, 89.887, 53.024, 58.824, 83.067, 70.527, 39.707, 76.433, 64.719, 31.627], // 6: 10 taps
  [25.037, 34.831, 29.502, 37.527, 32.139, 22.731, 40.532, 43.812, 47.07], // 7: 9 taps
  [32.963, 35.329, 44.227, 38.224, 62.813, 30.368, 41.467, 47.525, 51.611, 56.539], // 8: 10 taps
  [13.407, 24.354, 11.88, 10.291, 4.527, 15.213, 20.313, 8.519, 17.221, 6.513], // 9: 10 taps
  [31.71, 21.921, 5.019, 27.327, 11.403, 16.029, 6.604, 9.733, 8.169, 13.309], // 10: 10 taps
  [13.319, 20.32, 12.034, 10.609, 4.697, 14.75, 17.036, 9.106, 6.564, 7.949], // 11: 10 taps
  [21.096, 66.413, 28.715, 49.337, 44.433, 35.993, 12.339, 40.301, 54.257, 60.013], // 12: 10 taps
  [41.005, 45.815, 49.637, 53.795, 57.812, 62.504, 67.637, 72.921, 78.721, 84.212], // 13: 10 taps
  [37.051, 45.853, 62.817, 53.717, 57.815, 17.296, 67.611, 72.953, 78.716, 84.214], // 14: 10 taps
  [50.139, 62.811, 53.916, 25.834, 17.235, 67.81, 73.626, 93.927, 84.219], // 15: 9 taps
  [31.737, 15.013, 11.528, 36.037, 19.131, 5.439, 9.41, 26.433, 7.437], // 16: 9 taps
  [3.101, 18.37, 12.86, 11.063, 5.027, 15.513, 6.544, 9.539, 21.734, 7.924], // 17: 10 taps
  [29.809, 12.764, 49.653, 20.817, 25.333, 43.015, 15.957, 4.613, 9.111, 36.519], // 18: 10 taps
];

/**
 * The early-reflection rows at `v0xe1d920`, nine floats each.
 *
 * **The columns are `[d0, d1, d2, g0, g1, g2, p0, p1, p2]`** — three delays in
 * milliseconds, three gains, three pan positions in 0..1 — and the configure at
 * `0x1254`-`0x136b` is what says so:
 *
 * - the first three are multiplied by the sample rate, with the fixed offsets
 *   **+0.051, +0.151 and +0.078 ms** added first, and truncated to whole samples;
 * - the next three go straight into the tap gains at `state+0x51c`..`+0x530`;
 * - the last three are applied as `L = (1 - p) * g`, `R = p * g` — a **linear**
 *   pan law, not constant power — whenever the DSP is stereo, which it always is
 *   (`[param+0x40]` is pinned to 2 at `v0x3fce57`).
 *
 * ⚠️ An earlier revision read columns 6-8 as the gains and dismissed 3-5 as
 * "not levels" because 46, -60 and 21 are absurd as gains. They are not absurd:
 * the level they multiply is `10^(slot2/200) / 100`, of order 0.003.
 *
 * ⚠️ **The delay-to-gain pairing is not positional.** `0x1382`-`0x13ef` sorts
 * the three delays and permutes the gains as it goes, and the permutation is not
 * the identity even when nothing needs swapping. All seven rows happen to be
 * sorted ascending already, so the branch taken is always the same one, and it
 * pairs **`d0` with `g1`/`p1`, `d1` with `g0`/`p0`, `d2` with `g2`/`p2`**. That
 * is what `Reverb` implements. If a row ever arrived unsorted the pairing would
 * change, and reading the code that does it will not tell you what was intended.
 */
export const REVERB_EARLY_SETS: readonly (readonly number[])[] = [
  [6.113, 17.041, 29.231, 46, -60, 21, 0.14, 0.855, 0.474275], // 0
  [8.213, 20.043, 53.213, 56, -60, 18, 0.85, 0.15, 0.58], // 1
  [11.057, 17.049, 29.455, -47, 60, 28, 0.12, 1, 0.675], // 2
  [16.011, 30.058, 55.013, 79, -80, 40, 0.82, 0, 0.37], // 3
  [20.013, 29.021, 49.014, 100, -50, 40, 0.625, 0.355, 0.375], // 4
  [36.501, 47.132, 62.022, 100, -50, 40, 0.625, 0.355, 0.375], // 5
  [8.213, 20.043, 53.213, 56, -60, 18, 0.75, 0.85, 0.63], // 6
];

/** Millibels to linear, the engine's own conversion from `v0x3fcd50`. */
export function millibelToLinear(value: number): number {
  return value * 10 > -8000 ? 10 ** (value / 200) : 0;
}

/**
 * How many of a tap row's ten lengths a preset actually uses.
 *
 * The table at `v0xe1d5d0` is **eleven** floats per row, not ten: the first is a
 * count and the other ten are the lengths in milliseconds. `v0x3fc8c0` reads it
 * as `vcvttss2si r9, [row]`, and `fmodsmsreverb.prx` `0x0c12` does the same
 * against its own copy at `v0x2710`.
 */
export const REVERB_TAP_COUNTS: readonly number[] = [
  10, 8, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 10, 10, 9, 9, 10, 10,
];

/**
 * The two ratios the stereo comb pairs are detuned by, at `v0x2bc8`.
 *
 * Exactly two floats. `fmodsmsreverb.prx` `0x109d` indexes this table by the
 * pair index and multiplies the base delay by it, so the second pair's lengths
 * are `0.93 * taps[0]` and `1.06 * taps[1]`.
 *
 * ⚠️ These were called `REVERB_ALLPASS_RATIOS` for several revisions. There is
 * no allpass anywhere in this DSP; the stages they size are combs like all the
 * others, and what they do is decorrelate the left and right tails.
 */
export const REVERB_PAIR_RATIOS: readonly number[] = [0.93, 1.06];

/** The engine's own output rate, hard-coded at `v0x3fce4f` as `[param+0x10]`. */
const ENGINE_RATE = 48000;

/**
 * One damped feedback comb — the kernel at `fmodsmsreverb.prx` `0x09d0`:
 *
 * ```
 * x       = delay.read()
 * acc[i] += x                       ; the RAW delayed sample is what accumulates
 * y       = a*y + b*x               ; damped, inside the loop only
 * delay.write( gain * (y + send) )
 * ```
 *
 * Two details a Freeverb-shaped guess gets wrong, and this project did: the
 * value that leaves the comb is the **undamped** delay output, and the gain
 * multiplies the **input as well as** the recirculation.
 *
 * `a` and `b` are the comb's own copy (`[rec+0x48]`, `[rec+0x44]`), set with
 * its length and never again; `gain` (`[rec+0x4c]`) every configure — see
 * {@link Reverb.reconfigure}.
 */
class Comb {
  private readonly buffer: Float32Array;
  gain: number;
  private readonly a: number;
  private readonly b: number;
  private index = 0;
  private y = 0;
  /** What the last step wrote into the line — all a comb never set up reads. */
  written = 0;

  constructor(lengthSamples: number, gain: number, a: number, b: number) {
    this.buffer = new Float32Array(Math.max(1, lengthSamples));
    this.gain = gain;
    this.a = a;
    this.b = b;
  }

  /** Runs one sample and returns the raw delayed value to accumulate. */
  step(send: number): number {
    const x = this.buffer[this.index];
    this.y = this.a * this.y + this.b * x;
    this.written = this.gain * (this.y + send);
    this.buffer[this.index] = this.written;
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
    return x;
  }
}

/** A plain ring delay: read this sample's taps, then write the input. */
class DelayLine {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(lengthSamples: number) {
    this.buffer = new Float32Array(Math.max(1, lengthSamples));
  }

  tap(back: number): number {
    const n = this.buffer.length;
    const d = back >= n ? n - 1 : back;
    return this.buffer[(this.index + n - d) % n];
  }

  push(value: number): void {
    this.buffer[this.index] = value;
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
  }
}

/**
 * The game's reverb, `fmodsmsreverb.prx`.
 *
 * ## The signal flow, read from the block processor at `0x14e0`
 *
 * ```
 *  in L,R ──┬───────────────────────────────── * dryLevel ─────────────────┐
 *           │                                                              │
 *           ├─► earlyLine ─┬─ tap d0 ─ *(gL,gR) ─┐                          │
 *           │  (fed L + R) ├─ tap d1 ─ *(gL,gR) ─┼─ * earlyLevel ───────────┤
 *           │              └─ tap d2 ─ *(gL,gR) ─┘                          │
 *           │                                                              ▼
 *           └─►(L+R)*0.5 ─► damp ─► notch ─┬─► comb[2..n-1] ──► accL ──┐   out
 *                                          ├─► comb(taps[0])   ──► accL │   L,R
 *                                          ├─► comb(0.93*t0)   ──► accL │
 *                                          │       accR starts as a copy │
 *                                          ├─► comb(taps[1])   ──► accR │
 *                                          └─► comb(1.06*t1)   ──► accR │
 *                                                                       │
 *                                accL,accR ─► delay(slot6 ms) ─► * lateLevel
 * ```
 *
 * Every arrow above is a line of the disassembly:
 *
 * - **the mono downmix**, `(L + R) * 0.5`, at `0x1695`-`0x173e`;
 * - **the input damping one-pole**, `y = a*y + b*x`, at `0x1780`, with `b` at
 *   `[state+0x14]` and `a` at `[state+0x18]` — the same pair every comb uses;
 * - **the notch**, `out = x - (a*y1 + b*x + c*y2)`, in place at `0x1810`, gated
 *   by `[param+0x20]`. It is on the **input**, not the output, and it is what a
 *   long-standing "Schroeder allpass cascade" in this file was actually looking
 *   at;
 * - **`[state+0x510] = tapCount - 2` mono combs** on `taps[2..count-1]`, at
 *   `0x1960`, all accumulating into one buffer;
 * - **`[state+0x514] = 2` stereo pairs**, at `0x1b10` and `0x1c20`: pair 0 is
 *   `taps[0]` into the left accumulator and `taps[1]` into the right, pair 1 is
 *   `0.93*taps[0]` left and `1.06*taps[1]` right. The right accumulator is a
 *   **copy of the left** taken at `0x1a41`, after the mono combs and before the
 *   pairs, and that copy is the whole of the reverb's stereo width;
 * - **the output delay**, `0x1d2a`-`0x1d90` and `0x1e0c`-`0x1e73`: each
 *   accumulator goes into a delay line of `slot6` ms and the delayed value is
 *   what gets `lateLevel`;
 * - **the early reflections**, `0x1ef0`-`0x2051`: two delay lines fed by the raw
 *   L and R input, three taps each, every tap panned by a gain pair and all of
 *   it scaled by `earlyLevel`. Both lines have identical lengths, identical tap
 *   offsets and identical gains, so one line fed `L + R` is exactly equivalent
 *   and is what this uses.
 *
 * ## What is no longer here
 *
 * - **No allpass, and no allpass coefficient.** There is not one in the module.
 * - **No `1 - gain` normalisation on the comb outputs**, and no `/ sqrt(N)`.
 *   The kernel sums the raw delay outputs with nothing in between; the level is
 *   set entirely by `lateLevel` and `earlyLevel`, and both are measured.
 * - **No notch on the wet output.** It is on the input.
 * - **No pre-delay from slot 8.** Slot 8 is the notch frequency; the delay in
 *   the reverb is slot 6, and it sits after the combs rather than before them.
 *
 * ## Checked against the module running
 *
 * `tools/prxrun.py` loads `fmodsmsreverb.prx`, the game's own libc and the
 * eboot, and configures the reverb with the eboot's own code (`v0x3fcc00`, then
 * `v0x3fcd50` and the setparameter callback `v0x3fd3d0` once per preset slot).
 * Fed an impulse away from start-up, all six settings agree with this class to
 * **−111 to −125 dB** of the response; fed steady noise, to −52 to −86 dB, the
 * float32 kernels drifting from these doubles round the feedback. What that
 * run showed, and what it retired:
 *
 * - the early line's shorter two taps arrive late by the ring's rounding (in
 *   the constructor below) — fixed 2026-10-11;
 * - a preset applied after the module has run keeps the first one's lengths —
 *   {@link Reverb.reconfigure}, since 2026-10-11, −106 to −123 dB from the
 *   module on all 36 ordered pairs of settings, where a clean `Reverb` is −4.0 to
 *   +5.6 dB off;
 * - ❌ *not* "a preset change loses 256 frames of late field", as this said: a
 *   re-apply zeroes the input one-pole's and the notch's state and nothing
 *   else, and `reconfigure` does the same;
 * - a comb reads silence until its ring has been written once round, from the
 *   module's first block — not modelled, because the game's first block is
 *   always silent (*SMS Reverb* in steering/lbp-audio-engine.md);
 * - ✔ a comb shorter than a block is *not* a problem: tap set 10's 241-sample
 *   comb agrees like the rest, though this file listed it as a residue.
 *
 * The connection gains are not a question: the two DSPs share one buffer, this
 * one reads lanes 2-3 in place and writes `(dry + wet, dry + wet, 0, 0)` back
 * (`0x2335`-`0x235d`), so unity at both ends is what the game does.
 */
export class Reverb {
  private readonly sampleRate: number;

  // The geometry: lengths, the combs' own damping, the output delay and the
  // early taps. `0x0e22`-`0x14ac`, run only while `[state+2]` lags
  // `[param+2]` -- see `reconfigure`.
  private monoCombs: Comb[] = [];
  private leftCombs: Comb[] = [];
  private rightCombs: Comb[] = [];
  private outDelayL = new DelayLine(1);
  private outDelayR = new DelayLine(1);
  private outDelay = 1;
  private earlyLine = new DelayLine(1);
  /** Tap delays in samples, and the linear-panned gain pair for each. */
  private earlyTaps: { delay: number; gainL: number; gainR: number }[] = [];

  // The coefficients: `0x0b65`-`0x0e08`, on every configure.
  /** `[state+0x510]`: how many mono combs run, `tapCount - 2` of the last preset. */
  private monoCount = 0;
  /** A gain per mono slot, for the slots the geometry never set up. */
  private readonly ghostGains = new Float64Array(8);
  /** This frame's write per mono slot, which is what a slot never set up reads. */
  private readonly written = new Float64Array(8);

  /** The input damping one-pole: `y = a*y + b*x`, `b = 1 - a`. */
  private dampA = 0;
  private dampB = 1;
  private inY = 0;

  private notchOn = false;
  private notchA = 0;
  private notchB = 0;
  private notchC = 0;
  private notchY1 = 0;
  private notchY2 = 0;

  /** Read by the kernel out of the parameter block at every block. */
  dryLevel = 0;
  lateLevel = 0;
  earlyLevel = 0;

  /** Whether a frame has run: the geometry is built by the first one. */
  private ran = false;

  constructor(sampleRate: number, preset: readonly number[]) {
    this.sampleRate = sampleRate;
    this.coefficients(preset);
    this.geometry(preset);
  }

  /**
   * ❗ **What `applyReverbPreset` does to this DSP once it has run: every
   * coefficient changes and no length does.**
   *
   * The plugin's configure `0x0b40` has two halves behind two dirty counters,
   * `[param+0]` against `[state+0]` and `[param+2]` against `[state+2]`
   * (`0x151b`-`0x152d`), and the eboot's configure `v0x3fcd50` bumps exactly
   * one of them: `[param+2]` with its flag set (`v0x3fcfad`), `[param+0]`
   * without (`v0x3fcfb4`). The flag is set by one caller, the create
   * (`v0x3fd23b`); the setparameter callback every preset goes through passes
   * zero (`v0x3fd480`). So the first block after the create builds the
   * geometry from whatever the parameters are by then, and from then on a
   * preset only reaches `0x0b65`-`0x0e08`:
   *
   * - **changed**: the input one-pole's coefficients, and its state zeroed
   *   (`0x0b69`); the notch's coefficients and state, when the new preset has
   *   it on; the number of mono combs that run (`0x0c1d`); every comb's gain,
   *   from the **new** preset's lengths and decay (`0x0d30`, `0x0d90`); the
   *   three levels, which the kernel reads from the parameters every block;
   * - **kept**: every comb's length, its own damping pair (`[rec+0x44]`,
   *   `+0x48`, written only at `0x0e96`), the output delay, and the early
   *   taps' lengths, offsets, gains and pans.
   *
   * ⚠️ **A mono comb the geometry never built still runs** when the new tap set
   * is longer: tap set 16 (`Bright Plate`) has nine lengths, the other five
   * settings' ten. Its ring is zero frames, so `0x670` points its read at its
   * own write (`0x743`), in the scratch buffer it shares with the slot two
   * before it (`0x18c0`, alternate buffers): it adds what that comb wrote
   * this frame, and overwrites it with `gain * send`.
   *
   * Before the first frame the module has not built anything yet, so this is
   * a clean configure — a chain's first song. Checked against the module on
   * all 36 ordered pairs of settings 0-5, and on a preset re-applied every 768
   * frames (*SMS Reverb* in steering/lbp-audio-engine.md); `reverb.test.ts`
   * holds three of them, from `tools/prxrevswitch.py`.
   */
  reconfigure(preset: readonly number[]): void {
    this.coefficients(preset);
    if (!this.ran) this.geometry(preset);
  }

  /** `0x0b65`-`0x0e08`: what every configure rewrites. */
  private coefficients(preset: readonly number[]): void {
    const row = preset[PRESET_SLOT.tapSet];
    const taps = REVERB_TAP_SETS[row] ?? REVERB_TAP_SETS[0];
    const count = Math.min(REVERB_TAP_COUNTS[row] ?? taps.length, taps.length);

    // `[rsi+0x38] * 0.1` at 0x0c5d, and `powf(10, -0.003 * ms / rt60)` at
    // 0x0d30. Both halves come off the writing code; neither is a choice.
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] * 0.1);
    const gainFor = (ms: number) => 10 ** ((-0.003 * ms) / rt60);

    // 0x0b65-0x0ba5: with `[param+0x24]` clear the engine stores `b = 1, a = 0`
    // as one qword, which is a filter that does nothing. 0x0b69 zeroes its state.
    if (preset[PRESET_SLOT.dampEnable]) {
      this.dampA = Math.exp((-2 * Math.PI * preset[PRESET_SLOT.dampHz]) / ENGINE_RATE);
      this.dampB = 1 - this.dampA;
    } else {
      this.dampA = 0;
      this.dampB = 1;
    }
    this.inY = 0;

    // v0x3fce8e-v0x3fcf9f. `r` and `-r*r` are a resonator's pole radius and its
    // square and `a = 2r*cos(w)`; subtracting that resonator from the signal is
    // a notch. 0x0bb1-0x0be1 copies them, and zeroes its state, only when on.
    this.notchOn = preset[PRESET_SLOT.notchEnable] !== 0;
    if (this.notchOn) {
      const raw = preset[PRESET_SLOT.notchHz] / ENGINE_RATE;
      const scaled = raw < 1 / 96 ? raw / 2.2 : raw / 3.3;
      const f = Math.min(0.49, Math.max(0.0004, scaled));
      const r = Math.exp(-10 * Math.PI * f);
      const rr = Math.exp(-20 * Math.PI * f);
      this.notchA = 2 * r * Math.cos(2 * Math.PI * f);
      this.notchC = -rr;
      this.notchB = rr + 1 - this.notchA;
      this.notchY1 = 0;
      this.notchY2 = 0;
    }

    // The mono bank: lengths idx3..idx(n), which are indices 2..count-1 here
    // since these rows already have the count float stripped off the front.
    this.monoCount = count - 2;
    for (let k = 0; k < this.monoCount; k += 1) {
      const comb = this.monoCombs[k];
      if (comb) comb.gain = gainFor(taps[k + 2]);
      else this.ghostGains[k] = gainFor(taps[k + 2]);
    }
    // 0x0d90: the pairs, in the order `geometry` builds them.
    const pairs = [taps[0], taps[1], taps[0] * REVERB_PAIR_RATIOS[0], taps[1] * REVERB_PAIR_RATIOS[1]];
    if (this.leftCombs.length) {
      this.leftCombs[0].gain = gainFor(pairs[0]);
      this.rightCombs[0].gain = gainFor(pairs[1]);
      this.leftCombs[1].gain = gainFor(pairs[2]);
      this.rightCombs[1].gain = gainFor(pairs[3]);
    }

    this.dryLevel = millibelToLinear(preset[PRESET_SLOT.dryLevel]);
    this.lateLevel = millibelToLinear(preset[PRESET_SLOT.lateLevel]);
    this.earlyLevel = millibelToLinear(preset[PRESET_SLOT.earlyLevel]) / 100;
  }

  /** `0x0e22`-`0x14ac`: what only the first block after the create builds. */
  private geometry(preset: readonly number[]): void {
    const sampleRate = this.sampleRate;
    // 0x0ec9-0x0edb: `rate * ms/1000 + 0.5`, then truncate — round to nearest.
    const samples = (ms: number) => Math.max(1, Math.trunc((ms / 1000) * sampleRate + 0.5));

    const row = preset[PRESET_SLOT.tapSet];
    const taps = REVERB_TAP_SETS[row] ?? REVERB_TAP_SETS[0];
    const count = Math.min(REVERB_TAP_COUNTS[row] ?? taps.length, taps.length);
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]] ?? REVERB_EARLY_SETS[0];
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] * 0.1);
    const gainFor = (ms: number) => 10 ** ((-0.003 * ms) / rt60);
    // 0x0e96-0x0ea0: each comb takes its own copy of the input pair.
    const comb = (ms: number) => new Comb(samples(ms), gainFor(ms), this.dampA, this.dampB);

    this.monoCombs = [];
    for (let i = 2; i < count; i += 1) this.monoCombs.push(comb(taps[i]));
    // The two stereo pairs. 0x0f70 sizes pair 0 from taps[0] and taps[1];
    // 0x1090 sizes pair 1 from the same two scaled by REVERB_PAIR_RATIOS.
    this.leftCombs = [comb(taps[0]), comb(taps[0] * REVERB_PAIR_RATIOS[0])];
    this.rightCombs = [comb(taps[1]), comb(taps[1] * REVERB_PAIR_RATIOS[1])];

    // 0x11a9-0x11d0: zero milliseconds still allocates one sample.
    this.outDelay = Math.max(
      1,
      Math.trunc((preset[PRESET_SLOT.outputDelayMs] / 1000) * sampleRate),
    );
    this.outDelayL = new DelayLine(this.outDelay + 1);
    this.outDelayR = new DelayLine(this.outDelay + 1);

    // 0x1254-0x12a1: the fixed offsets, then `vcvttss2si` — truncation, not
    // rounding, unlike every other length in the DSP.
    const perMs = sampleRate / 1000;
    const OFFSETS = [0.051, 0.151, 0.078];
    const nominal = [0, 1, 2].map((i) => Math.max(0, Math.trunc((early[i] + OFFSETS[i]) * perMs)));
    // ❗ **Only the longest tap is read where it says.** The early line is an
    // SPU-style ring of `M` frames (`M` the longest tap) in a buffer rounded up
    // to 1 KB, 256 frames (`0x1400`-`0x1407`): each block is written at the
    // ring's position (`0x590`), the longest tap is read `M` behind it before
    // the write (`0x670`, at `pos + buf - len`), and the other two are read
    // *after* it at `pos + (M - d)` (`0x8f0`, offsets `[state+0x500]` and
    // `+0x504`), which is `buf - (M - d)` behind: `d + (buf - M)`. So the two
    // shorter reflections arrive `buf - M` frames late — 130, 172, 3 and 92 on
    // the early sets the six presets use — measured against the module
    // running (`tools/prxrun.py`).
    const longest = Math.max(...nominal);
    const ring = ((longest * 4 + 0x3ff) & ~0x3ff) / 4;
    const delays = nominal.map((d, i) => (i === nominal.indexOf(longest) ? d : d + ring - longest));
    // The pairing the sort leaves behind for an already-ascending row.
    const PAIRING = [1, 0, 2];
    this.earlyTaps = [];
    for (let i = 0; i < 3; i += 1) {
      const gain = early[3 + PAIRING[i]];
      const pan = early[6 + PAIRING[i]];
      this.earlyTaps.push({ delay: delays[i], gainL: (1 - pan) * gain, gainR: pan * gain });
    }
    this.earlyLine = new DelayLine(Math.max(1, ...delays) + 1);
  }

  /**
   * One stereo frame of the send bus in, one stereo frame of reverb out.
   *
   * The DSP's dry level is a hard zero on every preset the game uses, so what
   * comes back is wet only and is meant to be added to the mix.
   */
  process(left: number, right: number): { left: number; right: number } {
    this.ran = true;
    // Early reflections. One line stands in for the engine's two: both are read
    // at the same offsets with the same gains, so their taps sum to the taps of
    // `L + R`.
    let outL = 0;
    let outR = 0;
    for (let i = 0; i < 3; i += 1) {
      const t = this.earlyTaps[i];
      const x = this.earlyLine.tap(t.delay);
      outL += t.gainL * x;
      outR += t.gainR * x;
    }
    outL *= this.earlyLevel;
    outR *= this.earlyLevel;
    this.earlyLine.push(left + right);

    // The late field's input: mono, damped, notched.
    this.inY = this.dampA * this.inY + this.dampB * (left + right) * 0.5;
    let send = this.inY;
    if (this.notchOn) {
      const y = this.notchA * this.notchY1 + this.notchB * send + this.notchC * this.notchY2;
      this.notchY2 = this.notchY1;
      this.notchY1 = y;
      send -= y;
    }

    let accL = 0;
    const written = this.written;
    for (let k = 0; k < this.monoCount; k += 1) {
      const comb = this.monoCombs[k];
      if (comb) {
        accL += comb.step(send);
        written[k] = comb.written;
      } else {
        // A slot the geometry never built: see `reconfigure`.
        accL += written[k - 2];
        written[k] = this.ghostGains[k] * send;
      }
    }
    let accR = accL;
    for (const comb of this.leftCombs) accL += comb.step(send);
    for (const comb of this.rightCombs) accR += comb.step(send);

    outL += this.lateLevel * this.outDelayL.tap(this.outDelay);
    outR += this.lateLevel * this.outDelayR.tap(this.outDelay);
    this.outDelayL.push(accL);
    this.outDelayR.push(accR);

    // Zero on every preset the game uses, and kept because the engine has it.
    outL += this.dryLevel * left;
    outR += this.dryLevel * right;
    return { left: outL, right: outR };
  }
}

/**
 * The reverb preset table, read out of the eboot at `v0x1062620`.
 *
 * Twelve presets of eleven `int32` slots each. `v0x3fd4c0` pushes slots 1-10
 * into DSP parameters 1-10, reading slots 7 and 9 as booleans; **slot 0 it never
 * touches**, and the constructor at `v0x3fd0d2` pins that slot to **-800** in
 * its private copy, so it is written as -800 here rather than left out. The
 * meanings come from `v0x3fcd50` and are named in `PRESET_SLOT`.
 */
export const REVERB_PRESETS: readonly (readonly number[])[] = [
  [-800, -350, -200, 0, 3, 25, 30, 1, 20, 1, 12000], // 0
  [-800, -350, -200, 0, 3, 25, 30, 1, 20, 1, 12000], // 1
  [-800, -160, -120, 8, 5, 30, 70, 1, 20, 1, 7000], // 2
  [-800, -200, -100, 10, 1, 6, 1, 1, 20, 1, 5000], // 3
  [-800, -350, -300, 4, 2, 25, 60, 1, 20, 1, 5000], // 4
  [-800, -150, -150, 2, 1, 12, 5, 1, 20, 1, 5000], // 5
  [-800, -100, -700, 13, 0, 12, 5, 1, 20, 1, 5000], // 6
  [-800, -160, -200, 18, 5, 25, 10, 1, 400, 1, 3000], // 7
  [-800, -250, -100, 16, 3, 20, 15, 1, 20, 0, 5000], // 8
  [-800, -130, -170, 18, 3, 20, 15, 1, 20, 1, 10000], // 9
  [-800, -240, -200, 2, 1, 10, 10, 1, 20, 1, 8000], // 10
  [-800, -280, -60, 4, 5, 50, 45, 1, 100, 1, 10000], // 11
];

/**
 * `ReverbSetting` -> preset index, from the 8-entry remap at `v0x1062830`.
 *
 * The corpus only ever uses settings 1-5.
 */
export const REVERB_REMAP: readonly number[] = [3, 6, 8, 5, 11, 2, 0, 0];

/** The preset a `ReverbSetting` selects, or the first when it is out of range. */
export function reverbPreset(setting: number): readonly number[] {
  const index = REVERB_REMAP[setting] ?? REVERB_REMAP[0];
  return REVERB_PRESETS[index] ?? REVERB_PRESETS[0];
}

/**
 * **The sequencer's reverb list, in the game's own order and its own words.**
 *
 * Read out of `AddReverbs__` in `gamedata/scripts/tweaksequencer.ff`, which
 * builds the field `TranslatedReverbNames` with exactly six `ARRAY_APPEND`s,
 * each on a `Translate` of one LAMS id; the ids resolve through
 * `gamedata/languages/english.trans`. `tools/ReverbOrder.java` does the walk
 * and steering/lbp-audio-engine.md has the method. So the list is settings
 * 0..5, and the remap's last two entries -- both preset 0 -- are padding that
 * no menu offers.
 *
 * ✔ **Two things confirm the join from the other side.** `Bright Plate` is the
 * one preset whose damping filter is switched off, which is what makes a plate
 * bright; and `Small Room` is the shortest at 0.6 s. Neither came from the
 * names.
 *
 * ⚠️ **The names are not in decay order, and a guess would have got them
 * wrong.** Preset 11 rings for 5.0 s, longer than any other, and it is not the
 * Cathedral -- it is the Big Hall; the Cathedral is preset 2, shorter but with
 * a 70 ms pre-delay, the largest space in the set. This was open question 41,
 * and that is exactly the guess it warned against.
 *
 * ⚠️ Over the corpus's 338 sequencers the setting is 5 on 59.2%, 3 on 35.5%,
 * then 4, 2 and 1, and **0 never once** -- a composer can choose Small Room
 * and none of them did.
 */
export const REVERB_NAMES: readonly string[] = [
  'Small Room',    // 0 -> preset 3
  'Room',          // 1 -> preset 6
  'Bright Plate',  // 2 -> preset 8
  'Hall',          // 3 -> preset 5
  'Big Hall',      // 4 -> preset 11
  'Cathedral',     // 5 -> preset 2
];

/** The settings the game's own menu offers: 0 to 5. */
export const REVERB_SETTINGS: readonly number[] = [0, 1, 2, 3, 4, 5];

/** What a setting is: its name, and what the preset behind it measurably does. */
export interface ReverbSummary {
  readonly setting: number;
  /** What the game calls it, or '' for a setting outside its list. */
  readonly name: string;
  /** The row of `REVERB_PRESETS` the remap sends it to. */
  readonly preset: number;
  /** RT60, in seconds: `decay * 0.1`. */
  readonly decaySeconds: number;
  /** The delay before the late field, in milliseconds. */
  readonly preDelayMs: number;
  /** The damping filter's corner, or null when the preset switches it off. */
  readonly dampingHz: number | null;
  /** The late field's level in dB: the slots are tenths of a dB. */
  readonly lateDb: number;
  /** The early reflections' level in dB, including the preset's own /100. */
  readonly earlyDb: number;
}


export function reverbSummary(setting: number): ReverbSummary {
  const preset = REVERB_REMAP[setting] ?? REVERB_REMAP[0];
  const p = REVERB_PRESETS[preset] ?? REVERB_PRESETS[0];
  return {
    setting,
    name: REVERB_NAMES[setting] ?? '',
    preset,
    decaySeconds: p[PRESET_SLOT.decay] * 0.1,
    preDelayMs: p[PRESET_SLOT.outputDelayMs],
    dampingHz: p[PRESET_SLOT.dampEnable] ? p[PRESET_SLOT.dampHz] : null,
    lateDb: p[PRESET_SLOT.lateLevel] / 10,
    earlyDb: p[PRESET_SLOT.earlyLevel] / 10 - 40,
  };
}

/**
 * The four block kernels of `fmodsmsreverb.prx`, transcribed.
 *
 * They exist out of line at `0x08f0`-`0x0a30` and again inlined in the block
 * processor. `Reverb` runs the same arithmetic one sample at a time; these are
 * kept because they are what a re-check should be compared against, and because
 * each one's *role* was wrong in this file for a long time.
 */

/**
 * `0x0a30`: `out[i] = g0*a[i] + g1*b[i]`, a two-input weighted mix.
 *
 * The block processor uses it for the **stereo-to-mono downmix of the input**
 * with both gains at 0.5 (`0x1695`), which is where the late field's `(L+R)/2`
 * comes from.
 */
export function mixPair(
  a: Float32Array,
  b: Float32Array,
  out: Float32Array,
  g0: number,
  g1: number,
  n: number,
): void {
  for (let i = 0; i < n; i += 1) out[i] = g0 * a[i] + g1 * b[i];
}

/**
 * `0x0910`: a one-pole, `y = a*y + b*x`, written into a second buffer.
 *
 * The block processor uses it once per block on the mono input (`0x1780`), with
 * the same `a`/`b` the combs damp with. The final `y` is written back to the
 * state, so the filter's memory survives the block.
 */
export function onePoleInto(
  buf: Float32Array,
  offset: number,
  a: number,
  b: number,
  y0: number,
  n: number,
): number {
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    y = a * y + b * buf[i];
    buf[i + offset] = y;
  }
  return y;
}

/**
 * `0x0960`: the notch, `out = x - (a*y1 + b*x + c*y2)`.
 *
 * ```
 * prev = y;  y = a*prev + b*buf[i] + c*older;  buf[i] = buf[i] - y;  older = prev
 * ```
 *
 * ⚠️ This was called `allpassSection` and described as "what makes it allpass".
 * It is not an allpass: with `a = 2r*cos(w)` and `c = -r*r` the recursion is a
 * resonator, and subtracting a resonator from the signal is a notch. The block
 * processor runs it in place on the **input** (`0x1810`), never on the output.
 */
export function notchSection(
  buf: Float32Array,
  a: number,
  b: number,
  c: number,
  y0: number,
  older0: number,
  n: number,
): { y: number; older: number } {
  let y = y0;
  let older = older0;
  for (let i = 0; i < n; i += 1) {
    const prev = y;
    const value = buf[i];
    y = a * prev + b * value + c * older;
    buf[i] = value - y;
    older = prev;
  }
  return { y, older };
}

/**
 * `0x09d0`: the damped comb, the only kernel the late field is built from.
 *
 * ```
 * acc[i] += x[i]                       ; the raw delayed sample accumulates
 * y       = a*y + b*x[i]
 * out[i]  = gain * (y + send[i])
 * ```
 */
export function dampedComb(
  x: Float32Array,
  acc: Float32Array,
  send: Float32Array,
  out: Float32Array,
  a: number,
  b: number,
  gain: number,
  y0: number,
  n: number,
): number {
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    const value = x[i];
    acc[i] += value;
    y = a * y + b * value;
    out[i] = gain * (y + send[i]);
  }
  return y;
}
