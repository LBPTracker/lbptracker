/**
 * The voice mixer.
 *
 * Plain TypeScript with no Web Audio in sight, so it runs under `node --test`
 * and under OfflineAudioContext for export, and the AudioWorklet is a thin
 * wrapper around it (packages/lbp-tracker-lib/src/audio/mixer-worklet.ts). Determinism is the point:
 * the same project must render identically on every browser and every run.
 */

import type { EngineChunks } from '../engine-clock.ts';
import type { EngineWalk, Param32, PitchSlot } from '../engine-record.ts';
import { layerRate32, lfoStep32, param32, ratio32, sin32 } from '../engine-record.ts';
import type { Adsr } from '../envelope.ts';
import {
  ADSR_PARAMS,
  ADSR_PARAMS_B,
  ENGINE_DT_END,
  ENGINE_DT_START,
  ENVELOPE_SECONDS_PER_UNIT,
  Envelope,
  evaluateParam,
} from '../envelope.ts';
import type { InstrumentParam } from '../rinstrument.ts';
import { LFO_PARAMS, OUTPUT_PARAMS, echoSendLevel } from '../params.ts';
import type { Interpolator } from './interpolate.ts';
import { INTERPOLATORS, DEFAULT_INTERPOLATOR } from './interpolate.ts';
import type { LfoSettings } from './lfo.ts';
import { LFO_RATE_SCALE, panFold } from './lfo.ts';
import type { FilterSettings } from './moog.ts';
import { FILTER_PARAMS } from './moog.ts';
import type { FilterEnds, Ladder } from './moog.ts';
import {
  FILTER_BYPASS_CUTOFF,
  MoogLadder,
  MoogLadder32,
  filterEnds32,
  ladderCoefficients32Into,
  ladderCoefficientsInto,
  rampStep32,
} from './moog.ts';
import type { LoopSpan, MipChain } from './mipmap.ts';
import { mipLevelFor, readMipped } from './mipmap.ts';

export interface SampleBuffer {
  /**
   * One Float32Array per channel, -1..1.
   *
   * ⚠️ Two channels are read and panned on their own here, which is not what
   * the engine does with a stereo slot: its sampler blends L and R into one
   * value by the note's modulation (`0x38c3`-`0x38e3`) and pans that. None of
   * the game's 216 samples is stereo, so nothing loaded from the game reaches
   * this difference; see *The sampler* in steering/synth-engine.md.
   */
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  /** Half-open, and with the sample's own length when the buffer is longer (`LoopSpan`). */
  readonly loop?: LoopSpan;
  /**
   * Optional per-channel mip chains from `buildMipChain`.
   *
   * **When present the voice reads through `readMipped`, which is the engine's
   * own sampler** -- linear, with the source swapped for a pre-decimated copy
   * above pitch ratio 2 and 4. Without them the voice uses the `Interpolator`
   * passed to the mixer, which is our reference path and stays available for
   * A/B. The two differ slightly at the loop wrap; `readMipped` documents how
   * and why they converge on real material.
   */
  readonly mips?: readonly MipChain[];
  /**
   * The same sample with its loop smoothed (`smoothLoop` in `wav.ts`), for the
   * few `LOOP_SMOOTHING` lists. **Ours**: a voice reads it instead of
   * `channels` and `mips` only with `declick`, so without it the engine's own
   * sample plays.
   */
  readonly smoothed?: {
    readonly channels: readonly Float32Array[];
    readonly mips?: readonly MipChain[];
  };
}

/**
 * One control point of a note's automation.
 *
 * The engine holds a note's pitch, volume and pan as **(value, slide) pairs**
 * and rewrites both at every control point, so a note glides linearly from one
 * point to the next -- see `0x3930`. That glide is the sequencer's pitch
 * bend, and it is not a rare flourish: **53.9% of the corpus's 2,027,633 notes
 * carry more than one control point**, and 6.7% bend in pitch, by up to 95
 * semitones.
 */
export interface AutomationPoint {
  /** Frames from the voice's start. */
  readonly frame: number;
  /**
   * On the engine's clock: the frame, from the voice's start, of the walk that
   * makes this point the record's -- the end of the chunk that crossed it.
   *
   * ✔ The engine's slides change only at a walk (`0x3930` writes `+0x08`,
   * `+0x0c`, `+0x28` and their slides), and a chunk evaluates both its ends
   * on the record it starts with (`0x1d8c`, `0x1e2c`), so the chunk that
   * crosses a point runs the old slide PAST it -- a glide of 24 semitones in
   * a step ends that chunk at 51.16 for 51 -- and the next starts on the
   * point's own value. Set, `Voice` does the same; unset, a segment's ends
   * are read off the polyline, the tracker's clock.
   */
  readonly from?: number;
  /**
   * Semitones relative to the note's base pitch.
   *
   * ⚠️ Interpolated **linearly in semitones**, not in playback rate. The engine
   * ramps `voice.pitch` and only then feeds it to `exp2f`, so a bend is
   * exponential in rate; linear-in-rate would sag in the middle of every glide.
   */
  readonly pitch: number;
  /** Linear gain relative to the note's base volume. */
  readonly gain: number;
}

/**
 * The waveshaper's coefficient, `k = 2d / (1 - d)`.
 *
 * **Measured**, `fmodextinput.prx` `0x1ee0`-`0x1f33`:
 *
 * ```
 * 0x1ee0  d  = broadcast([voice + 0x20])      ; Params[26], already clamped 0..1
 * 0x1ee7  d  = min(d,  0.95)                  ; and this is what keeps 1 - d
 * 0x1eef  d  = max(d, -0.95)                  ; off zero
 * 0x1ef7  a  = d * 2
 * 0x1f07  b  = 1 - d
 * 0x1f0b  r  = vrcpps(b), one Newton step     ; 2r - b*r*r, at 0x1f0f-0x1f1b
 * 0x1f1f  k  = a * r = 2d / (1 - d)
 * ```
 *
 * ⚠️ The engine reciprocates with `vrcpps` plus one Newton-Raphson step rather
 * than dividing. That lands within an ulp of a true divide and there is no way
 * to reproduce `vrcpps`'s 12-bit seed from JavaScript, so this divides. It is
 * the one place in the shaper that is not bit-exact, and it is smaller than the
 * float rounding either side of it.
 */
export function driveCoefficient(drive: number): number {
  const d = Math.min(Math.max(drive, 0), 0.95);
  return (2 * d) / (1 - d);
}

/**
 * The engine's soft clip, `f(x) = (1 + k)x / (1 + k|x|)`.
 *
 * **Measured**, the per-layer loop at `0x2cab`-`0x2cf1`, applied to whatever the
 * sampler at `0x3780` returned:
 *
 * ```
 * 0x2cab  |x|                                 ; vandps against the sign mask
 * 0x2cc0  k * |x|
 * 0x2cc4  1 + k*|x|
 * 0x2ccc  its reciprocal, vrcpps + a Newton step again
 * 0x2ce5  (1 + k) * x                         ; 1 + k precomputed at 0x2b4d
 * 0x2cf1  (1 + k) * x / (1 + k*|x|)
 * ```
 *
 * ⚠️ **`k = 0` is an exact bypass** -- `f(x) = x` with no rounding -- which is
 * why the 59 instruments that leave `Params[26]` at zero render identically with
 * this in the chain.
 *
 * ✔ **Where it sits is measured.** `0x2c88` calls the sample read, the shaper
 * runs on its result, and `0x2d0d`/`0x2d25` then apply the gain and the pan --
 * per layer, inside the per-sample loop. The ladder is nowhere in that loop:
 * it runs afterwards on the record's summed and clipped L/R (`0x2e00`,
 * `0x31c0`), so the order is sample → drive → gain → pan → sum → clip → ladder,
 * and `Voice` keeps it.
 */
function softClip(x: number, k: number, onePlusK: number): number {
  return (onePlusK * x) / (1 + k * (x < 0 ? -x : x));
}

/**
 * One unison layer of a voice, as the stack loop at `0x1a70` leaves it in the
 * record: a detune ratio (`+0x68 + 4i`), a pan offset already summed with the
 * clip's own pan (`+0x7c + 4i`), a start position (`+0x40 + 8i`) and, through
 * the fan, where each of the three LFO phases sits for this layer.
 */
export interface LayerSpec {
  /**
   * `1 + 0.05 · U(−r, +r)` from `Params[0]`, a ratio near 1. Default 1.
   *
   * Kept apart from the rate because LFO 1 rides on it the engine's way --
   * `rate = ratio · (detune + 0.05 · depth · sin)` (`0x27b5`) -- so the
   * vibrato's depth is not scaled by the detune.
   */
  readonly detune?: number;
  /** `clipPan + spread`, unclamped: the voice folds it as the engine does. */
  readonly pan: number;
  /** Sample frame to begin at. Layer 0's is always 0 in the engine (`0x1bda`). */
  readonly startPosition?: number;
  /** Absolute LFO phases, the record's base plus this layer's fan. */
  readonly lfoPhase?: readonly [number, number, number];
}

/**
 * What a record holds that its voice needs to run its rate as the module
 * does (`engine-record.ts` has the arithmetic and why it matters).
 *
 * Per chunk, `0x1c60` reads the last walk's values and slides at the chunk's
 * two ends, `t` being the float32 playhead's fraction there less the spawn's
 * sub-step until the first walk (`0x1ce7`-`0x1d03`): the pitch as
 * `f(t · slide) + pitch` (`0x1d8c`, `0x1e2c`), the volume and modulation the
 * same at the start and plus `f(dt · slide)` at the end (`0x1ec0`-`0x1f59`,
 * `0x20ae`). The three LFO phases are float32 too, never wrapped, each layer
 * the base plus the chunk's fan added once per layer (`0x287b`-`0x28bb`).
 */
export interface EngineRecord {
  /** The spawn's values first, then one row per walk to the one that closes the gate. */
  readonly walks: readonly EngineWalk[];
  /** `+0x3e · ⅓`, the spawn's sub-step: `t` is measured from it until the first walk clears it (`0x3969`). */
  readonly startThird: number;
  readonly slot: PitchSlot;
  /** A render's `pitchShift` on top, which the engine does not have. 1 normally. */
  readonly shift: number;
  /** The instrument's `Params`, for the LFOs' rates, depths and fans, and the filter's ends. */
  readonly params: readonly (Param32 | undefined)[];
  /** The render's `noKeyTrack` A/B, which `params` still carries. */
  readonly noKeyTrack?: boolean;
  /** `+0x98`, `+0x9c`, `+0xa0` at the spawn. */
  readonly lfoPhases: readonly [number, number, number];
  /**
   * The ladder itself in double, with everything around it -- envelope B, the
   * two ends, the float32 ramp -- still the module's: what the live player
   * plays. The float32 ladder is +60% of a render for at most 11.6 dB, all of
   * it below -107 dB of the module (*The filter* in steering/synth-engine.md);
   * the worklet cannot spare that, the offline render can.
   */
  readonly ladder64?: boolean;
}

