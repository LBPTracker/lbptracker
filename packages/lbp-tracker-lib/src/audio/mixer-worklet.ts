/**
 * The AudioWorkletProcessor. A thin shell around Mixer.
 *
 * Everything that decides what the output sounds like lives in mixer.ts, which
 * is plain TypeScript with no Web Audio: that is what lets the same code be
 * unit-tested under `node --test` and re-run under OfflineAudioContext for
 * export, and it is why a render is reproducible rather than
 * browser-dependent. Keep this file boring.
 *
 * This module is loaded with `audioWorklet.addModule()`, so it runs in the
 * AudioWorkletGlobalScope and cannot import anything platform-specific.
 */

import { Echo, Reverb, clipToUnit, reverbPreset } from './effects.ts';
import { MasterStage, type MasterChoice } from './master-stage.ts';
import { INTERPOLATORS, type InterpolatorName } from './interpolate.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from './mixer.ts';
import { buildMipChain } from './mipmap.ts';
import { LoadMeter, Spinner } from './load-meter.ts';

/** A sample handed over from the main thread, with its channels transferred. */
export interface SamplePayload {
  readonly id: string;
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly loop?: { start: number; end: number };
  /** `SampleBuffer.smoothed`'s channels, when the sample has them. */
  readonly smoothed?: Float32Array[];
}

export type MixerMessage =
  | { type: 'load'; sample: SamplePayload }
  /**
   * ⚠️ **A `VoiceSpec.random` cannot cross a thread** -- it is a function, and
   * `postMessage` drops it. That used to mean a scheduler wanting the render's
   * exact LFO phases had to draw them on its own side and send them alongside;
   * it does not any more. `VoiceSpec.lfoPhase` holds them as three plain
   * numbers, drawn once per note by the render, and an array crosses.
   */
  | {
      type: 'play';
      sampleId: string;
      voice: Omit<VoiceSpec, 'sample'>;
      /**
       * The context frame the voice starts at; its `startFrame`, `endFrame`
       * and `cutFrame` then count from there. ❗ Absent, they count from the
       * next block the message is handled before -- and a scheduler on the
       * main thread cannot know which block that is: its look-ahead bursts
       * landed a whole render quantum apart from one another, 128 frames, by
       * when the message happened to arrive. On the engine's clock that breaks
       * the very grid the voices are placed on.
       */
      at?: number;
    }
  // 'engine' is not an interpolator: it selects the game's own sampler, which
  // is linear plus octave mipmaps and is the faithful setting. The named
  // interpolators switch it off so they can be heard against it.
  | { type: 'interpolator'; name: InterpolatorName | 'engine' }
  /**
   * Rebuild the output stage. Everything here is a sequencer field, so a
   * keyboard can offer exactly what a song can set.
   *
   * ⚠️ **This allocates**, so it runs in the message handler and never in
   * `process`. The echo sizes its delay line from its parameters, so every
   * message is a new one and a lost tail. The reverb is kept while its setting
   * is, and the preset re-applied, as the game's setters do; see the handler.
   */
  | {
      type: 'effects';
      echoTime: number;
      framesPerStep: number;
      feedback: number;
      mix: number;
      reverbSetting: number;
      echoOn: boolean;
      reverbOn: boolean;
      clip: boolean;
      /**
       * Which master bus ends the chain; the game's when absent. See
       * `master-stage.ts`.
       */
      master?: MasterChoice;
    }
  /** Close the gate on the voices carrying `tag`; see `Mixer.release`. */
  | { type: 'release'; tag: number }
  /** Take a tagged voice away after `frames` more of its own sounding time. */
  | {
      type: 'cutAt';
      tag: number;
      frames: number;
      /**
       * The context frame of the theft, and of the victim's own start: the
       * frames it still sounds are then counted here, for the same reason as
       * `play.at`. Absent, `frames` counts from the next block.
       */
      at?: number;
      began?: number;
    }
  /**
   * Move a sounding voice's live expression; see `Mixer.expression`.
   *
   * ⚠️ **One message per dimension per controller frame is the wrong shape.**
   * An MPE controller sends bend, pressure and slide as separate MIDI messages
   * at up to a few hundred hertz each, and every one of them crosses a thread
   * boundary. The fields are all optional so a sender may coalesce a frame's
   * worth into one message; omitted ones keep their current value rather than
   * resetting, which is what makes coalescing safe.
   */
  | {
      type: 'expression';
      tag: number;
      bend?: number;
      pressure?: number;
      timbre?: number;
    }
  /**
   * Forget the load: every start. Sound lost is the page's to count, off the
   * output's own clock (`DropoutCounter` in `dropouts.ts`).
   */
  | { type: 'resetHealth' }
  | { type: 'stopAll' };

