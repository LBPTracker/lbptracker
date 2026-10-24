/**
 * Note -> playback parameters.
 *
 * The pitch formula is the one in steering/sequencer-engine-inputs.md, which
 * follows directly from the recovered field names and from the way the shipped
 * banks are laid out (one sample per octave: piano_C2..C6, epiano_C1..C5,
 * triangle_synth_C2..C6).
 *
 * Two constants in here are NOT measured and are marked as such. Keep them in
 * this one file so that closing the open questions is a small edit rather than
 * a hunt.
 */

import type { SampleSlot } from '@lbptracker/cwlib/rinstrument.ts';
import type { Instrument } from './instrument.ts';
import { resolveSlot } from './instrument.ts';

/**
 * **MEASURED: `fineTune` is in semitones.** `0x1d8c`-`0x1dc2` in
 * `fmodextinput.prx` adds the slot's f32 straight into the semitone sum,
 * alongside the note and the root note, before the single division by 12:
 *
 * ```
 * xmm1  = t * voice.pitchSlide + voice.pitch    // semitones
 * xmm1 += [slot + 0x8c]                         // fineTune  <- same units
 * xmm1 -= (float)[slot + 0x84]                  // rootNote
 * exp2f(xmm1 * 0.0833333)                       // 1/12
 * ```
 *
 * It was 100 (cents) on a coin-flip; open question 5 is closed.
 */
export const FINETUNE_PER_SEMITONE = 1;

/** The engine's output rate. Its plugin is written for it and nothing else. */
export const ENGINE_RATE = 48000;

/**
 * ✔ Measured: the engine's step is `720000 / tempo` frames (`0x0bf7`), and at
 * its default tempo of 125 that is `48000 * 60 / (125 * 4)` -- four steps to
 * the beat at 48 kHz. `swing.ts` has the reading.
 */
export const STEPS_PER_BEAT = 4;

export interface VoiceParams {
  /** Index into the instrument's slots. */
  readonly slot: number;
  /**
   * Sample frames to advance per output frame. 1 means the sample plays at its
   * own rate; 2 means an octave up.
   */
  readonly playbackRate: number;
  /** Linear gain, 0..1. */
  readonly gain: number;
  /** 0 = hard left, 0.5 = centre, 1 = hard right. */
  readonly pan: number;
}

export interface VoiceRequest {
  readonly note: number;
  /** Note record volume, 0..127. */
  readonly volume: number;
  readonly instrument: Instrument;
  /** Per-instrument gain, `PInstrument.Level`. */
  readonly level: number;
  /** `PInstrument.Pan`, 0..1 centred at 0.5. */
  readonly pan: number;
  /**
   * The sample's own rate.
   *
   * ⚠️ **Ignored, as the engine ignores it**: the loader never reads the
   * `fmt ` rate and the plugin plays a frame per output frame at ratio 1.
   * Kept so a caller carrying it need not change.
   */
  readonly sampleRate: number;
  /** The output device's rate. */
  readonly outputRate: number;
  /** `PSequencer.Tempo`, only used when the slot has `fitBpm`. */
  readonly tempo: number;
}

/**
 * The pitch ratio for one note on one slot, before the sample-rate conversion.
 *
 * ```
 * ratio = 2 ^ ((note - baseNote + fineTune) / 12)
 * if !pitched: ratio = 1            // percussion plays at a fixed rate
 * if fitBpm:   ratio *= tempo / baseBpm
 * ```
 *
 * **This shape is confirmed against the engine**, not inferred: the branch
 * structure, the order of the terms and the `tempo / baseBpm` factor all match
 * `0x1d71`-`0x1e1f` in `fmodextinput.prx` exactly. See steering/synth-engine.md.
 *
 * ❗ **There is no sample-rate term in it, and none anywhere else.** The
 * eboot's loader (`v0xb3e520`) reads `nChannels` out of `fmt ` and nothing
 * more -- never the rate -- and hands the frames to the plugin as they are, so
 * a frame is a frame at 48 kHz whatever the file said. 42 of the 216 shipped
 * `.smp` are 44.1 kHz (`ukulele`, `record_static`, five kits) and the game
 * plays them 8.8% fast, +1.47 semitones. So does this, since 2026-09-08; it
 * used to correct them (*43* in steering/answered-questions.md).
 */
export function pitchRatio(
  slot: SampleSlot,
  note: number,
  tempo: number,
): number {
  let ratio = 1;
  if (slot.pitched) {
    const semitones =
      note - slot.baseNote + slot.fineTune / FINETUNE_PER_SEMITONE;
    ratio = 2 ** (semitones / 12);
  }
  if (slot.fitBpm && slot.baseBpm > 0) {
    ratio *= tempo / slot.baseBpm;
  }
  return ratio;
}

/**
 * Note velocity to linear gain.
 *
 * ✔ Measured: `0x3c29`-`0x3c3a` takes bits 16..23 of the note word with
 * `bextr` and multiplies by `1/127` (`v0x45a0`), linear in amplitude, once per
 * block from the current control point. The default written by the editor is
 * 0x60 (96).
 */
export function velocityGain(volume: number): number {
  return Math.max(0, Math.min(127, volume)) / 127;
}

/** Everything a voice needs to start playing one note. */
export function voiceFor(request: VoiceRequest): VoiceParams {
  const slot = resolveSlot(request.instrument, request.note);
  const definition = request.instrument.slots[slot];
  const ratio = pitchRatio(definition, request.note, request.tempo);
  return {
    slot,
    playbackRate: ratio * (ENGINE_RATE / request.outputRate),
    gain: velocityGain(request.volume) * request.level,
    pan: request.pan,
  };
}

/**
 * **MEASURED: the pan law is linear.** `left = 1 - pan`, `right = pan`, 0..1
 * with 0.5 centred.
 *
 * Read straight off the renderer at `0x2d39`-`0x2dda` in `fmodextinput.prx`,
 * where the voice's pan value `p` becomes the two per-channel factors:
 *
 * ```
 * xmm3  = 1 - p        ; left
 * xmm10 = p            ; right
 * ...
 * L += (1 - p) * gain * sample
 * R +=      p  * gain * sample
 * ```
 *
 * ⚠️ **This was equal-power here for most of the project's life, and that was
 * wrong.** A linear law is about 3 dB quieter at the centre than an equal-power
 * one and its perceived loudness dips as a sound crosses the middle -- audible
 * on anything panned, and on everything once auto-pan (LFO 3) is running.
 * Equal-power is the better-sounding choice and it is not the game's, so it
 * does not belong in a faithful tracker.
 */
export function panGains(pan: number): { left: number; right: number } {
  return panGainsInto(pan, { left: 0, right: 0 });
}

/** `panGains` writing into a caller-owned object. Same arithmetic. */
export function panGainsInto(
  pan: number,
  out: { left: number; right: number },
): { left: number; right: number } {
  const p = pan < 0 ? 0 : pan > 1 ? 1 : pan;
  out.left = 1 - p;
  out.right = p;
  return out;
}

/** Output frames per sequencer step. */
export function samplesPerStep(
  outputRate: number,
  tempo: number,
  stepsPerBeat = STEPS_PER_BEAT,
): number {
  if (tempo <= 0) throw new RangeError(`tempo must be > 0, got ${tempo}`);
  return (outputRate * 60) / (tempo * stepsPerBeat);
}