export interface VoiceSpec {
  readonly sample: SampleBuffer;
  /**
   * Sample frames advanced per output frame: the record's own ratio, before
   * any layer's detune. Also what the filter's key tracking follows.
   */
  readonly playbackRate: number;
  readonly gain: number;
  /**
   * 0 = hard left, 0.5 = centre, 1 = hard right -- and past either wall it
   * turns back, through the same triangle fold LFO 3 uses (`0x25fe`-`0x2657`).
   */
  readonly pan: number;
  /** Output frame at which this voice starts. Lets a block schedule sample-accurately. */
  readonly startFrame?: number;
  /**
   * The engine's chunks, when the render runs its clock
   * (`RenderOptions.engineClock`): the voice's first frame on that clock's
   * frame axis, and every chunk start there that is not a 256-frame block's.
   *
   * Set, the voice's segments are the engine's chunks for its whole life --
   * the song's blocks, cut where the step clock cut them, and a gate closed at
   * a split chunk followed by the rest of that block -- instead of a grid of
   * its own that starts again at the gate. A record's ramps are straight lines
   * between its chunk ends, so a steep glide sampled at other ends drifts in
   * phase. Unset, the tracker's grid, *60* in steering/answered-questions.md.
   */
  readonly engineGrid?: {
    readonly origin: number;
    readonly splits: readonly number[];
    /** The clock's chunks and float32 playheads, which `engine` reads its slides off. */
    readonly chunks?: EngineChunks;
  };
  /**
   * The record's own float32 arithmetic, on the engine's clock -- with
   * `engineGrid.chunks`, the voice takes its pitch, volume and modulation from
   * these walks and the chunk's playhead instead of `automation` and
   * `morph.points`, and forms every layer's rate the module's way. Unset, the
   * double-precision voice of the tracker's clock (`engineClock: false`) and
   * of the keyboard bench.
   */
  readonly engine?: EngineRecord;
  /** Output frame at which it stops, or undefined to run to the end of the sample. */
  readonly endFrame?: number;
  /**
   * Output frame at which this voice is **taken away**, whatever it is doing.
   *
   * ⚠️ Not the same thing as `endFrame`, and the difference is the whole
   * point. `endFrame` closes the note's gate -- the envelope releases, and a
   * one-shot ignores it entirely, because a drum hit is not shortened by how
   * long the note was written. `cutFrame` is the engine's allocator handing this
   * voice's record to a later note: `fmodextinput.prx` 0x1640 returns a record
   * and the caller overwrites it, so whatever was playing there stops mid-sample
   * with no release. A one-shot cannot ignore that one.
   *
   * Leaving it out is what let a stolen one-shot keep sounding. On `Ascetic`
   * that is `mime_artist` -- five stack layers of a loopless 9,142-frame vocal,
   * played at rate 0.02 because the note sits 68 semitones under the sample's
   * base note, so each note occupied five of the engine's 32 voices for **9.5
   * seconds** and none of them ever went away.
   */
  readonly cutFrame?: number;
  /**
   * Soften three clicks the engine makes. **Ours, not the game's**,
   * and off here, so a bare `VoiceSpec` is the engine's; `renderSequencer`
   * turns it on by default (`RenderOptions.declick`).
   *
   * 1. The amplitude release lasts at least {@link DECLICK_SECONDS}. The
   *    engine ramps a shorter one across one chunk, 5.3 ms, and on a low note
   *    that is less than a cycle: `triangle_wave`'s 0.8 ms release clicks on
   *    the octaves under *Rhombitruncated*'s intro.
   * 2. After the sound ends -- the release reaches zero, the note's volume
   *    does, or an unlooped sample runs out -- the ladder's output fades over
   *    the same time instead of stopping. The engine frees the record
   *    (`0x3093`) with the ladder's ten states as they were, so a ladder that
   *    envelope B has shut holds a value that drops to zero in one frame:
   *    `e_perc_1`'s bongo, 96 of its 181 transients over that song.
   * 3. A loop that ends on its sample's last frame reads no frame of silence
   *    at its first wrap (`readMipped`'s `gapless`): on `harp_fsharp4` that
   *    frame clicked on every note from 49 to 64.
   *
   * A steal (`cutFrame`) is untouched: a record handed to another note is
   * taken mid-sample in the engine and here. *61* in
   * steering/open-questions.md has the decision and what would settle it.
   */
  readonly declick?: boolean;
  /**
   * `Params[26]`, the **drive**, 0..0.95 -- a soft-clip waveshaper on the
   * sampler's output. 0 is a bypass, exactly.
   *
   * See `driveCoefficient`. Nine of the game's 68 instruments set it, and for
   * `e_guitar_power` (0.731) and `e_guitar_distorted` (0.570..0.700) it is the
   * whole character of the patch.
   */
  readonly drive?: number;
  /**
   * Frames for which a one-shot's gate is held open regardless of the note.
   *
   * ✔ **0 is the engine's answer.** It gates every voice, loop or no loop --
   * `0x1f65` hands the gate flag to the envelope with no branch on the loop --
   * and a recording of the game agreed in eight blocks out of eight
   * (2026-09-03). `Infinity` and the sample's own length are the two rules this
   * project believed first, kept behind `RenderOptions.oneShot` for an A/B;
   * `holdFramesFor` in `packages/lbp-tracker-lib/src/render.ts` builds them.
   */
  readonly holdFrames?: number;
  /**
   * Frames of linear fade before `endFrame`, for a voice with no `envelope`.
   *
   * ⚠️ Not the game's: its release is `Params[14]`, through `envelope`, and it
   * has no fade beside it. This is a stand-in for a caller playing a bare
   * sample -- a looping one never runs out on its own, and a voice simply cut
   * at `endFrame` leaves a step and clicks. Ignored when `envelope` is present.
   */
  readonly release?: number;
  /**
   * Exponential decay in dB per second, applied from the voice's start.
   *
   * ⚠️ **Not the game's -- ours, and a diagnostic**, kept for the loop-flutter
   * measurement in `steering/game-assets.md`: a shipped loop's own amplitude
   * contour repeats at the wrap rate, and a decay suppresses it. Ignored when
   * `envelope` is present; leave it at 0 for faithful output.
   */
  readonly decayDbPerSecond?: number;
  /**
   * The instrument's ADSR, from `evaluateAdsr`.
   *
   * **When present this is what shapes the note, and `release` and
   * `decayDbPerSecond` are ignored** -- those two were stand-ins for exactly
   * this, invented while `Params` was unread. A voice with an envelope also
   * outlives its `endFrame`: that frame closes the gate and the release runs
   * on from there, which is what stops a held note ending in a step.
   */
  readonly envelope?: Adsr;
  /**
   * The instrument's low-pass, from `Params[3..10]`.
   *
   * `settings` are the static knobs and `envelope` is the **second** ADSR,
   * which exists to sweep the cutoff. Most acoustic instruments leave the
   * filter wide open and can omit this entirely; it is what makes the synth
   * patches -- `saw_wave`, `robot`, `e_guitar_distorted`, the drum kits --
   * sound like themselves rather than like their raw samples.
   */
  readonly filter?: {
    readonly settings: FilterSettings;
    readonly envelope: Adsr;
  };
  /**
   * The instrument's three LFOs, `Params[15..23]`, in engine order: **pitch,
   * gain, pan**. A depth of zero leaves its destination untouched, which is
   * what 62 or more of the game's 68 instruments choose for each.
   *
   * Their phases are randomised per voice, so two notes of the same instrument
   * modulate differently -- pass `random` to make a render reproducible.
   */
  readonly lfos?: readonly [LfoSettings, LfoSettings, LfoSettings];
  /**
   * The note's control points, in frame order and relative to its start.
   *
   * A single point, or none, means a flat note. Anything past the last point
   * holds its value, which is what the engine does when it runs out of records.
   */
  readonly automation?: readonly AutomationPoint[];
  /**
   * The note's modulation ramp, and the `Params` it feeds.
   *
   * ⚠️ **The modulation is not a per-voice constant, and treating it as one is
   * wrong on 3.6% of notes.** It is `voice+0x28` in the engine, the value that
   * picks a point inside every one of the 27 `Params` ranges, and
   * `fmodextinput.prx` ramps it exactly as it ramps volume and pitch:
   * `sub_0x3930` writes its slide rate at `0x3e8a` beside the other two, and
   * `sub_0x1c60` -- the per-voice renderer, called once per chunk per voice
   * under the DSP read callback -- advances it at `0x1f4a` and re-reads the
   * result four times to re-derive the parameters. See
   * `steering/answered-questions.md` 6d.
   *
   * 34,449 corpus notes move it, and on 30,170 of them (87.6%) that moves some
   * parameter by 0.35 or more; the widest measured swings are cutoff 0.906,
   * resonance 0.892, level 0.591, drive 0.390. 26 of the 27 parameters move on
   * some note. So this is not a garnish and it cannot be done for a chosen few.
   *
   * Absent means flat, which is what 96.4% of notes are, and a voice without it
   * takes byte-for-byte the path it took before this existed.
   */
  readonly morph?: {
    readonly params: readonly InstrumentParam[];
    /** Modulation at each control point, in frames from the voice's start. */
    readonly points: readonly {
      readonly frame: number;
      readonly value: number;
      /** As `AutomationPoint.from`. */
      readonly from?: number;
    }[];
    /**
     * The placement's echo send as the engine's bipolar offset, `2*send - 1`.
     *
     * ❗ The echo send is the only send the modulation touches:
     * `voice+0x1c = clamp01(bipolar(Params[25], 2*echoSend - 1))`, where
     * `Params[25]` is the instrument's own and the placement's field bends it.
     * The reverb is `reverbSend` alone and never moves. See the sends note in
     * `packages/lbp-tracker-lib/src/render.ts`.
     */
    readonly echoOffset: number;
    /**
     * `Params[level]` at the modulation the spec's `gain` was built with.
     *
     * ❗ The gain carries the track level, the channel volume, the headroom,
     * the velocity and the stack correction as well, and none of those may move.
     * So the level travels as a RATIO against this, which is the only factor of
     * the product the modulation owns.
     */
    readonly opening: number;
    /**
     * The render's `noKeyTrack` A/B, which the modulation must not undo.
     *
     * ⚠️ Not inferred from the spec's `keyTrack` being 0: an instrument whose
     * key tracking is 0 at the opening modulation and rises with it (`robot`,
     * 0 to 1) is not an A/B, and holding it at 0 cost that glide +1.8 dB
     * against the module.
     */
    readonly noKeyTrack?: boolean;
    /**
     * The modulation the drive and the echo send are taken at, from each frame
     * on: one step behind `points`, and held across the step.
     *
     * ✔ Neither is evaluated by the chunk. `0x3930`, which the sequencer's walk
     * calls for every record at every whole step (`0x0e8d`-`0x0eef`), computes
     * `voice+0x1c` (`Params[25]`, `0x3b54`) and `voice+0x20` (`Params[26]`,
     * `0x3b93`) from `voice+0x28` as the PREVIOUS call left it, and only then
     * writes this step's modulation there (`0x3c81`, `0x3eff`); `0x19e0` seeds
     * it with the first record's (`0x1a1a`). The chunk reads both as constants
     * (`0x1ee0`, `0x2f3f`). Absent, the segment's start modulation is used.
     */
    readonly held?: readonly { readonly frame: number; readonly value: number }[];
  };
  /**
   * How much of this voice goes to the echo and reverb buses, 0..1.
   *
   * ✔ **Two buses, and both are measured** (`0x2f3f`-`0x2f89`, and again at
   * `0x3320`-`0x336a` on the filtered path): the record's post-pan L/R goes to
   * the DSP's lanes 2-3 times `voice+0x24` -- the reverb send, the placement's
   * `reverbSend` alone -- and to the echo's own stack buffer times `voice+0x1c`,
   * the instrument's `Params[25]` bent by the placement's `2*echoSend - 1`.
   * Both are post-fader, post-pan and post-filter. The echo's wet then feeds
   * the reverb send as well; that join is the caller's (`render.ts`,
   * `mixer-worklet.ts`). 22% and 55% of the corpus's placements set them.
   */
  readonly echoSend?: number;
  readonly reverbSend?: number;
  /** Injected so an offline render can be deterministic. */
  readonly random?: () => number;
  /**
   * Sample frame to begin at, rather than 0.
   *
   * `Params[2]` gives each layer of a stacked voice its own random start,
   * `startOffset * sampleLength * U(0, 1)` frames in, which is what stops the
   * layers from being one louder copy of each other.
   *
   * ❗ **Layer 0 always starts at 0**, whatever `Params[2]` says: the engine
   * draws its offset with the others and then throws it away at `0x1bda`. See
   * `packages/lbp-tracker-lib/src/render.ts`.
   */
  readonly startPosition?: number;
  /**
   * Each LFO's start phase in radians, one per LFO — **absolute**, not an
   * offset.
   *
   * The engine draws one base phase per voice *record* and fans a stacked
   * voice's layers off it by `Params[17|20|23]` times `2 * PI / Numstack` per
   * layer, so the layers sit at different points of the same cycle rather than
   * at three independent random ones. Both halves of that are the caller's to
   * compute; {@link Lfo} takes what it is given. When this is absent the mixer
   * draws `U(0, 2*PI)` per LFO from {@link random}.
   */
  readonly lfoPhase?: readonly [number, number, number];
  /**
   * The unison stack -- `Numstack` layers sharing this record.
   *
   * ❗ **One `VoiceSpec` is one of the engine's 32 records, and a record plays
   * every layer of its note**: the per-sample loop at `0x2b70`-`0x2df9` runs
   * once per layer into ONE interleaved L/R accumulator, and what follows --
   * the ±1 clip at `0x2e00`, the two ladders at `0x31c0`, the sends -- runs on
   * the sum. Absent, the spec's own `pan`, `startPosition` and `lfoPhase`
   * describe a single layer at detune 1.
   */
  readonly layers?: readonly LayerSpec[];
  /**
   * A caller's handle on this voice, for {@link Mixer.release}.
   *
   * A sequencer never needs one -- every note it plays already knows when it
   * ends -- but a keyboard does: the note lasts until the key comes up, and
   * that moment is not known when the voice starts. Untagged voices are
   * unaffected by `release`, so nothing that does not ask for this changes.
   */
  readonly tag?: number;
}