declare const sampleRate: number;
/** The frame of the block about to be rendered: the scope's own, read off `globalThis` so a test can run without one. */
const blockFrame = (): number => (globalThis as { currentFrame?: number }).currentFrame ?? 0;
declare function registerProcessor(
  name: string,
  processor: typeof MixerProcessor,
): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

export class MixerProcessor extends AudioWorkletProcessor {
  private readonly mixer = new Mixer(sampleRate);
  private readonly samples = new Map<string, SampleBuffer>();

  /*
   * The output stage, live.
   *
   * This is the same chain `packages/lbp-tracker-lib/src/render.ts` runs offline and in the same
   * order (`fmodextinput.prx` 0x07c0): the echo's wet is added to the dry pair
   * *and* to the reverb send pair, all four are clipped to +-1, and only then
   * does the reverb see its input. Keeping the two in step matters more than
   * either one being convenient -- a bench that flatters the render is worse
   * than no bench.
   */
  private echo: Echo | null = null;
  private reverb: Reverb | null = null;
  private echoOn = false;
  private reverbOn = false;
  private clip = true;
  /**
   * The master bus: the game's -- `SMS WaveHammer` and the 7.1 fold -- unless
   * the page picks it with the AGC, ours or none.
   *
   * It lives here rather than in the caller because the WaveHammer's detector
   * and envelope are stateful across blocks; `render.ts` runs the same class
   * over the same signal at the same point, so the two paths agree. Built at
   * the context's own rate: the page's player runs at 48 kHz, the game's, but
   * the keyboard's context takes the device's.
   */
  private readonly master = new MasterStage(sampleRate);
  /**
   * Frames since the last voice-count report.
   *
   * The count is posted on a timer rather than per block: a render quantum is
   * 128 frames, which would be nearly four hundred messages a second for a
   * number a person reads ten times a second at most.
   */
  private sinceReport = 0;
  /**
   * How much of the audio thread's time this takes: the "audio %" figure.
   *
   * ⚠️ **Not a sum of `Date.now()` around each `process()` any more**, which is
   * what this was until 2026-10-04: the clock ticks once a millisecond and the
   * callbacks come every 10 ms exactly, so that sum read whatever the callback's
   * place in the millisecond said -- five times under the truth for half a
   * minute, measured. `LoadMeter` has the measurements and the cure.
   */
  private readonly meter = new LoadMeter(Date.now, Math.random, new Spinner().wait);
  /** Send buses, grown on demand. A render quantum is 128 frames today. */
  private echoL = new Float32Array(128);
  private echoR = new Float32Array(128);
  private reverbL = new Float32Array(128);
  private reverbR = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MixerMessage>) => {
      this.handle(event.data);
    };
  }

  private handle(message: MixerMessage): void {
    switch (message.type) {
      case 'load':
        this.samples.set(message.sample.id, {
          channels: message.sample.channels,
          sampleRate: message.sample.sampleRate,
          loop: message.sample.loop,
          // Built here, at load, because that is when the game builds them --
          // and because a voice must never allocate on the audio thread. Costs
          // 50% more memory per sample and buys the engine's own anti-aliasing
          // above one octave up. See packages/lbp-tracker-lib/src/audio/mipmap.ts.
          mips: message.sample.channels.map((c) => buildMipChain(c)),
          ...(message.sample.smoothed
            ? { smoothed: { channels: message.sample.smoothed, mips: message.sample.smoothed.map((c) => buildMipChain(c)) } }
            : {}),
        });
        break;
      case 'play': {
        const sample = this.samples.get(message.sampleId);
        // Dropping a voice for a sample that never arrived is the right
        // failure: silence beats a crash mid-render, and the id is reported.
        if (!sample) {
          this.port.postMessage({ type: 'missingSample', id: message.sampleId });
          return;
        }
        // The file's own pan, untouched: the plugin takes it as written. The
        // stereo fold's narrowing used to be applied here from a `panWidth`
        // message; it is FMOD's, after the clip and the compressor, so the
        // game's master bus applies it now (`master-stage.ts`).
        // On an absolute frame, the delay is counted here, from this block.
        const shift = message.at === undefined ? 0 : Math.max(0, Math.round(message.at - blockFrame()));
        const voice = message.voice;
        this.mixer.play({
          ...voice,
          sample,
          pan: voice.pan,
          ...(shift === 0 ? {} : {
            startFrame: shift + (voice.startFrame ?? 0),
            endFrame: voice.endFrame === undefined ? undefined : shift + voice.endFrame,
            cutFrame: voice.cutFrame === undefined ? undefined : shift + voice.cutFrame,
          }),
        });
        break;
      }
      case 'interpolator':
        this.mixer.setEngineSampler(message.name === 'engine');
        if (message.name !== 'engine') {
          this.mixer.setInterpolator(INTERPOLATORS[message.name]);
        }
        break;
      case 'effects':
        this.echoOn = message.echoOn;
        this.reverbOn = message.reverbOn;
        this.clip = message.clip;
        // ⚠️ Kept, not rebuilt: this message comes on every tempo change, and a
        // rebuilt WaveHammer would let its envelope go back to unity mid-song.
        this.master.set(message.master ?? 'game');
        this.echo = message.echoOn
          ? new Echo(
              sampleRate,
              message.echoTime,
              message.framesPerStep,
              message.feedback,
              message.mix,
            )
          : null;
        // ⚠️ The reverb is kept too, whatever the setting: this message comes
        // on every plan load as well, and a new `Reverb` cut the tail each
        // time. The game re-applies the preset to the chain it has: every
        // setter of the playing sequencer ends in `v0x1c6250`, which re-applies
        // it at `v0x1c6405` -- on the same preset that zeroes the input
        // one-pole's and the notch's state and nothing else, and on another it
        // changes the coefficients over the lengths the reverb was built with
        // (*SMS Reverb* in steering/lbp-audio-engine.md). So a changed setting
        // keeps the first one's room sizes, as in the game: the owner's choice,
        // 2026-10-12. Only switching the reverb on builds a new one.
        if (!message.reverbOn) {
          this.reverb = null;
        } else if (this.reverb) {
          this.reverb.reconfigure(reverbPreset(message.reverbSetting));
        } else {
          this.reverb = new Reverb(sampleRate, reverbPreset(message.reverbSetting));
        }
        break;
      case 'release':
        this.mixer.release(message.tag);
        break;
      case 'cutAt':
        this.mixer.cutAt(
          message.tag,
          message.at === undefined
            ? message.frames
            : Math.max(0, Math.round(message.at - Math.max(blockFrame(), message.began ?? -Infinity))),
        );
        break;
      case 'expression':
        this.mixer.expression(message.tag, message.bend, message.pressure, message.timbre);
        break;
      case 'resetHealth':
        this.meter.reset();
        break;
      case 'stopAll':
        this.mixer.stopAll();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.meter.begin();
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];

    if (!this.echo && !this.reverb && !this.clip) {
      this.mixer.render(left, right);
      // The master bus is not one of the switchable effects: the fold in it is
      // FMOD's speaker matrix, and it stays on with everything else off, or the
      // level would jump by 4.645 dB on the last switch.
      this.master.run(left, right);
      if (output.length > 1 && right === left) right.set(left);
      this.report(left.length);
      return true;
    }

    const frames = left.length;
    if (this.echoL.length < frames) {
      // Only ever on a quantum change, never per block.
      this.echoL = new Float32Array(frames);
      this.echoR = new Float32Array(frames);
      this.reverbL = new Float32Array(frames);
      this.reverbR = new Float32Array(frames);
    }
    this.mixer.render(left, right, {
      echo: [this.echoL, this.echoR],
      reverb: [this.reverbL, this.reverbR],
    });

    for (let i = 0; i < frames; i += 1) {
      const e = this.echo?.process(this.echoL[i], this.echoR[i]);
      const wetL = e ? e.left : 0;
      const wetR = e ? e.right : 0;
      let dryL = left[i] + wetL;
      let dryR = right[i] + wetR;
      let sendL = this.reverbL[i] + wetL;
      let sendR = this.reverbR[i] + wetR;
      if (this.clip) {
        dryL = clipToUnit(dryL);
        dryR = clipToUnit(dryR);
        sendL = clipToUnit(sendL);
        sendR = clipToUnit(sendR);
      }
      const r = this.reverb?.process(sendL, sendR);
      left[i] = dryL + (r ? r.left : 0);
      right[i] = dryR + (r ? r.right : 0);
    }
    // After the reverb, where `Channel::addDSP` put the WaveHammer and where
    // FMOD's speaker matrix folds 7.1 to stereo; `render.ts` does the same.
    this.master.run(left, right, 0, frames);
    if (output.length > 1 && right === left) right.set(left);
    this.report(left.length);
    return true; // stay alive across silence; the graph decides when to stop
  }

  private report(frames: number): void {
    this.meter.end();
    this.sinceReport += frames;
    if (this.sinceReport < sampleRate / 10) return;
    this.sinceReport = 0;
    const { total, sounding, notes } = this.mixer.counts();
    // The dither's waits are spent only while something is playing.
    this.meter.setActive(total > 0);
    const load = this.meter.report();
    // The AGC's gain rides along, for the engine card: null when it is not chosen.
    const agc = this.master.agcGain;
    this.port.postMessage({ type: 'voices', total, sounding, notes, load, agc });
  }
}

registerProcessor('lbp-mixer', MixerProcessor);