/**
 * The engine's DSP block, in frames.
 *
 * ✔ **256, and it is measured.** `fmodextinput.prx`'s DSP read callback at
 * `0x0170` asserts its length is a multiple of 256 (`test r14b, r14b` then
 * `int 0x41`) and calls the block function `0xa90` with **`mov esi, 0x100`** --
 * a fixed 256 frames per call, looping over the callback's length. Inside it
 * the per-voice renderer `0x1c60` runs once per chunk, and a chunk is a block
 * or the part of one up to the next bound of the step clock (`0x0bf2`, *3* in
 * steering/answered-questions.md).
 *
 * Everything the renderer derives, it derives **twice per chunk** -- at the
 * chunk's start and at its end -- and ramps across: the envelope (`0x203f`,
 * `0x2089`), the pitch ratio (`0x1dc2`, `0x1e63`), every LFO (six `call 0x130`
 * at `0x24a0`-`0x28e3`, two per oscillator) and the filter's cutoff and
 * resonance. The per-sample loop then steps the rate, the gain and the pan by
 * their per-frame increments (`0x2d5d`, `0x2d78`, `0x2d8f`). A `Voice` does the
 * same over a *segment*: a block of the voice's own grid, cut short where its
 * gate, its cut or its caller's buffer end.
 *
 * ❗ **On the engine's clock, the default, the grid is the song's chunks**
 * (`VoiceSpec.engineGrid`) and the paragraph below is the tracker's clock's
 * and the keyboard bench's. ❗ **There the grid starts at the note's first
 * frame and starts again where its gate closes**, because those are the two events the engine only ever takes
 * at the top of a chunk: a note found by the walk after one chunk (`0x0eef`,
 * `0x0f1c`) renders from the next chunk's first frame (`0x1cc6`, the onset
 * offset that is always 0), and a gate closed by the walk (`0x3a4b`) or at a
 * chunk's end (`0x29b1`) is read once, at the next chunk's top (`0x1f65`). So
 * a stage shorter than a chunk -- `triangle_wave`'s 0.8 ms release, its 0.3 ms
 * attack -- is ramped across the whole chunk after the event, 5.3 ms, and
 * never clicks. ❌ Until 2026-10-05 the grid was the mixer's running clock:
 * with onsets and gates placed to the frame (the tracker's clock, *3 / 3b*
 * in steering/answered-questions.md) that made the ramp after an event as long as
 * the distance to the next block boundary, 1 to 256 frames, and short notes
 * clicked at both ends.
 *
 * ⚠️ **The grid is counted in the voice's own rendered frames, not from the
 * start of one `render` call**: a live render of 128 frames at a time and an
 * offline render of a whole song must evaluate on the same boundaries, and a
 * segment is evaluated once whoever slices it.
 * `packages/lbp-tracker-lib/test/audio.test.ts` pins "the same audio whatever
 * the block size".
 *
 * ⚠️ The engine also splits a block where the step clock's `frac(4 ·
 * position)` bound falls (`0x0bf2`), which this mixer does not know, so its
 * chunk after a note's end is sometimes shorter than a block where this one's
 * never is -- how often is the chunk-bounds residue in
 * steering/open-questions.md.
 */
export const BLOCK_FRAMES = 256;

/**
 * The shortest amplitude release, and the length of the fade on a ladder's
 * tail, when `VoiceSpec.declick` is on: 20 ms, the release at which the
 * project's owner stopped hearing `triangle_wave` click (2026-10-05).
 */
export const DECLICK_SECONDS = 0.02;

/** What one segment of a voice wrote, and the sends that were live for it. */
interface RenderedSpan {
  readonly begin: number;
  readonly end: number;
  readonly echo: number;
  readonly reverb: number;
}

/**
 * The echo send at a given modulation.
 *
 * `clamp01(bipolar(Params[25], offset))` — the instrument's own send bent by
 * the placement's field, which the engine stores as `2*echoSend - 1` so that
 * 0.5 leaves the instrument alone, 0 mutes it and 1 forces unity
 * (`echoSendLevel`). `packages/lbp-tracker-lib/src/render.ts` builds the opening value.
 */
function echoAt(morph: NonNullable<VoiceSpec['morph']>, mod: number): number {
  return echoSendLevel(evaluateParam(morph.params[OUTPUT_PARAMS.send] ?? { x: 0, y: 0 }, mod), morph.echoOffset);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const ZERO_PARAM: InstrumentParam = { x: 0, y: 0 };

/**
 * Everything the note's modulation picks out of the instrument, at one value
 * of it.
 *
 * Mutable and reused: a voice fills two of these per segment -- at the start
 * modulation and at the end one, which is what the renderer does with `xmm7`
 * and `xmm15` -- and allocating on the audio thread every 256 frames per voice
 * is what the reuse avoids. A voice with no `morph` fills one from its spec
 * and reads it for both ends.
 */
class Derived {
  readonly adsr = { attack: 0, decay: 0, sustain: 1, release: 0 };
  readonly adsrB = { attack: 0, decay: 0, sustain: 1, release: 0 };
  readonly filter = { cutoff: 1, resonance: 0, keyTrack: 0, envAmount: 0 };
  readonly lfoRate = [0, 0, 0];
  readonly lfoDepth = [0, 0, 0];
  /**
   * Radians per layer that the LFO fan has moved since the note's spawn: the
   * layer's `phase` already holds the fan at the opening modulation.
   */
  readonly lfoFan = [0, 0, 0];
  drive = 0;
  /** `Params[24]` as a ratio against the level the spec's `gain` was built with. */
  level = 1;
  echo = 0;
}

/**
 * One layer of a voice, with the three ramps the sample loop steps.
 *
 * The rate, the gain and the pan are each a `{value, step}` pair exactly as the
 * engine keeps them on its stack (`rbp-0x1c0`, `rbp-0xd0`, `rbp-0x170`): set at
 * the segment's start from its two evaluations, stepped once per frame.
 */
class Layer {
  /** Playback position in level-0 sample frames -- the engine's `+0x40 + 8i` double. */
  position: number;
  readonly detune: number;
  readonly basePan: number;
  /** Absolute LFO phases at the note's start: the record's base plus this layer's fan. */
  readonly phase: readonly [number, number, number];
  rate = 0;
  rateStep = 0;
  gain = 0;
  gainStep = 0;
  pan = 0;
  panStep = 0;

  constructor(spec: LayerSpec, draw: () => number) {
    this.position = spec.startPosition ?? 0;
    this.detune = spec.detune ?? 1;
    this.basePan = spec.pan;
    const p = spec.lfoPhase;
    // Drawing here is the fallback for a caller with no opinion; the render
    // draws one base per note and fans it, and hands the result over.
    this.phase = [
      p?.[0] ?? draw() * 2 * Math.PI,
      p?.[1] ?? draw() * 2 * Math.PI,
      p?.[2] ?? draw() * 2 * Math.PI,
    ];
  }
}

/**
 * One of the engine's records: a note, every layer of it, rendered the way
 * `0x1c60` renders it.
 *
 * Per segment (a block of the mixer's grid, or less), in this order:
 *
 * 1. **Evaluate twice**, at the segment's first frame and at the frame after
 *    its last -- the modulation, the two envelopes, the pitch, the three LFOs
 *    at their phase and at their phase plus the segment's increment -- and turn
 *    each layer's rate, gain and pan into a value and a per-frame step.
 * 2. **Per frame, per layer**: read the sample through the engine's sampler,
 *    drive it, scale it, pan it into one L/R accumulator (`0x2c40`-`0x2db7`),
 *    and step the three ramps.
 * 3. **Clip the accumulator to ±1** (`0x2e00`-`0x2e2d`).
 * 4. **The two ladders**, one on L and one on R (`0x31c0`-`0x33cb`), unless the
 *    cutoff at the segment's start is past `FILTER_BYPASS_CUTOFF`.
 * 5. Add to the output; the sends are the caller's, from the span this reports.
 *
 * ❗ The filter therefore comes *after* the gain, the pan and the sum of the
 * layers, and there is one pair of it per note, not one per layer. That is what
 * the ten state floats at `+0xa4`..`+0xc8` of a record are, and a ladder with a
 * cubic in its loop is not a thing that can be moved across a sum.
 */
class Voice {
  readonly spec: VoiceSpec;
  readonly layers: readonly Layer[];
  /** Output frames still to wait before this voice starts. */
  delay: number;
  /** Output frames remaining before the gate closes, or Infinity. */
  life: number;
  /** Frames until the allocator takes this voice away; Infinity if it never does. */
  cut: number;
  /** Frames of forced gate left on a one-shot. */
  hold: number;
  /** Frames of linear fade at the end of that life -- ours, for a voice with no envelope. */
  private readonly release: number;
  /** Per-frame multiplier for the optional decay, or 1 -- ours, a diagnostic. */
  private readonly decayPerFrame: number;
  private decayGain = 1;
  private readonly env = new Envelope();
  // The filter envelope and one ladder per channel -- the engine keeps two,
  // which is what its ten per-record state floats are.
  private readonly filterEnv = new Envelope();
  private readonly ladderL: Ladder;
  private readonly ladderR: Ladder;
  /**
   * On the engine's clock the filter is the module's float32 throughout:
   * envelope B (`Envelope.advance32`), the two ends (`filterEnds32`), the ramp
   * (`rampStep32`) and the ladder (`MoogLadder32`). Off it, the same formulas
   * in double -- *The filter* in steering/synth-engine.md has why.
   */
  private readonly filter32: boolean;
  /** `filter32` with the module's own ladder and coefficients: see `EngineRecord.ladder64`. */
  private readonly ladder32: boolean;
  private readonly secondsPerFrame: number;
  /** Frames rendered since this voice started: the automation's clock. */
  private elapsed = 0;
  /**
   * The `elapsed` frame its segment grid counts from: 0, and then the frame
   * at which the gate was first found closed. See {@link BLOCK_FRAMES}.
   */
  private gridOrigin = 0;
  private gateOpen = true;
  /** `VoiceSpec.declick`: the release floor in seconds and the tail in frames, or 0. */
  private readonly minRelease: number;
  private readonly tailFrames: number;
  /** Frames of the ladder's faded tail still to render; see `beginTail`. */
  private tailLeft = 0;
  private tailGain = 0;
  private tailStep = 0;
  /**
   * Radians each LFO has advanced since the note started, shared by the layers.
   *
   * The record stores three phases and advances them once per chunk
   * (`0x28f1`-`0x293b`); a layer's phase is that plus its fan, which is in
   * `Layer.phase`. Keeping the advance apart from the fan is what lets one
   * increment serve every layer.
   */
  private readonly lfoAcc = [0, 0, 0];
  private readonly fixed = new Derived();
  private readonly startD = new Derived();
  private readonly endD = new Derived();
  /** Frames left in the segment being rendered; 0 asks for a new one. */
  private segLeft = 0;
  private bypass = true;
  private rampFilter = false;
  private freq = 0;
  private freqStep = 0;
  private res = 0;
  private resStep = 0;
  private readonly coefficients = { p: 0, f: 0, q: 0 };
  private readonly filterEnds: FilterEnds = { freqS: 0, freqE: 0, resS: 0, resE: 0 };
  private driveK = 0;
  private driveOnePlusK = 1;
  private curEcho: number;
  private readonly curReverb: number;
  /**
   * Whether this voice can ever reach a send bus.
   *
   * ⚠️ **A morphing voice's echo send may start at zero and rise**, so the
   * opening values are not enough to decide whether the buses are needed. This
   * is the largest the echo gets anywhere along the note's own ramp.
   */
  readonly maySend: boolean;
  /** Set when the sound has ended: layer 0 ran out of an unlooped sample, or the volume reached zero. */
  private ended = false;
  /**
   * Whether the segment being rendered is the voice's last, because the
   * note's own volume is zero at its end.
   *
   * `0x209a`/`0x20de`: the renderer compares the chunk-end volume -- the
   * velocity ramp, not the envelope -- against zero, and a record whose ramp
   * has reached it is freed after the chunk (`[rbp-0xb74]` → `0x3093`), along
   * with one whose envelope has ended or whose channel × Level is not
   * positive. So a note that opens at velocity 0 and *holds* it is freed after
   * one block and never sounds -- 3,132 corpus notes -- where one that opens
   * at 0 and rises is not, its end-of-block ramp being positive.
   */
  private silentAfter = false;
  // Live expression: `Mixer.expression`, neutral until something sends some.
  private bendRate = 1;
  private pressure = 1;
  private timbre = 0;
  private autoCursor = 0;
  private autoPitch = 0;
  private autoGain = 1;
  private morphCursor = 0;
  private heldCursor = 0;
  /** Index of the next engine chunk split past the voice's frame; -1 before the first segment. */
  private splitCursor = -1;
  // `VoiceSpec.engine`: the chunk and the walk the segment is in, the three
  // float32 LFO phases, and the segment's two ends as the record reads them.
  private engineChunk = -1;
  private engineWalk = 0;
  private readonly enginePhase = new Float32Array(3);
  private readonly engineLfo = { inc: new Float32Array(3), fan: new Float32Array(3) };
  private enginePitchS = 0;
  private enginePitchE = 0;
  private engineGainS = 0;
  private engineGainE = 0;
  private engineModS = 0;
  private engineModE = 0;
  /** The record's own L/R accumulator: one block, post-pan, pre-filter. */
  private readonly scratchL = new Float32Array(BLOCK_FRAMES);
  private readonly scratchR = new Float32Array(BLOCK_FRAMES);

  // Fields are declared and assigned longhand rather than with TypeScript
  // parameter properties: Node's strip-only type removal rejects any syntax
  // that emits runtime code. See steering/tracker-architecture.md.
  constructor(
    spec: VoiceSpec,
    delay: number,
    life: number,
    cut: number,
    outputRate: number,
  ) {
    // ⚠️ The default has to depend on the sample, not be a flat Infinity: a
    // LOOPED voice with no `holdFrames` must still be gated by its note, and
    // holding its gate open forever is what a flat default did -- it broke
    // `endFrame` for every caller that had never heard of one-shots.
    this.hold = spec.holdFrames ?? (spec.sample.loop === undefined ? Infinity : 0);
    this.spec = spec;
    this.delay = delay;
    this.life = life;
    this.cut = cut;
    this.release = Number.isFinite(life) ? Math.min(spec.release ?? 0, life) : 0;
    this.decayPerFrame = spec.decayDbPerSecond
      ? Math.pow(10, -Math.abs(spec.decayDbPerSecond) / 20 / outputRate)
      : 1;
    this.secondsPerFrame = 1 / outputRate;
    this.minRelease = spec.declick === true ? DECLICK_SECONDS : 0;
    this.tailFrames = spec.declick === true ? Math.round(DECLICK_SECONDS * outputRate) : 0;
    const draw = spec.random ?? Math.random;
    const layerSpecs: readonly LayerSpec[] =
      spec.layers !== undefined && spec.layers.length > 0
        ? spec.layers
        : [{ pan: spec.pan, startPosition: spec.startPosition, lfoPhase: spec.lfoPhase }];
    this.layers = layerSpecs.map((layer) => new Layer(layer, draw));
    if (spec.engine !== undefined) this.enginePhase.set(spec.engine.lfoPhases);
    this.filter32 = spec.engine !== undefined && spec.engineGrid?.chunks !== undefined;
    this.ladder32 = this.filter32 && spec.engine?.ladder64 !== true;
    this.ladderL = this.ladder32 ? new MoogLadder32() : new MoogLadder();
    this.ladderR = this.ladder32 ? new MoogLadder32() : new MoogLadder();

    // What a voice with no morph derives once and reads for both ends.
    const f = this.fixed;
    if (spec.envelope !== undefined) {
      Object.assign(f.adsr, spec.envelope);
      f.adsr.release = Math.max(f.adsr.release, this.minRelease);
    }
    if (spec.filter !== undefined) {
      Object.assign(f.adsrB, spec.filter.envelope);
      Object.assign(f.filter, spec.filter.settings);
    }
    if (spec.lfos !== undefined) {
      for (let n = 0; n < 3; n += 1) {
        f.lfoRate[n] = spec.lfos[n].rate;
        f.lfoDepth[n] = spec.lfos[n].depth;
      }
    }
    f.drive = clamp01(spec.drive ?? 0);
    f.level = 1;
    f.echo = spec.echoSend ?? 0;
    this.curEcho = f.echo;
    this.curReverb = spec.reverbSend ?? 0;
    let widestEcho = f.echo;
    const morph = spec.morph;
    if (morph !== undefined) {
      for (const point of morph.points) {
        widestEcho = Math.max(widestEcho, echoAt(morph, point.value));
      }
    }
    this.maySend = widestEcho > 0 || this.curReverb > 0;
  }

  /**
   * Derive everything the modulation feeds, at one value of it.
   *
   * ⚠️ **Every parameter, not a chosen few.** `evaluateParam` is affine in
   * the modulation, but the things built on top are not -- the ADSR squares its
   * times, the ladder squares the cutoff -- so the modulation is what gets
   * interpolated and the derivation is redone from it, at both ends of the
   * segment, which is what the engine does (`xmm7` at the start, `xmm15` at
   * `0x2a54` onward for the end). ⚠️ Not every result is used at both ends:
   * the ADSRs, the LFO rates and the fan are the start's alone, as the
   * engine's are -- the table in steering/synth-engine.md, *The per-voice
   * renderer*.
   */
  private derive(out: Derived, mod: number): Derived {
    const spec = this.spec;
    const morph = spec.morph!;
    const p = morph.params;
    const at = (index: number) => evaluateParam(p[index] ?? ZERO_PARAM, mod);
    const time = (index: number) => at(index) ** 2 * ENVELOPE_SECONDS_PER_UNIT;
    if (spec.envelope !== undefined) {
      out.adsr.attack = time(ADSR_PARAMS.attack);
      out.adsr.decay = time(ADSR_PARAMS.decay);
      out.adsr.sustain = at(ADSR_PARAMS.sustain);
      out.adsr.release = Math.max(time(ADSR_PARAMS.release), this.minRelease);
    }
    const filter = spec.filter;
    if (filter !== undefined) {
      out.adsrB.attack = time(ADSR_PARAMS_B.attack);
      out.adsrB.decay = time(ADSR_PARAMS_B.decay);
      out.adsrB.sustain = at(ADSR_PARAMS_B.sustain);
      out.adsrB.release = time(ADSR_PARAMS_B.release);
      out.filter.cutoff = at(FILTER_PARAMS.cutoff);
      out.filter.resonance = at(FILTER_PARAMS.resonance);
      // ❗ The caller may have zeroed the key tracking as an A/B, and the
      // modulation must not put it back.
      out.filter.keyTrack = morph.noKeyTrack === true ? 0 : at(FILTER_PARAMS.keyTrack);
      out.filter.envAmount = at(FILTER_PARAMS.envAmount);
    }
    if (spec.lfos !== undefined) {
      const perLayer = (2 * Math.PI) / this.layers.length;
      const opening = morph.points[0]?.value ?? mod;
      for (let n = 0; n < 3; n += 1) {
        out.lfoRate[n] = at(LFO_PARAMS[n].rate);
        out.lfoDepth[n] = at(LFO_PARAMS[n].depth);
        // ❗ The fan follows the modulation too: `0x22e5`-`0x236d` evaluate
        // `Params[17|20|23]` at the chunk's start modulation, times 2π over
        // `Numstack`, every chunk, and `0x287b`-`0x28bb` add it once per layer
        // to the stored phase. The spec's `lfoPhase` holds the fan at the
        // spawn's modulation, `points[0]` (the render's `event.modulation`), so
        // this is the difference. Fixed at the spawn's, `electric_piano`'s
        // modulation glide was +4.1 dB off the module.
        const spread = p[LFO_PARAMS[n].spread] ?? ZERO_PARAM;
        out.lfoFan[n] = (evaluateParam(spread, mod) - evaluateParam(spread, opening)) * perLayer;
      }
    }
    out.drive = clamp01(at(OUTPUT_PARAMS.drive));
    // ❗ The level is one factor of a gain that also carries the track level,
    // the channel volume, the headroom, the velocity and the stack correction.
    // Only its own factor may move, so it moves as a ratio against the value
    // the spec was built with.
    const level = at(OUTPUT_PARAMS.level);
    out.level = morph.opening > 0 ? level / morph.opening : 1;
    out.echo = echoAt(morph, mod);
    return out;
  }

  /**
   * The modulation at a frame of the note's own clock, along its control
   * points, on the segment active at `anchor` -- see `AutomationPoint.from`.
   */
  private modAt(frame: number, anchor = frame): number {
    const points = this.spec.morph!.points;
    let i = this.morphCursor;
    if (points[0].from === undefined) {
      while (i + 1 < points.length && points[i + 1].frame <= frame) i += 1;
    } else {
      while (i + 1 < points.length && points[i + 1].from! <= anchor) i += 1;
    }
    this.morphCursor = i;
    const from = points[i];
    const to = points[i + 1];
    if (to === undefined) return from.value;
    const span = to.frame - from.frame;
    const t = span > 0 ? (frame - from.frame) / span : 1;
    return from.value + (to.value - from.value) * t;
  }

  /**
   * The note's own pitch and volume at a frame, into `autoPitch`/`autoGain`.
   *
   * Linear between control points -- the engine's three slides -- and held
   * past the last one, which is what it does when it runs out of records. A
   * zero-length segment (two records on one step, authoring debris) takes the
   * later value rather than dividing by zero.
   */
  private automationAt(frame: number, anchor = frame): void {
    const points = this.spec.automation;
    if (points === undefined || points.length === 0) {
      this.autoPitch = 0;
      this.autoGain = 1;
      return;
    }
    let i = this.autoCursor;
    if (points[0].from === undefined) {
      while (i + 1 < points.length && points[i + 1].frame <= frame) i += 1;
    } else {
      while (i + 1 < points.length && points[i + 1].from! <= anchor) i += 1;
    }
    this.autoCursor = i;
    const from = points[i];
    const to = points[i + 1];
    if (to === undefined) {
      this.autoPitch = from.pitch;
      this.autoGain = from.gain;
      return;
    }
    const span = to.frame - from.frame;
    const t = span > 0 ? (frame - from.frame) / span : 1;
    this.autoPitch = from.pitch + (to.pitch - from.pitch) * t;
    this.autoGain = from.gain + (to.gain - from.gain) * t;
  }

  /**
   * Move this voice's live expression. See `Mixer.expression` for the contract.
   *
   * Takes effect at the next segment, as a control change reaching the engine
   * would at its next chunk: a segment already evaluated runs to its end.
   */
  setExpression(bend?: number, pressure?: number, timbre?: number): void {
    if (bend !== undefined) this.bendRate = 2 ** (bend / 12);
    if (pressure !== undefined) this.pressure = pressure;
    if (timbre !== undefined) this.timbre = timbre;
  }

  get finished(): boolean {
    // Being taken away ends any voice, its faded tail included.
    if (this.cut <= 0) return true;
    // Ours: the ladder's tail is faded out after the sound itself has ended.
    if (this.tailLeft > 0) return false;
    // Running out of sample ends it; so does the volume or the release reaching zero.
    if (this.ended) return true;
    // ❗ A segment already evaluated is rendered to its end whoever slices it:
    // the engine frees a record after the chunk in which its level reached
    // zero, having rendered that chunk. Dropping the voice at a caller's slice
    // boundary instead cut the ladder's tail at a different frame per block
    // size -- -33 dB between a 128-frame and a whole-song render.
    if (this.segLeft > 0) return false;
    // With an envelope the voice ends when the release reaches zero, not when
    // its life runs out -- life only closes the gate.
    if (this.spec.envelope !== undefined) return this.env.finished;
    // Without one there is nothing to ring on: the gate is the end. A one-shot
    // holds its gate open until `ended` says the sample ran out.
    return !(this.hold > 0 || this.life > 0);
  }

  /**
   * Evaluate the next segment, starting at the voice's own frame `elapsed`.
   *
   * The segment is the rest of the block on the voice's grid, cut short at the
   * gate's close, at a one-shot's hold running out, at the start of our own
   * fade, and at the allocator's cut -- every one of them a frame of the
   * voice's own, so the segmentation is the same whoever slices the render.
   */
  private startSegment(): void {
    const spec = this.spec;
    const held = this.hold > 0 || this.life > 0;
    if (spec.envelope === undefined && !held) {
      this.ended = true;
      this.segLeft = 0;
      return;
    }
    // A note's own gate closes on a segment's first frame -- `life` and `hold`
    // both cut one there -- and one `Mixer.release` closes is taken at the
    // next. Either way the release is a whole block from it, as the engine's
    // is from the chunk where `0x1f65` first reads the gate closed.
    if (this.gateOpen && !held) {
      this.gateOpen = false;
      if (spec.engineGrid === undefined) this.gridOrigin = this.elapsed;
    }
    const grid = spec.engineGrid;
    let n: number;
    if (grid === undefined) {
      n = BLOCK_FRAMES - ((this.elapsed - this.gridOrigin) % BLOCK_FRAMES);
    } else {
      const at = grid.origin + this.elapsed;
      n = BLOCK_FRAMES - (at % BLOCK_FRAMES);
      const splits = grid.splits;
      let i = this.splitCursor;
      if (i < 0) {
        // First segment: find the first split past the onset by bisection.
        let lo = 0;
        let hi = splits.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (splits[mid] <= at) lo = mid + 1;
          else hi = mid;
        }
        i = lo;
      }
      while (i < splits.length && splits[i] <= at) i += 1;
      this.splitCursor = i;
      if (i < splits.length && splits[i] - at < n) n = splits[i] - at;
    }
    if (this.life > 0 && this.life < n) n = this.life;
    if (this.hold > 0 && this.hold < n) n = this.hold;
    if (this.release > 0 && this.life > this.release && this.life - this.release < n) {
      n = this.life - this.release;
    }
    if (this.cut < n) n = this.cut;
    this.segLeft = n;
    const s = this.elapsed;
    const e = s + n;
    const seconds = n * this.secondsPerFrame;
    const invN = 1 / n;

    const morph = spec.morph;
    const engine = spec.engine !== undefined && spec.engineGrid?.chunks !== undefined;
    if (engine) this.engineEnds(s, n);
    const S =
      morph !== undefined ? this.derive(this.startD, engine ? this.engineModS : this.modAt(s, s)) : this.fixed;
    const E =
      morph !== undefined ? this.derive(this.endD, engine ? this.engineModE : this.modAt(e, s)) : this.fixed;

    // The two envelopes, each evaluated twice as the engine does it: once with
    // a dt of `frames / 48,000,000` units (`0x201f`, `v0x4560`) for the
    // segment's start and once with `frames / 192,000` (`0x204c`, `v0x4564`)
    // for its end -- the second is the segment's own duration, the first is a
    // 250th of it. ❗ The first call is what lets an attack of zero stand at
    // full level from the note's first frame, and it advances the state, so
    // the engine's envelopes run a 250th faster than its clock; so do these.
    // Both ends are ramped between, and the stages being straight lines, the
    // ramp is exact except where a stage turns inside the segment.
    // ❗ Both calls take the ADSR at the segment's START modulation: the four
    // are interpolated once, with `[rbp-0xaa4]` -- `+0x28` plus the elapsed
    // steps at the chunk's start (`0x1cfb`) times the slide (`0x1f4a`) -- and
    // passed unchanged to both (`0x1f8c`-`0x2089` for A, `0x213d`-`0x2227` for
    // B). Passing the end's to the second call put a gliding sustain a
    // segment ahead: -19.5 dB against the module on a square-wave glide.
    const startDt = seconds / 250;
    let envS = 1;
    let envE = 1;
    if (spec.envelope !== undefined) {
      envS = this.env.advance(startDt, held, S.adsr);
      envE = this.env.advance(seconds, held, S.adsr);
    }
    let envBS = 0;
    let envBE = 0;
    if (spec.filter !== undefined) {
      if (this.filter32) {
        // `0x213d`-`0x2227`: `0x16b0` in float32, the four at the start modulation.
        const p = spec.engine!.params;
        const m = this.engineModS;
        const a = param32(p[ADSR_PARAMS_B.attack], m);
        const d = param32(p[ADSR_PARAMS_B.decay], m);
        const su = param32(p[ADSR_PARAMS_B.sustain], m);
        const r = param32(p[ADSR_PARAMS_B.release], m);
        envBS = this.filterEnv.advance32(Math.fround(n * ENGINE_DT_START), held, a, d, su, r);
        envBE = this.filterEnv.advance32(Math.fround(n * ENGINE_DT_END), held, a, d, su, r);
      } else {
        envBS = this.filterEnv.advance(startDt, held, S.adsrB);
        envBE = this.filterEnv.advance(seconds, held, S.adsrB);
      }
    }
    // Ours, for a voice with no envelope: the linear fade and the decay. The
    // fade's start is a segment bound, so a segment is wholly before it or
    // wholly inside it and the ramp is exact.
    let fadeS = 1;
    let fadeE = 1;
    let decayS = 1;
    let decayE = 1;
    if (spec.envelope === undefined) {
      if (this.release > 0) {
        fadeS = this.life < this.release ? this.life / this.release : 1;
        const lifeE = this.life - n;
        fadeE = lifeE < this.release ? lifeE / this.release : 1;
      }
      if (this.decayPerFrame !== 1) {
        decayS = this.decayGain;
        decayE = decayS * this.decayPerFrame ** n;
        this.decayGain = decayE;
      }
    }

    // The note's own glide at both ends: semitones, then `exp2f`, then the
    // rate is what ramps -- the engine's two `exp2f` calls at `0x1dc2` and
    // `0x1e63`, the second with the slide added.
    let pitchS = 0;
    let pitchE = 0;
    let volS = this.engineGainS;
    let volE = this.engineGainE;
    if (!engine) {
      this.automationAt(s, s);
      pitchS = this.autoPitch;
      volS = this.autoGain;
      this.automationAt(e, s);
      pitchE = this.autoPitch;
      volE = this.autoGain;
    }
    // See `silentAfter`: the engine frees the record after this chunk. ❗ So
    // does an envelope whose END value is not positive in ANY stage, not only
    // a finished release: `0x20e0` tests the second `0x16b0` call's return, so
    // a decay onto a sustain of 0 frees the record with the gate still open.
    // Rendering on put `woodpecker`'s ladder ringing a block past the module's
    // silence.
    this.silentAfter = volE <= 0 || (spec.envelope !== undefined && envE <= 0);
    let ratioS: number;
    let ratioE: number;
    if (engine) {
      const record = spec.engine!;
      const shift = record.shift * this.bendRate;
      ratioS = ratio32(record.slot, this.enginePitchS) * shift;
      ratioE = ratio32(record.slot, this.enginePitchE) * shift;
    } else {
      const base = spec.playbackRate * this.bendRate;
      ratioS = pitchS === 0 ? base : base * 2 ** (pitchS / 12);
      ratioE = pitchE === 0 ? base : base * 2 ** (pitchE / 12);
    }
    const gainS = spec.gain * S.level * volS * envS * fadeS * decayS * this.pressure;
    const gainE = spec.gain * E.level * volE * envE * fadeE * decayE * this.pressure;

    if (engine) {
      this.engineLayers(n, ratioS, ratioE, gainS, gainE, S, E);
    } else {
      // The three LFOs: this segment's phase increment is the start modulation's
      // rate times the scale times the segment's seconds (`0x2263`-`0x22cf`,
      // with `xmm7`), and each oscillator is read at the phase and at the phase
      // plus the increment. `sin` is skipped where the depth is zero at that end;
      // `0 * sin` is exactly 0 so nothing changes but the cost.
      const inc0 = S.lfoRate[0] * LFO_RATE_SCALE[0] * seconds;
      const inc1 = S.lfoRate[1] * LFO_RATE_SCALE[1] * seconds;
      const inc2 = S.lfoRate[2] * LFO_RATE_SCALE[2] * seconds;
      const d0S = S.lfoDepth[0];
      const d0E = E.lfoDepth[0];
      const d1S = S.lfoDepth[1];
      const d1E = E.lfoDepth[1];
      const d2S = S.lfoDepth[2];
      const d2E = E.lfoDepth[2];
      const acc = this.lfoAcc;
      // Both ends of a layer take the start modulation's fan, as the engine's
      // one per-chunk evaluation does.
      const fan = S.lfoFan;
      for (let i = 0; i < this.layers.length; i += 1) {
        const layer = this.layers[i];
        const p0 = layer.phase[0] + acc[0] + i * fan[0];
        const p1 = layer.phase[1] + acc[1] + i * fan[1];
        const p2 = layer.phase[2] + acc[2] + i * fan[2];
        // LFO 1 on the rate, riding on the detune at the same 0.05 (`0x27b5`).
        const rateS = ratioS * (layer.detune + (d0S !== 0 ? 0.05 * d0S * Math.sin(p0) : 0));
        const rateE = ratioE * (layer.detune + (d0E !== 0 ? 0.05 * d0E * Math.sin(p0 + inc0) : 0));
        // LFO 2 on the gain, `1 + depth * osc` (`0x255c`-`0x2574`).
        const gLS = gainS * (d1S !== 0 ? 1 + d1S * Math.sin(p1) : 1);
        const gLE = gainE * (d1E !== 0 ? 1 + d1E * Math.sin(p1 + inc1) : 1);
        // LFO 3 on the pan, folded with the layer's own pan (`0x25fe`, `0x26cb`).
        const panS = panFold(d2S !== 0 ? Math.sin(p2) : 0, d2S, layer.basePan);
        const panE = panFold(d2E !== 0 ? Math.sin(p2 + inc2) : 0, d2E, layer.basePan);
        layer.rate = rateS;
        layer.rateStep = (rateE - rateS) * invN;
        layer.gain = gLS;
        layer.gainStep = (gLE - gLS) * invN;
        layer.pan = panS;
        layer.panStep = (panE - panS) * invN;
      }
      // The stored phases advance once, after the layers (`0x28f1`-`0x293b`);
      // bounded so a float that has run for an hour keeps its precision.
      const twoPi = 2 * Math.PI;
      acc[0] = (acc[0] + inc0) % twoPi;
      acc[1] = (acc[1] + inc1) % twoPi;
      acc[2] = (acc[2] + inc2) % twoPi;
    }

    // The filter's cutoff and resonance at both ends (`0x29c2`-`0x2a50`, then
    // `0x2a54`-`0x2aa5` from the end modulation), clamped as the engine clamps them. The
    // key tracking takes the record's own ratio -- before the detune and the
    // LFO -- which is what `[rbp-0xa90]` holds. ❗ The START ratio, at both
    // ends: `0x2a15` loads it once and `0x2a26` and `0x2a8c` both multiply by
    // it; nothing writes the slot between `0x1e1f` and `0x2b3d`. The end's
    // ratio put a pitch glide's ladder a fraction of a chunk ahead, a phase
    // shift that followed the slope: -42 dB on `sine_wave`, -99 dB once held.
    if (spec.filter !== undefined) {
      const ends = this.filterEnds;
      if (this.filter32 && this.timbre === 0) {
        // The record's own float32, in the module's order (`filterEnds32`).
        const record = spec.engine!;
        filterEnds32(
          record.params,
          this.engineModS,
          this.engineModE,
          envBS,
          envBE,
          ratioS,
          record.noKeyTrack === true,
          ends,
        );
      } else {
        const fS = S.filter;
        const fE = E.filter;
        // ⚠️ The cutoff is squared unclamped (`0x29ec`-`0x29ff`) and only the
        // product is clamped. Inside 0..1 that is the same thing; a modulation
        // past 1, which a slide over a third of a step reaches by the walk after
        // it, puts `saw_wave`'s cutoff at -0.62 and the module's at 0.38. Our
        // live timbre is not the engine's, and keeps its clamp.
        const cutS = this.timbre === 0 ? fS.cutoff : clamp01(fS.cutoff + this.timbre);
        const cutE = this.timbre === 0 ? fE.cutoff : clamp01(fE.cutoff + this.timbre);
        const envFS = 1 + fS.envAmount * (envBS - 1);
        const envFE = 1 + fE.envAmount * (envBE - 1);
        ends.freqS = clamp01(cutS * cutS * (1 + (ratioS - 1) * fS.keyTrack) * envFS);
        ends.freqE = clamp01(cutE * cutE * (1 + (ratioS - 1) * fE.keyTrack) * envFE);
        ends.resS = clamp01(fS.resonance * envFS);
        ends.resE = clamp01(fE.resonance * envFE);
        if (this.filter32) {
          ends.freqS = Math.fround(ends.freqS);
          ends.freqE = Math.fround(ends.freqE);
          ends.resS = Math.fround(ends.resS);
          ends.resE = Math.fround(ends.resE);
        }
      }
      const { freqS, freqE, resS, resE } = ends;
      // `0x2e99`: the block-start cutoff over 0.99 takes the unfiltered path.
      this.bypass = freqS > FILTER_BYPASS_CUTOFF;
      // `0x30d8`: both ends equal takes the constant-coefficient ladder;
      // otherwise `0x33d6` re-derives the coefficients per sample from a ramp.
      this.rampFilter = freqS !== freqE || resS !== resE;
      this.freq = freqS;
      this.res = resS;
      if (this.filter32) {
        this.freqStep = rampStep32(freqS, freqE, n);
        this.resStep = rampStep32(resS, resE, n);
        if (!this.bypass && !this.rampFilter) {
          (this.ladder32 ? ladderCoefficients32Into : ladderCoefficientsInto)(freqS, resS, this.coefficients);
        }
      } else {
        this.freqStep = (freqE - freqS) * invN;
        this.resStep = (resE - resS) * invN;
        if (!this.bypass && !this.rampFilter) ladderCoefficientsInto(freqS, resS, this.coefficients);
      }
    } else {
      this.bypass = true;
    }

    // The drive and the sends are constants of the chunk (`0x1ee0`; the sends
    // in the output loop, `0x2f3f`-`0x2f89`), set by the walk a step behind
    // the modulation: see `morph.held`. Following the ramp instead put
    // `electric_harpsichord`'s modulation glide 0.7 dB above the module.
    let drive = S.drive;
    let echo = S.echo;
    const walk = morph?.held;
    if (engine && morph !== undefined) {
      // The walk's own `+0x28` as the walk before it left it: the spawn's
      // seed for the spawn (`0x1a1a`), the previous row's after that.
      const value = spec.engine!.walks[Math.max(0, this.engineWalk - 1)].mod;
      drive = clamp01(evaluateParam(morph.params[OUTPUT_PARAMS.drive] ?? ZERO_PARAM, value));
      echo = echoAt(morph, value);
    } else if (walk !== undefined && walk.length > 0) {
      let i = this.heldCursor;
      while (i + 1 < walk.length && walk[i + 1].frame <= s) i += 1;
      this.heldCursor = i;
      const value = walk[i].value;
      drive = clamp01(evaluateParam(morph!.params[OUTPUT_PARAMS.drive] ?? ZERO_PARAM, value));
      echo = echoAt(morph!, value);
    }
    this.driveK = driveCoefficient(drive);
    this.driveOnePlusK = 1 + this.driveK;
    this.curEcho = echo;
  }

  /**
   * `VoiceSpec.engine`: the record's pitch, volume and modulation at the two
   * ends of the segment starting at the voice frame `s`, as `0x1c60` reads
   * them off the last walk and the chunk's float32 playhead (`EngineRecord`).
   */
  private engineEnds(s: number, n: number): void {
    const f = Math.fround;
    const record = this.spec.engine!;
    const grid = this.spec.engineGrid!;
    const { starts, playheads } = grid.chunks!;
    const at = grid.origin + s;
    let c = this.engineChunk;
    if (c < 0) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= at) lo = mid;
        else hi = mid - 1;
      }
      c = lo;
    }
    while (c + 2 < starts.length && starts[c + 1] <= at) c += 1;
    this.engineChunk = c;
    let pS = playheads[c];
    let pE = playheads[c + 1];
    const from = starts[c];
    const to = starts[c + 1];
    if (at !== from || at + n !== to) {
      // A segment the engine does not have -- a one-shot's hold or our own
      // fade cut the chunk -- reads the playhead along it.
      const per = (pE - pS) / (to - from);
      pE = f(pS + per * (at + n - from));
      pS = f(pS + per * (at - from));
    }
    const walks = record.walks;
    let k = this.engineWalk;
    while (k + 1 < walks.length && walks[k + 1].frame <= s) k += 1;
    this.engineWalk = k;
    const w = walks[k];
    // `0x0c35`/`0x0c48` take each end's fraction; `0x1c9b` adds 1 to the end's
    // when the chunk crossed a step, so a crossing chunk runs the old slide
    // past it; `0x1ce7`-`0x1cff` take the spawn's sub-step off both.
    const third = k === 0 ? record.startThird : 0;
    const a = f(pS - Math.floor(pS));
    let b = f(pE - Math.floor(pE));
    if (b < a) b = f(b + 1);
    const tS = Math.max(0, f(a - third));
    const tE = f(b - third);
    const dt = f(tE - tS);
    this.enginePitchS = f(f(tS * w.pitchSlide) + w.pitch);
    this.enginePitchE = f(f(tE * w.pitchSlide) + w.pitch);
    this.engineGainS = f(f(tS * w.gainSlide) + w.gain);
    this.engineGainE = f(f(dt * w.gainSlide) + this.engineGainS);
    this.engineModS = f(f(tS * w.modSlide) + w.mod);
    this.engineModE = f(f(dt * w.modSlide) + this.engineModS);
  }

  /**
   * `VoiceSpec.engine`: every layer's rate, gain and pan for the segment, the
   * rate as `0x2755`-`0x2876` forms it -- float32 at both ends, widened, and
   * stepped by `(double)(1.0f / N)` (`0x2467`) -- and the three float32 phases
   * advanced after the last layer (`0x28f1`-`0x293b`). The gain and the pan
   * keep the double arithmetic of the other path and take the same phases.
   */
  private engineLayers(
    n: number,
    ratioS: number,
    ratioE: number,
    gainS: number,
    gainE: number,
    S: Derived,
    E: Derived,
  ): void {
    const f = Math.fround;
    const params = this.spec.engine!.params;
    const lfo = this.engineLfo;
    lfoStep32(params, this.engineModS, n, this.layers.length, lfo);
    const [inc0, inc1, inc2] = lfo.inc;
    const [fan0, fan1, fan2] = lfo.fan;
    const depthS = param32(params[16], this.engineModS);
    const depthE = param32(params[16], this.engineModE);
    const d1S = S.lfoDepth[1];
    const d1E = E.lfoDepth[1];
    const d2S = S.lfoDepth[2];
    const d2E = E.lfoDepth[2];
    // The rate steps by `(double)(1.0f / N)` (`0x2467`); the gain and the pan
    // keep the other path's double reciprocal.
    const invN = f(1 / n);
    const invD = 1 / n;
    const phase = this.enginePhase;
    let p0 = phase[0];
    let p1 = phase[1];
    let p2 = phase[2];
    for (let i = 0; i < this.layers.length; i += 1) {
      const layer = this.layers[i];
      const rateS = layerRate32(ratioS, layer.detune, depthS, p0);
      const rateE = layerRate32(ratioE, layer.detune, depthE, f(inc0 + p0));
      const gLS = gainS * (d1S !== 0 ? 1 + d1S * sin32(p1) : 1);
      const gLE = gainE * (d1E !== 0 ? 1 + d1E * sin32(f(inc1 + p1)) : 1);
      const panS = panFold(d2S !== 0 ? sin32(p2) : 0, d2S, layer.basePan);
      const panE = panFold(d2E !== 0 ? sin32(f(inc2 + p2)) : 0, d2E, layer.basePan);
      layer.rate = rateS;
      layer.rateStep = (rateE - rateS) * invN;
      layer.gain = gLS;
      layer.gainStep = (gLE - gLS) * invD;
      layer.pan = panS;
      layer.panStep = (panE - panS) * invD;
      p0 = f(fan0 + p0);
      p1 = f(fan1 + p1);
      p2 = f(fan2 + p2);
    }
    phase[0] = f(inc0 + phase[0]);
    phase[1] = f(inc1 + phase[1]);
    phase[2] = f(inc2 + phase[2]);
  }

  /**
   * Render `take` frames of the current segment at `at`.
   *
   * ❗ **Every frame of it, whatever the sample does.** A layer past the end of
   * an unlooped sample reads silence (`0x37be`, `jge 0x3928`) and keeps
   * stepping; the other layers, the clip and the ladder run on to the chunk's
   * end. Only then does `0x3035`-`0x3069` ask whether layer 0 has run out
   * (`ranOut`), and the record is freed after the chunk. Stopping every layer
   * and the ladder at layer 0's last frame cut a filtered kit's ladder ring a
   * part-chunk early: `bb_kit_2`, -63 dB of its loudest window against the
   * module.
   */
  private renderSegment(
    outLeft: Float32Array,
    outRight: Float32Array,
    at: number,
    take: number,
    interpolate: Interpolator,
    engineSampler: boolean,
  ): void {
    const { sample } = this.spec;
    // Ours, with `declick`: a loop `smoothLoop` reshaped, where there is one.
    const body = this.spec.declick === true && sample.smoothed !== undefined ? sample.smoothed : sample;
    const chans = body.channels;
    const mono = chans.length === 1;
    const srcL = chans[0];
    const srcR = mono ? chans[0] : chans[1];
    const loop = sample.loop;
    // With the engine sampler off the voice falls back to `interpolate` over
    // the full-rate channels, which is the A/B path: it is how a different
    // interpolator can be heard against the game's own.
    const mips = engineSampler ? body.mips : undefined;
    const mipL = mips?.[0];
    const mipR = mips === undefined ? undefined : (mips[1] ?? mips[0]);
    const driveK = this.driveK;
    const driveOnePlusK = this.driveOnePlusK;
    // Ours, with `declick`: no silent frame at the first wrap (`readMipped`).
    const gapless = this.spec.declick === true;
    const sL = this.scratchL;
    const sR = this.scratchR;
    sL.fill(0, 0, take);
    sR.fill(0, 0, take);

    const layers = this.layers;
    for (let li = 0; li < layers.length; li += 1) {
      const layer = layers[li];
      let position = layer.position;
      let rate = layer.rate;
      let gain = layer.gain;
      let pan = layer.pan;
      const rateStep = layer.rateStep;
      const gainStep = layer.gainStep;
      const panStep = layer.panStep;
      for (let i = 0; i < take; i += 1) {
        if (loop !== undefined) {
          // ❗ **The engine's sampler never rewinds the position**: the record
          // keeps a double that only grows (`0x2d59`) and `0x3780` wraps the
          // integer index it reads at, so `readMipped` is handed the unwrapped
          // value and does the wrap itself -- which is what gives the engine its
          // one silent sample at a loop ending on the sample's last frame, and
          // its float32 roughness on long looped notes. Our own path wraps the
          // position, both taps with it, at loop.end.
          const span = loop.end - loop.start;
          if (mipL === undefined && span > 0 && position >= loop.end) {
            position = loop.start + ((position - loop.start) % span);
          }
        }
        // Hand the loop to the interpolator only once the voice is inside it.
        // Before that the taps behind `loop.start` are the attack and are
        // correct as they stand; wrapping them would corrupt the note's onset.
        const region = loop !== undefined && position >= loop.start ? loop : undefined;
        // The mip is picked per read from the rate as it stands (`0x37d4`,
        // `0x37de` compare the rate the read was handed), so a glide across an
        // octave changes copy where the engine's does.
        let l: number;
        let r: number;
        if (mipL !== undefined) {
          // Silence at an index past the frame count, which `readMipped` tests.
          const level = mipLevelFor(rate);
          l = readMipped(mipL, position, level, region, gapless);
          r = mono ? l : readMipped(mipR!, position, level, region, gapless);
        } else if (loop === undefined && position >= srcL.length) {
          l = 0;
          r = 0;
        } else {
          l = interpolate(srcL, position, region);
          r = mono ? l : interpolate(srcR, position, region);
        }
        if (driveK !== 0) {
          l = softClip(l, driveK, driveOnePlusK);
          r = mono ? l : softClip(r, driveK, driveOnePlusK);
        }
        l *= gain;
        r *= gain;
        sL[i] += (1 - pan) * l;
        sR[i] += pan * r;
        position += rate;
        rate += rateStep;
        gain += gainStep;
        pan += panStep;
      }
      layer.position = position;
      layer.rate = rate;
      layer.gain = gain;
      layer.pan = pan;
    }

    // The record's own clip, on the summed layers, before anything else.
    for (let i = 0; i < take; i += 1) {
      const l = sL[i];
      const r = sR[i];
      sL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
      sR[i] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
    // Then the two ladders, or neither: a wide-open lowpass is skipped, not
    // computed, because this ladder is not transparent at `freq = 1`.
    if (!this.bypass) {
      const coefficients = this.coefficients;
      if (!this.rampFilter) {
        for (let i = 0; i < take; i += 1) {
          sL[i] = this.ladderL.process(sL[i], coefficients);
          sR[i] = this.ladderR.process(sR[i], coefficients);
        }
      } else {
        let freq = this.freq;
        let res = this.res;
        const freqStep = this.freqStep;
        const resStep = this.resStep;
        if (this.filter32) {
          // The step is added after each sample's ladders, in float32 (`0x36d9`,
          // `0x36ea`). ❗ That add is most of what the float32 filter is worth: a
          // step under half an ulp of the cutoff is lost, so a slow sweep stands
          // still inside a chunk. Accumulated in double, `woodpecker` was -78 dB
          // against the module and `synth_strings`' gover -58 (synth-engine.md).
          const into = this.ladder32 ? ladderCoefficients32Into : ladderCoefficientsInto;
          for (let i = 0; i < take; i += 1) {
            into(freq, res, coefficients);
            sL[i] = this.ladderL.process(sL[i], coefficients);
            sR[i] = this.ladderR.process(sR[i], coefficients);
            freq = Math.fround(freq + freqStep);
            res = Math.fround(res + resStep);
          }
        } else {
          for (let i = 0; i < take; i += 1) {
            ladderCoefficientsInto(freq, res, coefficients);
            sL[i] = this.ladderL.process(sL[i], coefficients);
            sR[i] = this.ladderR.process(sR[i], coefficients);
            freq += freqStep;
            res += resStep;
          }
        }
        this.freq = freq;
        this.res = res;
      }
    }
    for (let i = 0; i < take; i += 1) {
      outLeft[at + i] += sL[i];
      outRight[at + i] += sR[i];
    }
    this.elapsed += take;
    this.life -= take;
    this.cut -= take;
    this.hold -= take;
  }

  /**
   * Render into the output, advancing by `frames`, mixing additively.
   *
   * Returns the half-open frame span it actually touched. Callers need that:
   * a send bus has to clear and accumulate a scratch buffer around each voice,
   * and doing that over the whole block instead of the voice's own window is
   * what made a full-length render quadratic -- with tens of thousands of notes
   * against a sixteen-million-frame block it is the difference between seconds
   * and hours.
   *
   * A segment outlives the call that started it (`segLeft`), which is what
   * lets a 128-frame live call and a whole-song offline call evaluate on the
   * same boundaries -- they are measured to agree frame for frame, and must
   * keep doing.
   */
  render(
    outLeft: Float32Array,
    outRight: Float32Array,
    frames: number,
    interpolate: Interpolator,
    engineSampler: boolean,
    into?: RenderedSpan[],
  ): { begin: number; end: number } {
    // Skip the start delay by arithmetic. Counting it down a frame at a time
    // made every voice walk the whole block before its first sample, so a note
    // near the end of a long render cost as much as one at the beginning.
    let at = 0;
    if (this.delay > 0) {
      const skip = Math.min(this.delay, frames);
      this.delay -= skip;
      if (skip >= frames) return { begin: frames, end: frames };
      at = skip;
    }
    let begin = -1;
    let end = 0;
    // `finished` is false while a segment is part-rendered, so a voice whose
    // release ended inside one still renders that segment to its end and stops
    // there -- the same frame whatever the caller's slicing.
    while (at < frames && !this.finished) {
      if (this.tailLeft > 0) {
        const take = Math.min(this.tailLeft, frames - at, this.cut);
        this.renderTail(outLeft, outRight, at, take);
        if (begin < 0) begin = at;
        end = at + take;
        into?.push({ begin: at, end: at + take, echo: this.curEcho, reverb: this.curReverb });
        at += take;
        continue;
      }
      if (this.segLeft === 0) {
        this.startSegment();
        if (this.ended) {
          this.beginTail();
          continue;
        }
      }
      // A cut posted since the segment was evaluated shortens it: the allocator
      // takes the record wherever the voice is.
      const take = Math.min(this.segLeft, frames - at, this.cut);
      this.renderSegment(outLeft, outRight, at, take, interpolate, engineSampler);
      if (take > 0) {
        if (begin < 0) begin = at;
        end = at + take;
        // ⚠️ **One span per segment slice, with the send that was live for it.**
        // The buses belong to the mixer, so the voice cannot sum into them
        // itself; reporting what it wrote and at what send is how a moving
        // echo reaches them without the mixer having to know about segments.
        into?.push({ begin: at, end: at + take, echo: this.curEcho, reverb: this.curReverb });
      }
      this.segLeft -= take;
      at += take;
      // The record is given back after the chunk in which its volume or its
      // release reached zero, or layer 0 ran out of sample -- rendered to the
      // end, then gone, whoever sliced it.
      if (
        this.segLeft === 0 &&
        (this.silentAfter || this.ranOut || (this.spec.envelope !== undefined && this.env.finished))
      ) {
        this.ended = true;
        this.beginTail();
      }
    }
    return { begin: begin < 0 ? 0 : begin, end };
  }

  /**
   * Whether layer 0 has run out of an unlooped sample, as `0x3035`-`0x3069`
   * asks once the chunk is out: its double converted to float32
   * (`vcvtsd2ss`) **strictly** above the slot's frame count (`jbe 0x307f`),
   * the slot unlooped (`+0x80`, the loop's length, zero) and not empty. A
   * position that lands on the count exactly keeps the record a chunk more;
   * a later layer never frees it.
   */
  private get ranOut(): boolean {
    const { sample } = this.spec;
    if (sample.loop !== undefined) return false;
    const frames = sample.channels[0].length;
    return frames > 0 && Math.fround(this.layers[0].position) > frames;
  }

  /**
   * Start the ladder's faded tail, if `VoiceSpec.declick` asked for one and
   * the ladder is in the path. Ours: the engine stops a freed record's output
   * in one frame, whatever its ladder holds.
   *
   * Called once, where the sound itself ends. A bypassed ladder has nothing
   * to hold -- the layers have stopped and the bypass passes their silence.
   */
  private beginTail(): void {
    if (this.tailFrames === 0 || this.bypass) return;
    // A ramping ladder has walked its coefficients to where the sound ended.
    if (this.rampFilter) {
      (this.ladder32 ? ladderCoefficients32Into : ladderCoefficientsInto)(this.freq, this.res, this.coefficients);
    }
    this.tailLeft = this.tailFrames;
    this.tailGain = 1;
    this.tailStep = 1 / this.tailFrames;
  }

  /** The ladders run on silence, their output faded linearly to zero. */
  private renderTail(outLeft: Float32Array, outRight: Float32Array, at: number, take: number): void {
    const coefficients = this.coefficients;
    let gain = this.tailGain;
    const step = this.tailStep;
    for (let i = 0; i < take; i += 1) {
      outLeft[at + i] += this.ladderL.process(0, coefficients) * gain;
      outRight[at + i] += this.ladderR.process(0, coefficients) * gain;
      gain -= step;
    }
    this.tailGain = gain;
    this.tailLeft -= take;
    this.cut -= take;
  }
}

export class Mixer {
  readonly outputRate: number;
  private voices: Voice[] = [];
  private interpolate: Interpolator;
  private engineSampler = true;

  constructor(
    outputRate: number,
    interpolate: Interpolator = INTERPOLATORS[DEFAULT_INTERPOLATOR],
  ) {
    this.outputRate = outputRate;
    this.interpolate = interpolate;
  }

  setInterpolator(interpolate: Interpolator): void {
    this.interpolate = interpolate;
  }

  /**
   * Whether voices read through the engine's own sampler (linear plus octave
   * mipmaps, `readMipped`) or through the mixer's `Interpolator`.
   *
   * **On is the faithful setting and the default.** Off exists so a different
   * interpolator can be compared against it; it also takes effect only for
   * samples that were loaded with mip chains.
   */
  setEngineSampler(on: boolean): void {
    this.engineSampler = on;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  /** Start a voice. `startFrame` is relative to the next render block. */
  play(spec: VoiceSpec): void {
    const delay = Math.max(0, spec.startFrame ?? 0);
    const life =
      spec.endFrame === undefined ? Infinity : Math.max(0, spec.endFrame - delay);
    const cut =
      spec.cutFrame === undefined ? Infinity : Math.max(0, spec.cutFrame - delay);
    this.voices.push(new Voice(spec, delay, life, cut, this.outputRate));
  }

  stopAll(): void {
    this.voices.length = 0;
  }

  /**
   * How many voices the pool is holding, split by whether they have started.
   *
   * A scheduler posts voices ahead of time with a `startFrame` delay, so "how
   * many are there" and "how many can be heard" are different questions and a
   * meter that answered the wrong one would be misleading rather than merely
   * imprecise. Cheap enough to call at a UI rate; not for the audio path.
   */
  counts(): { total: number; sounding: number; notes: number } {
    let sounding = 0;
    // A voice is one of the engine's records -- a note with its layers inside
    // -- so `sounding` is already the polyphony a listener would count. `notes`
    // groups by `tag`, the caller's handle: the player sets it to the note and
    // the keyboard to the key, and a caller may still play one note as several
    // tagged voices. An untagged voice counts as one of its own.
    const tags = new Set<number>();
    let untagged = 0;
    for (const voice of this.voices) {
      if (voice.delay > 0) continue;
      sounding += 1;
      const tag = voice.spec.tag;
      if (tag === undefined) untagged += 1;
      else tags.add(tag);
    }
    return { total: this.voices.length, sounding, notes: tags.size + untagged };
  }

  /**
   * Take a tagged voice away in `frames` frames of its own sounding time.
   *
   * This is the voice pool's theft rather than a note ending: the record is
   * handed to somebody else, so the voice stops where it is instead of
   * releasing. A live scheduler needs it because the pool only learns that a
   * voice must be cut when the note that steals it arrives, which is after the
   * victim was handed over.
   *
   * ⚠️ `frames` counts SOUNDING frames, not wall frames: a voice still waiting
   * out its `startFrame` has not spent any of them. That is the same clock
   * `cutFrame` is converted to in `play`.
   */
  cutAt(tag: number, frames: number): void {
    for (const voice of this.voices) {
      if (voice.spec.tag === tag) voice.cut = Math.max(0, frames);
    }
  }

  /**
   * Move the live expression of every voice carrying `tag`.
   *
   * This is MPE's three dimensions, and it exists because the two the engine
   * already has -- the note's own pitch glide and volume glide -- are baked
   * into `VoiceSpec.automation` before the voice is built, which is fine for a
   * sequencer whose notes know their whole shape in advance and useless for a
   * keyboard where the shape arrives while the note sounds.
   *
   * - `bend` is semitones, signed, and multiplies the rate exactly as a glide
   *   does. There is no limit here: the range belongs to whoever is reading the
   *   controller, and 48 semitones is the MPE default.
   * - `pressure` multiplies the voice gain, 0..1, alongside the glide's own.
   * - `timbre` is an OFFSET added to the instrument's cutoff, -1..1, clamped
   *   into range. ⚠️ **This one is not the engine's**: nothing in the game
   *   moves a cutoff from outside a note. It is here because MPE's Y dimension
   *   has to land somewhere and brightness is what it conventionally means.
   *
   * An omitted field is left where it was, so a controller sending only bend
   * does not silently reset the pressure it never sent.
   */
  expression(tag: number, bend?: number, pressure?: number, timbre?: number): void {
    for (const voice of this.voices) {
      if (voice.spec.tag === tag) voice.setExpression(bend, pressure, timbre);
    }
  }

  /**
   * Close the gate on every voice carrying `tag`, as a key coming up does.
   *
   * ⚠️ **This is the note's own gate, not a stop.** `life` and `hold` are what
   * `Voice.render` reads as "still held" (`held = hold > 0 || life > 0`), so
   * clearing them starts whatever release the voice already has: the amplitude
   * envelope's if it has one, and otherwise the linear fade. It never truncates
   * a sound the engine would have let ring.
   *
   * Voices are left in the pool to finish releasing; `stopAll` is the one that
   * takes them away.
   */
  release(tag: number): void {
    for (const voice of this.voices) {
      if (voice.spec.tag === tag) {
        voice.life = 0;
        voice.hold = 0;
      }
    }
  }

  /**
   * Render one block. `left` and `right` are cleared first, so callers get the
   * mix rather than an accumulation across blocks.
   *
   * `onVoice` is called after each voice is mixed in. It exists because an
   * offline render of a whole song is one call that runs for many seconds, and
   * a progress bar that only tracks the phases *around* it is worse than none:
   * it fills, then freezes for most of the wait. The callback must be cheap and
   * synchronous -- a worker's `postMessage` is, and reaches the main thread
   * without this loop yielding.
   */
  render(
    left: Float32Array,
    right: Float32Array,
    sends?: {
      readonly echo?: readonly [Float32Array, Float32Array];
      readonly reverb?: readonly [Float32Array, Float32Array];
    },
    onVoice?: (done: number, total: number) => void,
  ): void {
    const frames = Math.min(left.length, right.length);
    left.fill(0);
    right.fill(0);
    sends?.echo?.[0].fill(0);
    sends?.echo?.[1].fill(0);
    sends?.reverb?.[0].fill(0);
    sends?.reverb?.[1].fill(0);

    // A send bus is the same render scaled: rather than render a voice twice,
    // each voice writes into a scratch pair and that is added to dry and to
    // each bus at its own level. The scratch is per render, not per voice.
    const needsSends = sends !== undefined && this.voices.some((v) => v.maySend);
    const scratchL = needsSends ? new Float32Array(frames) : left;
    const scratchR = needsSends ? new Float32Array(frames) : right;

    // Reused across voices: one array, cleared per voice, rather than a fresh
    // one for each of a corpus render's hundreds of thousands.
    const spans: RenderedSpan[] = [];
    const total = this.voices.length;
    let done = 0;
    for (const voice of this.voices) {
      if (onVoice && (done & 0xff) === 0) onVoice(done, total);
      done += 1;
      if (!needsSends || !voice.maySend) {
        voice.render(left, right, frames, this.interpolate, this.engineSampler);
        continue;
      }
      // The scratch is left clean by whoever used it last, so only the spans
      // this voice writes need clearing -- and only those need summing. A voice
      // whose modulation moves reports one span per chunk, each with its own
      // echo send; every other voice reports exactly one.
      spans.length = 0;
      voice.render(scratchL, scratchR, frames, this.interpolate, this.engineSampler, spans);
      for (const span of spans) {
        const { echo, reverb } = span;
        // ⚠️ **Both sends are hoisted out of the frame loop**, and that is worth
        // the four lines: they are constant for the span, and testing them per
        // frame put this loop at 5% of a whole render. The arithmetic is
        // unchanged and so is the output, to the bit.
        const echoL = echo > 0 ? sends.echo?.[0] : undefined;
        const echoR = echo > 0 ? sends.echo?.[1] : undefined;
        const reverbL = reverb > 0 ? sends.reverb?.[0] : undefined;
        const reverbR = reverb > 0 ? sends.reverb?.[1] : undefined;
        for (let i = span.begin; i < span.end; i += 1) {
          const l = scratchL[i];
          const r = scratchR[i];
          left[i] += l;
          right[i] += r;
          if (echoL !== undefined) {
            echoL[i] += l * echo;
            echoR![i] += r * echo;
          }
          if (reverbL !== undefined) {
            reverbL[i] += l * reverb;
            reverbR![i] += r * reverb;
          }
        }
        scratchL.fill(0, span.begin, span.end);
        scratchR.fill(0, span.begin, span.end);
      }
    }
    onVoice?.(total, total);
    // A voice that ran out mid-block has already written what it had.
    this.voices = this.voices.filter((v) => !v.finished);
  }
}
