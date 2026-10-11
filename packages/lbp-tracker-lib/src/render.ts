/**
 * The whole render pipeline, in one platform-neutral function.
 *
 * This is the code `packages/lbp-tracker-lib/dev/render-level.ts` used to be, lifted out of it verbatim
 * so that **the same pipeline runs under Node and in the browser**. The only
 * thing either wrapper supplies is a way to load an instrument by GUID: Node
 * reads files, the browser fetches them, and nothing else differs. Every
 * measured law -- the sampler, the ladder, the envelopes, the LFOs, the voice
 * pool, the sends, the echo, the reverb and the output clip -- lives below and
 * is exercised identically by both.
 *
 * ⚠️ It renders offline into plain `Float32Array`s rather than through
 * `OfflineAudioContext`. That is the point: the browser's own resampler and
 * mixer are exactly what this project must not use (see
 * `steering/tracker-architecture.md`), so the output has to be arithmetic we
 * control, and it has to be bit-identical to the Node render.
 *
 * ✔ **Measured, 2026-09-02**: `This Is Halloween` rendered end to end under Node
 * and in Chrome produced the same **70,704,044-byte** file with the same
 * SHA-256, `1785d0d8ae658eeb726300aa7726b8d9`. ⚠️ That file predates the
 * voice-pool fix later the same day and is no longer what this code produces;
 * what it is evidence for -- that the two hosts run identical arithmetic -- is
 * unaffected. A test cannot drive a browser, so
 * `packages/lbp-tracker-lib/test/render.test.ts` pins the property that made that comparison meaningful:
 * the pipeline is deterministic and depends on its seed and nothing else.
 */

import {
  Echo,
  Reverb,
  clipToUnit,
  reverbPreset,
} from './audio/effects.ts';
import { MasterStage, type MasterChoice } from './audio/master-stage.ts';
import {
  BLOCK_FRAMES,
  DECLICK_SECONDS,
  Mixer,
  type LayerSpec,
  type SampleBuffer,
  type VoiceSpec,
} from './audio/mixer.ts';
import { FILTER_PARAMS } from './audio/moog.ts';
import {
  ADSR_PARAMS,
  ADSR_PARAMS_B,
  envelopeLevelAt,
  evaluateAdsr,
  evaluateParam,
} from './envelope.ts';
import { resolveSlot } from './instrument.ts';
import { LFO_PARAMS, OUTPUT_PARAMS, STACK_PARAMS, echoSendLevel } from './params.ts';
import {
  VOICE_POOL_SIZE,
  allocateVoices,
  walkVelocities,
  type PooledNote,
  type PoolWalks,
} from './polyphony.ts';
import { channelVolume, schedule, type Sequencer } from '@lbptracker/cwlib/project.ts';
import { type RInstrument } from './rinstrument.ts';
import { blockRoot, notePitch } from './scale.ts';
import { swungFrame } from './swing.ts';
import { engineClock } from './engine-clock.ts';
import {
  THIRD32,
  closingWalk,
  detune32,
  engineWalks,
  modulation32,
  param32,
  phase32,
  unit32,
} from './engine-record.ts';
import { clipStepsFor } from './song.ts';
import { pitchRatio, samplesPerStep, velocityGain } from './voice.ts';

/** The output rate. The engine's own is hard-coded to this too. */
export const RATE = 48000;

// The stereo fold's two constants live in `packages/lbp-tracker-lib/src/audio/effects.ts` so the
// AudioWorklet can reach them without importing this module's level stack.
export { FOLD_GAIN, PAN_WIDTH } from './audio/effects.ts';

/** One instrument, with its samples decoded and mipmapped. */
export interface LoadedInstrument {
  readonly inst: RInstrument;
  readonly slots: readonly { readonly wav: SampleBuffer; readonly base: number }[];
}

/** Load an instrument by GUID, or return null when it is not available. */
export type InstrumentLoader = (
  guid: number,
) => Promise<LoadedInstrument | null | undefined>;

/** Progress callback. Returning a promise lets a browser caller yield. */
export type RenderProgress = (
  phase: 'voices' | 'mix' | 'effects',
  done: number,
  total: number,
) => void | Promise<void>;

export interface RenderOptions {
  /** Seconds to render; 0 or absent renders to the end plus the effect tail. */
  readonly secondsArg?: number;
  /** Start offset in seconds, for rendering a window out of the middle. */
  readonly fromArg?: number;
  /** Instrument GUIDs to keep, or empty for all. */
  readonly onlyGuids?: readonly number[];
  /** Instrument GUIDs to drop. */
  readonly skipGuids?: readonly number[];
  /** GUIDs whose slots play at their own rate rather than transposed. */
  readonly unpitchedGuids?: readonly number[];
  /** A/B: any loopless sample plays at its own rate. */
  readonly unpitchedPercussion?: boolean;
  /** A/B: force the filter's key-tracking term to 1. */
  readonly noKeyTrack?: boolean;
  /** Voice pool size; `VOICES_UNLIMITED` removes the cap. */
  readonly voiceLimit?: number;
  /** Whether the plugin's own hard clip to +-1 runs. Defaults to on. */
  readonly clip?: boolean;
  /** GUID -> playback-rate factor, for octave A/Bs. */
  readonly pitchShift?: ReadonlyMap<number, number>;
  /** The PRNG seed. Fixed by default, so a render is reproducible. */
  readonly seed?: number;
  /**
   * Replaces the seeded PRNG outright: every draw a note makes -- the stack
   * layers' start, detune and spread, the three LFO phases -- comes from this.
   *
   * ⚠️ **For differential tests only.** `tools/prxrun.py` runs the game's own
   * `fmodextinput.prx`, whose `rand` is stubbed to a constant there, and a
   * constant here draws the same numbers whatever order the two take them in;
   * the engine's order is not this file's (`0x1a70` draws per layer first and
   * the phases last).
   */
  readonly random?: () => number;
  readonly onProgress?: RenderProgress;
  /**
   * How long a **one-shot** -- a slot whose sample has no loop -- ignores the
   * note's gate.
   *
   * ✔ **`'gate'` is the default and it is the engine's**, settled 2026-09-03
   * against a recording of the game. The other two are kept because they are
   * what this project believed for a while and the difference is small enough
   * that only a measurement separates them. See `holdFramesFor`.
   */
  readonly oneShot?: 'full' | 'natural' | 'gate';
  /**
   * Whether a voice keeps its pool record through the envelope's **release**.
   *
   * ❗ **The engine says yes and a listener says no, and the listener is the
   * one who has heard the game.** `sub_0x1c60` frees a record when the envelope
   * reaches zero (`0x2089` → `0x20e0` → `0x3093`), which is this option ON.
   * With it on, `C4K3 S0NG` cuts 2,923 of its 13,091 notes instead of 1,411 —
   * and at **25.85 s the choir's five-note chord loses four of them at onset**,
   * which is not in the game. Off, nothing is cut there at all.
   *
   * ⚠️ **Default OFF, which is the unmeasured reading.** That is deliberate and
   * uncomfortable: shipping an artefact the game does not have is worse than
   * shipping a model that is short. Question 29 in `steering/open-questions.md`
   * holds the contradiction, and 25.85 s of `C4K3 S0NG` is its reproducer — a
   * capture of the game at that bar settles it in one listen.
   */
  readonly releaseTail?: boolean;
  /**
   * Soften how a note's natural end clicks: a release of at least 20 ms, and a
   * 20 ms fade on the ladder's tail after the sound ends. See
   * `VoiceSpec.declick`.
   *
   * ⚠️ **Default ON, which is not the engine's.** By the bytes the game clicks
   * too (`0x1f65`, `0x3093`); the project's owner heard `triangle_wave` and
   * `e_perc_1` click on *Rhombitruncated* and the 20 ms release silence them,
   * and asked for them gone. Question 61 in `steering/open-questions.md`; off
   * renders the engine as read.
   */
  readonly declick?: boolean;
  /**
   * Run the reverb. Default true.
   *
   * For comparing against a recording of the game with its reverb turned off:
   * the reverb is a whole DSP with its own eleven-slot preset, and taking it out
   * of both sides leaves the voice chain on its own to be judged.
   *
   * ⚠️ This zeroes the reverb's **return**, not its send. The send still feeds
   * the output clip, which is where the engine's non-linearity lives, so a
   * no-reverb render is not simply "the same render minus a tail".
   */
  readonly reverb?: boolean;
  /** Run the echo. Default true. Same reasoning as `reverb`. */
  readonly echo?: boolean;
  /**
   * Place onsets, gates and steals where the engine's step clock puts them:
   * on its 256-frame blocks, a chunk after the step (`engine-clock.ts`).
   *
   * ⚠️ **Default off, which is not the engine's.** The tracker starts a note on
   * its own frame -- *3* in steering/open-questions.md, a decision with the
   * capture that would settle it -- and this is the engine as measured, for
   * a differential test against the module and for an A/B.
   */
  readonly engineClock?: boolean;
  /**
   * The master bus: what follows `SMS Reverb`, where the sequencer's chain ends
   * (`audio/master-stage.ts`).
   *
   * ✔ **Default `'game'`, the game's**: `SMS WaveHammer` as the game ships it,
   * then the 7.1 fold a stereo listener hears, its gain and its narrowing.
   * Settings put **ours** there instead -- the fold's gain, then the glue and
   * the limiter of `audio/master.ts`, nothing the game does (question 42 in
   * steering/open-questions.md). `'none'` is the fold's gain alone, the
   * file's own image and no compressor: this renderer's default until 0.2.43.
   *
   * ⚠️ The game's bus compresses whatever crest factor reaches it, and whether
   * ours is the game's is question 38 in steering/open-questions.md.
   */
  readonly master?: MasterChoice;
  /**
   * Called with every voice as it is handed to the mixer, and with the identity
   * of the sample it plays.
   *
   * ⚠️ **This exists so that live playback is not a second implementation.**
   * Building a voice from a note is where nearly every measured law in this
   * project ends up -- the key splits, the pitch formula, the modulation point,
   * the stack layers, the sends, the pan width, the voice pool's cuts -- and a
   * realtime player that rebuilt any of it would drift from the render silently.
   * With this it schedules exactly the voices the render would have mixed.
   *
   * `startFrame` is absolute, in output frames from the start of the render.
   */
  readonly onVoice?: (
    voice: VoiceSpec,
    where: {
      guid: number;
      zone: number;
      /** Which of `seq.tracks` the voice came from, so a player can replace one track's voices. */
      track: number;
      startFrame: number;
      /**
       * What the voice pool sees: the note's occupancy in STEPS, and its score.
       *
       * A live scheduler that wants to run the pool itself needs exactly these
       * four -- `allocateVoices` uses nothing else -- and it needs them in the
       * allocator's own units, which are steps rather than frames because that
       * is what the engine counts.
       */
      poolStart: number;
      poolEnd: number;
      score: number;
      /**
       * The score after each walk the note sees, in the same steps as
       * `poolStart` -- `PooledNote.walks`, which a live pool needs beside
       * `score` to steal the note the engine would once its volume falls.
       */
      walks: PoolWalks;
      /**
       * The note this voice is.
       *
       * ❗ **One call per note, its every layer inside `voice.layers`**: one
       * `VoiceSpec` is one of the engine's 32 records, and `0x1c60` plays all
       * of a record's layers out of it (question 17 in
       * `steering/answered-questions.md`), so a live scheduler running the pool
       * itself asks it once per call.
       */
      note: number;
      /**
       * What a live scheduler needs to re-place this voice without re-planning.
       *
       * ❗ **Tempo, swing and the channel mixer are the three settings a
       * listener turns while the music runs**, and none of them changes a voice
       * -- they change WHERE it starts, HOW LONG it lasts and HOW LOUD it is.
       * So they are given here as the musical coordinates and the one gain
       * factor they own, and `packages/lbp-tracker-web/src/live.ts` re-derives the frames and the gain
       * per note instead of rebuilding the plan.
       *
       * ⚠️ Tempo is only free of the voice because **no instrument the game
       * ships sets `fitBpm`** -- 0 of 68, measured in `packages/lbp-tracker-lib/test/instrument.test.ts`.
       * One that did would have its playback rate scaled by the tempo, and this
       * would be wrong for it.
       */
      startStep: number;
      endStep?: number;
      /** The board row, which picks the mixer channel through `NumChannels`. */
      row: number;
      /** `channelVolume`'s factor, already inside `voice.gain`. */
      channelGain: number;
      /**
       * The placement's `Level`, on its own.
       *
       * `0x04d4`: the engine allocates no record when `channelVolume × Level`
       * is not positive, so a live scheduler with the faders in its hands has
       * to make that test itself, per note, as the faders stand.
       */
      level: number;
      /**
       * Each control point's offset from the note's start, **in steps**.
       *
       * ❗ `automation` and `morph.points` carry FRAMES from the voice's own
       * start, and those frames were bent by both the tempo and the swing --
       * `swungFrame(step + offset) - swungFrame(step)`. A live scheduler that
       * changes either has to rebuild them, and this is the only thing it needs
       * to. In the same order as `automation`.
       */
      pointSteps: readonly number[];
    },
  ) => void;
  /**
   * Build the voices and stop, without mixing or running the effects.
   *
   * The returned buffers are empty and every audio statistic is zero; what is
   * worth having is `onVoice` and the counts. Pointless without `onVoice`.
   */
  readonly planOnly?: boolean;
}

export interface RenderResult {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly frames: number;
  readonly seconds: number;
  readonly framesPerStep: number;
  readonly events: number;
  readonly played: number;
  readonly skipped: number;
  readonly stolen: number;
  /** GUID -> how many of its notes the pool cut short. */
  readonly stolenBy: ReadonlyMap<number, number>;
  /** Echo and reverb level as a fraction of the dry mix, by RMS. */
  readonly echoRel: number;
  readonly reverbRel: number;
  readonly clippedFrames: number;
  /**
   * The deepest gain `SMS WaveHammer` applied, its constant −1.84 dB included,
   * or 1 when the master bus is not the game's.
   */
  readonly compressorGain: number;
  readonly peak: number;
  readonly rms: number;
  readonly echo: Echo;
  readonly reverb: Reverb;
  readonly preset: readonly number[];
  /**
   * How long each phase took, in milliseconds.
   *
   * Not decoration: a progress bar has to weight the phases by their real cost
   * or it lies, and these are where `packages/lbp-tracker-web/src/render-app.ts`'s weights come from.
   */
  readonly timings: { readonly voicesMs: number; readonly mixMs: number; readonly effectsMs: number };
}

/**
 * A note's length to its gate as the walk closes it (`closingWalk`): the
 * file's `endPosition − startPosition + 1`, plus the walks the cursor lost to
 * records bunched inside a step. Only those notes change, by whole steps, so
 * every other note keeps its duration to the bit.
 */
function walkedDuration(e: {
  readonly step: number;
  readonly durationSteps: number;
  readonly points: readonly { readonly step: number }[];
}): number {
  const steps = e.points.map((point) => Math.floor(Math.round((e.step + point.step) * 3) / 3));
  const late = closingWalk(steps) - (steps[steps.length - 1] + 1);
  return late > 0 ? e.durationSteps + late : e.durationSteps;
}

/** Render one sequencer end to end. */
export async function renderSequencer(
  seq: Sequencer,
  loadInstrument: InstrumentLoader,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const {
    secondsArg = 0,
    fromArg = 0,
    onlyGuids = [],
    skipGuids = [],
    unpitchedGuids = [],
    unpitchedPercussion = false,
    noKeyTrack = false,
    voiceLimit = VOICE_POOL_SIZE,
    clip = true,
    pitchShift = new Map<number, number>(),
    oneShot = 'gate',
    releaseTail: withReleaseTail = false,
    declick: withDeclick = true,
    reverb: withReverb = true,
    echo: withEcho = true,
    engineClock: withEngineClock = false,
    master: masterChoice = 'game',
    onVoice,
    planOnly = false,
    onProgress,
  } = options;
  // The two A/Bs that play a slot at its own rate, whatever its `pitched`.
  const forcedUnpitched = (wav: SampleBuffer, guid: number): boolean =>
    (unpitchedPercussion && wav.loop === undefined) || unpitchedGuids.includes(guid);
  const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
  const voicesStarted = now();
  // ⚠️ That claim used to be false: `VoiceSpec.random` was never set, so the LFO
  // phases came from `Math.random` and two runs of the same build produced
  // different files. It surfaced when a hash was used to check that an
  // optimisation had not changed the output -- the hash changed on every run.
  let seed = options.seed ?? 0x2545f491;
  const rand = options.random ?? (() => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 0x100000) / 0x100000;
  });

  const framesPerStep = samplesPerStep(RATE, seq.tempo);
  // End to end means the last step plus whatever tail the effects still have
  // to give: a reverb cut off at the final note is not the whole render.
  const TAIL_SECONDS = 6;
  const fullSeconds = (seq.lengthSteps * framesPerStep) / RATE + TAIL_SECONDS;
  // ⚠️ `fullSeconds` measures the whole song, so rendering "to the end" from an
  // offset is what is left of it -- otherwise a start of 60 s appends 60 s of
  // silence past the last note.
  const seconds = secondsArg > 0 ? secondsArg : Math.max(1, fullSeconds - fromArg);
  const frames = Math.round(seconds * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const mixer = new Mixer(RATE);

  const fromFrame = Math.round(fromArg * RATE);
  const fromStep = fromFrame / framesPerStep;
  // Frames for a position in steps, on the render's clock: the tracker's own
  // (swung, to the frame) unless the engine's was asked for.
  const clock = withEngineClock
    ? engineClock(seq.tempo, seq.swing, frames, fromStep)
    : undefined;
  const onsetAt = (step: number): number =>
    clock ? clock.onsetFrame(step + fromStep) : Math.round(swungFrame(step, framesPerStep, seq.swing));
  const gateAt = (step: number): number =>
    clock ? clock.gateFrame(step + fromStep) : Math.round(swungFrame(step, framesPerStep, seq.swing));
  const walkAt = (step: number): number =>
    clock ? clock.walkFrame(step + fromStep) : Math.round(swungFrame(step, framesPerStep, seq.swing));
  // ❗ **Which clips the walk lets spawn** (`0x0280`). It scans the clip
  // headers from the LAST to the first with a mask of the rows already taken,
  // starting empty (`0x0f15`): a clip on a taken row is skipped (`0x035d`),
  // as is one not yet started or past its length (`0x036e`, `0x0393`), and an
  // active one takes its row (`0x05d9`) -- one clip per row, the later header
  // winning. ❗ And the scan **stops once rows 0..7 are all taken**
  // (`0x05dc`, `cmp esi, 0xff`), so with every one of the first eight rows
  // busy a clip on row 8 or below that the scan has not reached yet never
  // spawns: measured on song 179190, whose row 8 the module drops from step
  // 128, where rows 0, 1, 5 and 7 come in. The length is `PInstrument+0x60`,
  // which nothing reads yet (steering/open-questions.md); the editor's rule
  // from the highest record stands in for it.
  const clipSpan = seq.tracks.map((track) => {
    let highest = 0;
    for (let i = 0; i + 4 <= track.records.length; i += 4) {
      highest = Math.max(highest, track.records[i] & 0x7f);
    }
    return { start: Math.max(0, track.gridX) * 16, length: clipStepsFor(highest), row: track.gridY };
  });
  const activeAt = new Map<number, Set<number>>();
  const spawns = (trackIndex: number, step: number): boolean => {
    let active = activeAt.get(step);
    if (active === undefined) {
      active = new Set<number>();
      let mask = 0;
      for (let k = clipSpan.length - 1; k >= 0; k -= 1) {
        const { start, length, row } = clipSpan[k];
        const bit = 1 << (row & 31);
        if ((mask & bit) !== 0) continue;
        const rel = step - start;
        if (rel < 0 || rel >= length) continue;
        active.add(k);
        mask = (mask | bit) >>> 0;
        if (mask === 0xff) break;
      }
      activeAt.set(step, active);
    }
    return active.has(trackIndex);
  };
  const events = schedule(seq)
    .filter((e) => spawns(e.track, Math.floor(e.step)))
    .filter((e) => e.step * framesPerStep < fromFrame + frames)
    .map((e) => ({ ...e, durationSteps: walkedDuration(e) }))
    .map((e) => ({ ...e, step: e.step - fromFrame / framesPerStep }))
    .filter((e) => (e.step + e.durationSteps) * framesPerStep > 0)
    .filter((e) => (onlyGuids.length === 0 || onlyGuids.includes(e.guid)))
    .filter((e) => !skipGuids.includes(e.guid));

  /**
   * How long a one-shot's gate is held open, in output frames.
   *
   * ## The rule this replaces, and why the corpus refutes it
   *
   * Question 10 established that percussion cannot be gated by its note: 89.4%
   * of the corpus's 673,037 percussion notes last two steps or fewer, and
   * `a_kit_1`'s amplitude envelope is a bare gate, so gating clips a 0.806 s
   * kick to 0.083 s. The rule written from that was **a loopless sample is
   * never gated and plays to the end of the sample**, and it is unbounded.
   *
   * ⚠️ Unbounded is where it breaks, because the length it grants is the
   * *stretched* one. `mime_artist` is four **plucks** (`pluck_a6`..`pluck_a3`,
   * 9,142 frames each, no `smpl` chunk) at base notes 81, 69, 57, 45, with
   * `Numstack` 5. `Ascetic` plays it at notes 13-24 -- 57 to 68 semitones under
   * the base -- so a 0.19 s pluck becomes **9.02 s**, five voices at a time,
   * against notes the composer wrote **0.12 s** long. Measured over that
   * sequencer: peak demand **216 voices, 200 of them `mime_artist`**, against a
   * pool of 32, and its notes score highest so the allocator steals everything
   * else first. A published level cannot sound like that, so the rule is wrong
   * before the pool ever gets involved.
   *
   * ## What it is instead
   *
   * The exemption grants the sample **its own duration**, at its own rate --
   * `sampleFrames * RATE / sampleRate` output frames -- rather than however long
   * the note's pitch happens to stretch it to. A sample's length is a property
   * of the sample; the stretch is a property of the note, and the note already
   * has a gate.
   *
   * For percussion this changes nothing: a kit plays at rate 0.45-1.33, so the
   * natural duration and the stretched one are the same thing, and question 10's
   * drum measurements stand. For `mime_artist` at rate 0.02 it is the difference
   * between a 0.12 s thud -- a pluck's attack at a fiftieth speed, which is what
   * a composer reaching for the bottom octave of a pluck is after -- and a nine
   * second drone.
   *
   * ✔ **SETTLED 2026-09-03, and not in favour of any of this.** The engine
   * gates every voice -- `0x1f65` reads the gate flag and hands it to the
   * envelope with no branch on the loop -- and a recording of the game agrees:
   * `'gate'` beat both of the others in **eight two-second blocks out of
   * eight**. The default is `'gate'`, for which this function returns 0, so the
   * exemption below is now reachable only through `options.oneShot`.
   *
   * ⚠️ Why it took so long is worth keeping: the drums that motivated the
   * exemption were being rendered with the **wrong kick sample**, because two
   * GUIDs collided on one filename. See *10* in
   * `steering/answered-questions.md`.
   */
  const holdFramesFor = (sample: SampleBuffer): number => {
    if (sample.loop !== undefined) return 0;
    if (oneShot === 'gate') return 0;
    if (oneShot === 'full') return Infinity;
    // A frame per output frame: the engine never reads the file's rate.
    return sample.channels[0].length;
  };

  // ## Resolving every note before the pool runs, and why
  //
  // The pool has to be told how long a voice actually holds a record, and that
  // is not the note's written length. A **one-shot** -- a slot whose sample has
  // no loop -- ignores the gate and plays the whole sample, stretched by 1 over
  // the playback rate, and the rate is not known until the instrument is loaded
  // and its key zone resolved. So that happens here, first, and the play loop
  // below reuses what this pass worked out instead of doing it again.
  //
  // ⚠️ **Getting this wrong is not a rounding error.** On `Ascetic` the pool was
  // told `mime_artist`'s notes were two steps long. They are loopless, five
  // stack layers each, and sit 68 semitones below the sample's base note, so
  // each one really held **five** voices for **9.5 seconds** -- 1,760 voices
  // sounding at once against the engine's 32. It is why that render was slow and
  // why its low end was a smear.
  interface Prepared {
    readonly loaded: LoadedInstrument;
    readonly note: number;
    readonly zone: number;
    readonly playbackRate: number;
    /** Output frames for which this voice's gate is forced open. */
    readonly holdFrames: number;
    readonly layers: number;
    /** Steps this voice occupies a pool record, gate or no gate. */
    readonly occupancySteps: number;
  }
  const prepared: (Prepared | null)[] = [];
  for (const [i, event] of events.entries()) {
    if (onProgress && (i & 0x3ff) === 0) await onProgress('voices', i, events.length * 2);
    const loaded = await loadInstrument(event.guid);
    if (!loaded || loaded.slots.length === 0) {
      prepared.push(null);
      continue;
    }
    const track = seq.tracks[event.track];
    // The scale snap and then the key, in that order: `quantise(note, scale) +
    // blockRoot - 12` at `fmodextinput.prx` 0x3c4e, with the root filled from
    // `PInstrument.Key` by the eboot at `v0x160806`. See `keyOffset`.
    const note = notePitch(event.pitch, track.scale, blockRoot(track.key));
    // ⚠️ The slot comes from the RAW note, not the quantised one: the engine's
    // walk at 0x05a0 takes bits 8..14 of the note word with `bextr` and compares
    // that. The quantiser applies to the pitch below, not to the choice of sample.
    const zone = resolveSlot(loaded.inst, event.pitch, loaded.slots.length);
    const slot = loaded.slots[Math.min(zone, loaded.slots.length - 1)];
    const definition = loaded.inst.slots[Math.min(zone, loaded.inst.slots.length - 1)];
    // ❗ **No sample-rate conversion.** The eboot's loader (`v0xb3e520`) reads
    // `nChannels` out of `fmt ` and nothing else -- never the rate -- and the
    // plugin advances one sample frame per output frame at ratio 1, so the 42
    // shipped `.smp` at 44.1 kHz play 8.8% fast, +1.47 semitones, in the game
    // (`ukulele`, `record_static` and five kits). This multiplied by
    // `sampleRate / RATE` until 2026-09-08 and played them in tune, which the
    // game does not; *43* in steering/answered-questions.md.
    const playbackRate =
      (forcedUnpitched(slot.wav, event.guid) ? 1 : pitchRatio(definition, note, seq.tempo)) *
      (pitchShift.get(event.guid) ?? 1);
    const hold = holdFramesFor(slot.wav);
    const stretched =
      playbackRate > 0 ? slot.wav.channels[0].length / playbackRate : Infinity;
    const oneShotSteps = hold > 0 ? Math.min(stretched, hold) / framesPerStep : 0;
    // How long the record is held after the gate closes: the amplitude
    // envelope's release, scaled by the level it had actually reached.
    const gateSeconds = (event.durationSteps * framesPerStep) / RATE;
    const amp = evaluateAdsr(loaded.inst.params, ADSR_PARAMS, event.modulation);
    const release = withDeclick ? Math.max(amp.release, DECLICK_SECONDS) : amp.release;
    const releaseTail =
      (release * envelopeLevelAt(amp, gateSeconds) * RATE) / framesPerStep;
    // ❗ **And a voice that runs out of sample gives its record back**, which is
    // the OTHER half of the engine's free condition and was missing here for an
    // afternoon. `sub_0x1c60` frees a record when the envelope reaches zero
    // (`0x20e0`) **or** when the position passes an unlooped sample's frame
    // count with no loop point (`0x3035`-`0x3065`). A drum whose sample lasts
    // 0.2 s does not hold a record for its 1 s release, and this renderer had
    // it doing exactly that -- which squeezed the quietest instrument in the
    // song out of the pool. `stretched` is that length, in output frames.
    // ❗ The test runs once the chunk is out (`0x3035`), so the record goes at
    // the end of the chunk it runs out in, and a step's walk finds it free when
    // that chunk began before the step: `freedBy`, on the engine's clock.
    const runsOut =
      slot.wav.loop !== undefined
        ? Infinity
        : clock
          ? clock.freedBy(onsetAt(event.step) + stretched) - fromStep - event.step
          : stretched / framesPerStep;
    // ❗ **And a volume ramp that reaches zero gives the record back too.**
    // `0x209a`/`0x20de`: the renderer frees a record after the chunk whose
    // end-of-chunk volume -- the velocity ramp -- is not positive. That is a
    // point at velocity 0 whose successor is absent or also 0; a rising
    // successor keeps the chunk-end ramp above zero, so a fade-in from 0 lives.
    // An opening zero that holds costs one block: 3,132 corpus notes are
    // written that way and never sound in the game. `Voice.silentAfter` is the
    // mixer's half of the same rule.
    // ❗ **And so does an envelope that decays to nothing with the gate open**:
    // `0x20e0` reads the envelope's end-of-chunk value whatever its stage, so a
    // sustain of 0 frees the record once the attack and the decay have run --
    // 18 of the 68 instruments are struck, sustain 0. Freed after that chunk.
    const decayed =
      amp.sustain <= 0 && amp.attack + amp.decay < gateSeconds
        ? ((amp.attack + amp.decay) * RATE + BLOCK_FRAMES) / framesPerStep
        : Infinity;
    let silentAt = decayed;
    for (let k = 0; k < event.points.length; k += 1) {
      const point = event.points[k];
      const next = event.points[k + 1];
      if (point.volume === 0 && (next === undefined || next.volume === 0)) {
        silentAt = Math.min(silentAt, point.step + BLOCK_FRAMES / framesPerStep);
        break;
      }
    }
    prepared.push({
      loaded,
      note,
      zone,
      playbackRate,
      holdFrames: hold,
      layers: Math.max(1, loaded.inst.numStack),
      // ❗ **The note, and then its release.** The engine frees a record when the
      // voice's LEVEL reaches zero, not when the note ends: `sub_0x1c60` calls
      // the envelope at `0x2089`, compares its return against zero at `0x20e0`,
      // and `0x3093` writes `[record] = 0xff`. The release falls **linearly from
      // wherever the level was** -- `0x1780`, `level -= dt / release²` -- so the
      // tail is `release x level`, which is why `envelopeLevelAt` is solved here
      // rather than the full `0 -> 1` time being used.
      //
      // ⚠️ **This makes the renderer cut MORE notes, not fewer**: 1,411 of
      // `C4K3 S0NG`'s 13,091 become 2,922. That is the engine's arithmetic and
      // it is what the pool is for; a version that steals less is a version
      // playing notes the game does not have room for. See question 29 in
      // answered-questions.md --
      // including what a capture would have to show to overturn this.
      occupancySteps: Math.min(
        Math.max(event.durationSteps, oneShotSteps) + (withReleaseTail ? releaseTail : 0),
        runsOut,
        silentAt,
      ),
    });
  }

  // The engine has 32 voices and steals the quietest when they run out. Without
  // that cap a dense passage plays every note and is louder than the game's --
  // which is exactly where a listener hears it.
  //
  // ❗ **One entry per NOTE, and a stack does not multiply it.** This read
  // "one entry per stack layer" for two days, on the reasoning that `Numstack`
  // layers are `Numstack` sampler voices. The engine's own renderer says
  // otherwise: `sub_0x1c60` is called once per voice record from `sub_0xa90`'s
  // walk of the 32, and the **layer loop is inside it** -- `0x24a0`-`0x28e3`,
  // iterating `Numstack` times, with the three LFO phases stored once per record
  // at `[r12+0x98..0xa0]` and a per-layer spread added on top. One record plays
  // every layer of its note. See question 17 in `steering/answered-questions.md`.
  // ❗ **`0x04d4`: a note whose `channelVolume × Level` is not positive never
  // takes a record.** It is neither pooled nor played; it is still offered to
  // `onVoice`, because a live player holds the faders and decides for itself.
  // 0 of 74,864 corpus clips set `Level` to zero and none sit on a silent
  // channel, so on real data this is inert; a fader at zero in the editor is
  // where it shows.
  const audible = (e: (typeof events)[number]): boolean => {
    const track = seq.tracks[e.track];
    return channelVolume(seq, track) * track.level > 0;
  };
  // ❗ **The score after every walk, as well as at the claim.** `0x3930`
  // rewrites both factors at each step's walk, and `[+0x0c]` from whichever
  // control point is current, caught up along the volume slide -- so a note
  // fading out becomes the cheapest victim while it fades, and is scored at its
  // last point once its gate has closed. On `C4K3 S0NG` at 25.85 s that is
  // `mime_artist`'s note written 115 → 9, scoring 0.0266 at the walk that
  // steals it where the claim scored it 0.3396 (*29* in
  // steering/open-questions.md). The walks are on the song's whole steps, on
  // either clock: they are where the engine runs them.
  const walksOf = events.map((e): PoolWalks => {
    const track = seq.tracks[e.track];
    const at = e.step + fromStep;
    const records = e.points.map((point) => ({
      thirds: Math.round((at + point.step) * 3),
      gain: velocityGain(point.volume),
    }));
    const factor = channelVolume(seq, track) * track.level;
    return {
      from: Math.floor(records[0].thirds / 3) + 1 - fromStep,
      scores: walkVelocities(records).map((gain) => factor * gain),
    };
  });
  const entries: { eventIndex: number }[] = [];
  const pooled = allocateVoices(
    events.flatMap((e, i) => {
      if (!audible(e)) return [];
      const track = seq.tracks[e.track];
      const prep = prepared[i];
      const note: PooledNote = {
        // On the engine's clock a note takes its record at the walk of its
        // whole step, sub-step or not, and the walk spawns the last clip first.
        start: clock ? Math.floor(e.step + fromStep) - fromStep : e.step,
        ...(clock ? { rank: -e.track } : {}),
        end: e.step + (prep ? prep.occupancySteps : e.durationSteps),
        // ❗ **`voice[+0x04] * voice[+0x0c]`, and the first factor carries the
        // clip's own `Level`.** Measured in `sub_0x3930`, which rewrites both
        // at every walk (`walksOf`, above):
        //
        // ```
        // 0x3afc  xmm0 = [state + 0x1a68 + 4*chan]   ; the channel's volume
        // 0x3b09  xmm0 *= [clip + 0x420]             ; times PInstrument.Level
        // 0x3b12  [record + 0x04] = xmm0
        // 0x3c29  bextr eax, [note], 0x810           ; bits 16..23, the velocity
        // 0x3c32  xmm0 = velocity * 1/127            ; v0x45a0
        // 0x3c3a  [record + 0x0c] = xmm0
        // ```
        //
        // ⚠️ **The `Level` was missing here**, and it is not decoration: 88 of
        // `C4K3 S0NG`'s 244 clips set it away from 1, down to 0.020. Without it
        // the allocator steals the wrong voices — a quiet instrument is meant to
        // be the cheap one, and was as expensive as the loudest.
        //
        // The envelope is not in it: the engine ranks by what the note asks
        // for, not by how loud it happens to be.
        score: channelVolume(seq, track) * track.level * velocityGain(e.volume),
        walks: walksOf[i],
      };
      entries.push({ eventIndex: i });
      return [note];
    }),
    voiceLimit,
  );
  /** Event index -> the step at which the allocator takes the voice back. */
  const cutAt = new Map<number, number>();
  let stolen = 0;
  const stolenBy = new Map<number, number>();
  for (const p of pooled) {
    const { eventIndex } = entries[p.index];
    const event = events[eventIndex];
    const natural = event.step + (prepared[eventIndex]?.occupancySteps ?? event.durationSteps);
    if (p.end < natural) {
      cutAt.set(eventIndex, p.end);
      stolen += 1;
      stolenBy.set(event.guid, (stolenBy.get(event.guid) ?? 0) + 1);
    }
  }

  let played = 0;
  let skipped = 0;
  for (const [eventIndex, event] of events.entries()) {
    if (onProgress && (eventIndex & 0x3ff) === 0) {
      await onProgress('voices', events.length + eventIndex, events.length * 2);
    }
    const prep = prepared[eventIndex];
    if (!prep) {
      skipped += 1;
      continue;
    }
    const { loaded, note, zone } = prep;
    const track = seq.tracks[event.track];
    const slot = loaded.slots[Math.min(zone, loaded.slots.length - 1)];
    const definition = loaded.inst.slots[Math.min(zone, loaded.inst.slots.length - 1)];
    const p = loaded.inst.params;
    // ❗ An unpitched slot ignores the note's pitch at both ends of every chunk:
    // `0x1d79` and `0x1e27` test `slot+0x90` and skip both `exp2f` calls,
    // leaving the ratio at 1, so a glide moves nothing. Ramping it anyway put
    // `baiyon_bass_01`'s pitch glide +6.8 dB off the module.
    const glides = definition.pitched && !forcedUnpitched(slot.wav, event.guid);
    // The note's own modulation picks a point inside EVERY parameter's `x..y`
    // range -- `voice+0x28` in the engine, `(byte3 & 0x0f) / 15`. Reading `.x`
    // instead, as this did, pins every note to the low end of every range: 19% of
    // corpus records carry a non-zero modulation and 10% carry a full one, and on
    // `synth/ghost.rinst` alone that is the difference between resonance 0.90 and
    // resonance 0.53.
    const mod = event.modulation;
    const P = (index: number) => evaluateParam(p[index], mod);

    /**
     * The note's control points as the mixer's three ramps -- pitch, volume,
     * modulation -- in frames of the note's own sounding time, and first
     * **cut at every step boundary they cross**.
     *
     * ❗ **The engine's slides are linear in STEPS, not in frames.** `0x3930`
     * sets each as `(next − current) / span` with the span in thirds of a
     * step (`v0x45ac`), and the renderer adds `t × slide` with `t` the chunk's
     * advance in steps (`N / L`, `0x0c28`). Under swing the frames per step
     * alternate, so a glide that crosses a step boundary bends there in frame
     * time, and one frame-linear ramp between two points would not.
     * `swungFrame` is linear inside a step, so a point at every integer step
     * crossed makes the frame-linear ramps exactly the step-linear ones. It is
     * done whatever the swing, so that a live change of swing (`onClock` in the
     * player) re-maps the same points onto the same curve; 13 of the 338 corpus
     * sequencers swing, 2.3% of records, which is where it shows.
     *
     * The pitch ramps as the **quantised** semitone (`voice+0x08`, set per
     * point at `0x3c63`), so the interpolation runs on `notePitch`'s result
     * and never on the raw note. The gain is absolute per point: a note may
     * open at 0 and rise -- all 96 of `Northern Lights`'s harpsichord notes
     * do -- and a ratio to the first point once divided by zero and rendered
     * the part as silence. The modulation is the third ramp, `voice+0x28`
     * (*6d* in steering/answered-questions.md); holding it flat was wrong on
     * 34,449 corpus notes.
     */
    const ramp = (() => {
      const raw = event.points.map((point) => ({
        step: point.step,
        semis: glides ? notePitch(point.pitch, track.scale, blockRoot(track.key)) - note : 0,
        gain: velocityGain(point.volume),
        mod: point.modulation,
      }));
      const out: typeof raw = [];
      for (let i = 0; i < raw.length; i += 1) {
        const a = raw[i];
        out.push(a);
        const b = raw[i + 1];
        if (b === undefined) break;
        const span = b.step - a.step;
        if (span <= 0) continue;
        for (let s = Math.floor(a.step) + 1; s < b.step; s += 1) {
          if (s <= a.step) continue;
          const t = (s - a.step) / span;
          out.push({
            step: s,
            semis: a.semis + (b.semis - a.semis) * t,
            gain: a.gain + (b.gain - a.gain) * t,
            mod: a.mod + (b.mod - a.mod) * t,
          });
        }
      }
      return out;
    })();
    // One clock for the three ramps: frames of the note's own sounding time,
    // swung, measured from its start.
    // On the engine's clock a slide is linear in the playhead, which passes a
    // position inside the chunk it falls in, and the voice starts at a chunk's
    // top -- so a point's frame is measured from the onset, the first one may
    // sit before it, and it stays fractional: rounded, a two-octave glide
    // (`Vision`, 27 to 51 in a step) started 0.45 frames early and drifted to
    // -27 dB against the module.
    const onset = onsetAt(event.step);
    // The walk that makes a point the record's, on the engine's clock:
    // `AutomationPoint.from`. The first is the spawn, at or before the onset.
    const walkOf = (offset: number): { from?: number } =>
      clock ? { from: offset <= 0 ? 0 : walkAt(event.step + offset) - onset } : {};
    const frameOf = (offset: number): number =>
      clock
        ? clock.frameAt(event.step + offset + fromStep) - onset
        : Math.round(
            swungFrame(event.step + offset, framesPerStep, seq.swing) -
              swungFrame(event.step, framesPerStep, seq.swing),
          );
    // The modulation ramp, only when the note moves it: 96.4% of notes get
    // `undefined` and take the plain path.
    const morph = (() => {
      if (ramp.every((point) => point.mod === ramp[0].mod)) return undefined;
      // The walk's view of the modulation, for the drive and the echo send
      // (`held` on the mixer's morph): at every whole step past the spawn,
      // `0x3930` takes the value the previous call stored and stores this
      // step's. Ticks run to the one after the last point, where the walk
      // closes the gate (`0x3a4b`) and still evaluates once; past it the
      // modulation is flat, so the last value holds.
      const modAtStep = (offset: number): number => {
        let i = 0;
        while (i + 1 < ramp.length && ramp[i + 1].step <= offset) i += 1;
        const a = ramp[i];
        const b = ramp[i + 1];
        if (b === undefined || offset <= a.step) return a.mod;
        return a.mod + ((b.mod - a.mod) * (offset - a.step)) / (b.step - a.step);
      };
      const last = ramp[ramp.length - 1].step;
      const held = [{ frame: 0, value: ramp[0].mod }];
      let stored = ramp[0].mod;
      for (let step = Math.floor(event.step) + 1; step - event.step <= last + 1; step += 1) {
        const offset = step - event.step;
        if (stored !== held[held.length - 1].value) {
          // The walk's own frame: the value holds from the chunk after it.
          held.push({ frame: clock ? walkAt(step) - onset : frameOf(offset), value: stored });
        }
        stored = modAtStep(offset);
      }
      return {
        held,
        params: p,
        opening: P(OUTPUT_PARAMS.level),
        echoOffset: 2 * track.echoSend - 1,
        points: ramp.map((point) => ({
          frame: frameOf(point.step),
          value: point.mod,
          ...walkOf(point.step),
        })),
        ...(noKeyTrack ? { noKeyTrack } : {}),
      };
    })();
    const automation = ramp.map((point) => ({
      frame: frameOf(point.step),
      pitch: point.semis,
      gain: point.gain,
      ...walkOf(point.step),
    }));
    const lfo = (n: 0 | 1 | 2) => ({
      rate: P(LFO_PARAMS[n].rate),
      depth: P(LFO_PARAMS[n].depth),
      spread: P(LFO_PARAMS[n].spread),
    });

    // The unison stack. `Numstack` layers of the same sample, each with its own
    // random detune, pan offset and start point, at `sqrt(1 / Numstack)` gain --
    // all four measured and all four previously unused, which is why a
    // three-layer patch like `synth/ghost.rinst` came out as one thin copy.
    const layers = prep.layers;
    const stackGain = Math.sqrt(1 / layers);
    // ❗ The sample's own length, the slot's `+0x78` that `0x1ad1` reads -- not
    // the buffer's, which a loop ending near the end has made 16 frames longer
    // (`patchLoop`). The buffer's put `electric_piano`'s second layer up to 16
    // frames late on a full random start: -8.6 dB against the module.
    const sampleFrames = slot.wav.loop?.frames ?? slot.wav.channels[0].length;
    const bipolar = () => rand() * 2 - 1;
    // ❗ **One draw per NOTE, not per layer.** `0x1bed`-`0x1c3e` writes the three
    // phases to `voice+0x98`/`+0x9c`/`+0xa0` -- fixed offsets, no layer index --
    // after the stack loop has run, so a stacked voice's layers share a base and
    // differ only by the fan below.
    // Float32, as `0x1bf6`-`0x1bfa` scale the draw.
    const basePhase = [phase32(rand()), phase32(rand()), phase32(rand())] as const;
    // ❗ **On the engine's clock, the record's own float32 arithmetic.** The
    // walk's values and slides at every step (`engineWalks`), read off the
    // clock's float32 playhead per chunk, and every layer's rate formed in
    // float32 and only stepped in double (`EngineRecord` in `audio/mixer.ts`).
    // In double, `mosquito` held at 240 bpm drifted 0.0056 frames in four
    // seconds and `Vision`'s two-octave glides 0.05 frames in one step, where
    // the module is matched to 1e-5 (`engine-record.ts`).
    const engine = (() => {
      if (!clock) return undefined;
      // The walk counts steps inside the clip (`0x3a31`), and its catch-up
      // rounds by the step's size, so the records go in the clip's own steps.
      const clipThirds = Math.round((event.step + fromStep - track.stepOffset) * 3);
      const points = event.points.map((point) => {
        const thirds = clipThirds + Math.round(point.step * 3);
        const step = Math.floor(thirds / 3);
        return {
          step,
          subStep: thirds - 3 * step,
          pitch: notePitch(point.pitch, track.scale, blockRoot(track.key)),
          velocity: point.volume,
          nibble: point.timbre & 0x0f,
        };
      });
      // The spawn's walk on the song's grid; the k-th walk after it holds from
      // the end of the chunk that runs it.
      const spawn = Math.floor(Math.round((event.step + fromStep) * 3) / 3);
      const walks = engineWalks(points, points[0].step + 1).map((walk, k) => ({
        ...walk,
        frame: k === 0 ? 0 : clock.walkFrame(spawn + k) - onset,
      }));
      return {
        walks,
        startThird: Math.fround(points[0].subStep * THIRD32),
        slot: {
          fineTune: definition.fineTune,
          root: definition.baseNote,
          pitched: glides,
          ...(definition.fitBpm && definition.baseBpm > 0
            ? { tempoRatio: Math.fround(Math.fround(seq.tempo) / Math.fround(definition.baseBpm)) }
            : {}),
        },
        shift: pitchShift.get(event.guid) ?? 1,
        params: p,
        ...(noKeyTrack ? { noKeyTrack } : {}),
        lfoPhases: basePhase,
      };
    })();

    const spec: VoiceSpec = {
      sample: slot.wav,
      playbackRate: prep.playbackRate,
      holdFrames: prep.holdFrames,
      gain:
        // ⚠️ The note's own volume is NOT here. It is per control point and it
        // lives in `automation` above, because a note can start at zero and ramp
        // up -- see the note there. What stays is everything that is constant
        // for the whole voice.
        track.level *
        channelVolume(seq, track) *
        2 *
        P(OUTPUT_PARAMS.level) *
        stackGain,
      // `Params[26]`. The engine clamps it to 0..1 when the note starts
      // (`0x3cd8`-`0x3cf3`) and again to 0.95 in the block; `driveCoefficient`
      // does the second, so only the first belongs here.
      drive: Math.min(1, Math.max(0, P(OUTPUT_PARAMS.drive))),
      // The file's own pan, as the plugin takes it. The narrowing a stereo
      // listener hears ({@link PAN_WIDTH}) is FMOD's, after the clip and the
      // compressor, so it belongs to the master bus and not here.
      pan: track.pan,
      // Swing bends the step clock, so every frame position goes through it.
      startFrame: onset,
      ...(clock ? { engineGrid: { origin: onset, splits: clock.splits, chunks: clock.chunks }, engine } : {}),
      // The note's own end -- what closes the gate. A one-shot ignores it; see
      // `cutFrame` below, which nothing ignores.
      endFrame: gateAt(event.step + event.durationSteps),
      envelope: evaluateAdsr(p, ADSR_PARAMS, mod),
      filter: {
        settings: {
          cutoff: P(FILTER_PARAMS.cutoff),
          resonance: P(FILTER_PARAMS.resonance),
          keyTrack: noKeyTrack ? 0 : P(FILTER_PARAMS.keyTrack),
          envAmount: P(FILTER_PARAMS.envAmount),
        },
        envelope: evaluateAdsr(p, ADSR_PARAMS_B, mod),
      },
      lfos: [lfo(0), lfo(1), lfo(2)],
      automation,
      morph,
      // The sends, `fmodextinput.prx` 0x3c8a-0x3d10 (true vaddrs). The note block
      // carries five floats per placement at `+0x420 + 20i` -- level, pan,
      // echoSend, reverbSend, instrument index -- and the two sends are treated
      // very differently:
      //
      //   voice+0x1c = clamp01( bipolar(Params[25], 2*echoSend - 1) )   the echo
      //   voice+0x24 = clamp01( reverbSend )                            the reverb
      //
      // ⚠️ The echo's placement field is a **bipolar offset**, not a blend.
      // `v0x1607e9` writes `2*echoSend - 1` into the note block and 0x3ca1 applies
      // it as `v + o*v` when `o < 0` and `v + o*(1 - v)` when `o >= 0`. So 0.5
      // leaves the instrument's own send alone, 0 mutes it and 1 forces unity. A
      // previous reading used `v + e*(1 - v)` with the raw field, which is only
      // the upper half of that curve.
      //
      // ⚠️ The reverb send is `reverbSend` **alone**. The instrument's own
      // `Params` do not contribute one.
      //
      // ⚠️ `voice+0x20` is `Params[26]`, the **drive** -- `0x1ee0` reads it with
      // a `vbroadcastss`, which is how a grep for `vmovss` once missed it and
      // called it an unread send. It is `drive` above.
      echoSend: echoSendLevel(P(OUTPUT_PARAMS.send), 2 * track.echoSend - 1),
      reverbSend: Math.min(1, Math.max(0, track.reverbSend)),
      declick: withDeclick,
      // Seeded, so the LFO phases are reproducible along with everything else.
      random: rand,
    };
    const stack: LayerSpec[] = [];
    for (let layer = 0; layer < layers; layer += 1) {
      // ❗ **All three of Params[0..2] run from layer 0, and the engine then
      // throws exactly one of them away.** `0x1a70` enters its stack loop at
      // `xor ebx, ebx` with no guard on `Numstack`, writes a random start,
      // detune and pan for every layer -- and the instruction after the loop
      // is `mov qword ptr [r14 + 0x40], 0`, which is layer 0's start position
      // and nothing else. So the detune and the pan apply to a single-layer
      // voice and the start offset does not. Measured 2026-09-05; the loop and
      // its tail are `0x1a70`-`0x1c51`.
      //
      // ⚠️ The three draws stay in this order: moving one changes every later
      // value in the seeded stream.
      // The detune in float32, `+0x68 + 4i` as `0x1b0e`-`0x1b61` form it, from
      // `Params[0]` at the first record's `+0x28`: the rate the voice forms on
      // the engine's clock is the module's to the ulp only if this is.
      const detune = detune32(param32(p[STACK_PARAMS.detune], modulation32(event.timbre & 0x0f)), unit32(rand()));
      // ⚠️ **The offset is summed with the pan and folded, not clamped.** The
      // engine adds them inside the DSP -- `0x25ab` loads `voice+0x18` and
      // `0x25b2` adds `voice + layer*4 + 0x7c` -- and the sum goes through
      // LFO 3's triangle fold (`0x25fe`-`0x2657`) whatever that LFO's depth,
      // so a layer pushed past 1 turns back rather than sticking to the wall.
      // `Voice` does the fold; clamping here put `baiyon_city_guildford`'s
      // widest layers on the wall where the game turns them around.
      const pan = spec.pan + 0.5 * P(STACK_PARAMS.spread) * bipolar();
      // ⚠️ The draw happens for layer 0 too -- the engine calls `rand()` and
      // then overwrites the result -- so it stays here rather than behind the
      // branch. This is what makes `Params[2] = 1.000` harmless on the six kits
      // that set it (`8bit_kit_1`, `a_kit_1`, `bb_kit_1`, `bb_kit_2`, `e_kit_1`,
      // `e_perc_1`, all `Numstack` 1): the field is inert on every unstacked
      // instrument, which is 18 of the 27 that set it. Applied to layer 0 it
      // starts every drum hit at a uniformly random point inside its own
      // sample -- half a kick, no transient, a click at the discontinuity --
      // which is what a listener reported and what cost 11.6 dB of drum kit.
      // In float32 throughout, as `0x1ad8`-`0x1aff` multiply it, and only then
      // widened into the record's double (`0x1b03`).
      const offset = Math.fround(
        Math.fround(Math.fround(P(STACK_PARAMS.startOffset)) * sampleFrames) * Math.fround(rand()),
      );
      stack.push({
        detune,
        pan,
        startPosition: layer === 0 ? 0 : offset,
        lfoPhase: [0, 1, 2].map(
          (n) => basePhase[n] + P(LFO_PARAMS[n].spread) * ((2 * Math.PI) / layers) * layer,
        ) as unknown as readonly [number, number, number],
      });
    }
    const cut = cutAt.get(eventIndex);
    // ❗ **One voice per note, its layers inside it.** A `VoiceSpec` is one of
    // the engine's 32 records, and the record plays every layer of its note
    // through one accumulator, one clip and one pair of ladders (`Voice`).
    const voice: VoiceSpec = {
      ...spec,
      // The allocator handing this record to a later note. Undefined when the
      // pool never came for it, which is the usual case.
      cutFrame:
        // The walk that hands the record over, on the engine's clock.
        cut === undefined ? undefined : clock ? walkAt(cut) : onsetAt(cut),
      layers: stack,
    };
    // Offered to whoever asked and then mixed. A realtime player schedules
    // from here rather than rebuilding any of it.
    onVoice?.(voice, {
      guid: event.guid,
      zone,
      track: event.track,
      startFrame: voice.startFrame ?? 0,
      poolStart: event.step,
      poolEnd: event.step + (prep.occupancySteps ?? event.durationSteps),
      // The same two factors as the pool above, and for the same reason.
      score: channelVolume(seq, track) * track.level * velocityGain(event.volume),
      walks: walksOf[eventIndex],
      note: eventIndex,
      startStep: event.step,
      // ❗ The note's own end, not the pool's occupancy: a voice may hold a
      // channel longer than it sounds, and it is the sounding that decides
      // where the frames end.
      endStep: voice.endFrame === undefined ? undefined : event.step + event.durationSteps,
      row: track.gridY,
      channelGain: channelVolume(seq, track),
      level: track.level,
      pointSteps: ramp.map((point) => point.step),
    });
    // See `audible`: a note the engine would not allocate is not mixed.
    if (!planOnly && audible(event)) mixer.play(voice);
    played += 1;
  }

  const voicesMs = now() - voicesStarted;

  if (planOnly) {
    return {
      left,
      right,
      frames,
      seconds,
      framesPerStep,
      events: events.length,
      played,
      skipped,
      stolen,
      stolenBy,
      echoRel: 0,
      reverbRel: 0,
      clippedFrames: 0,
      compressorGain: 1,
      peak: 0,
      rms: 0,
      echo: new Echo(RATE, seq.echoTime, framesPerStep, seq.echoFeedback, seq.echoMix),
      reverb: new Reverb(RATE, reverbPreset(seq.reverb)),
      preset: reverbPreset(seq.reverb),
      timings: { voicesMs, mixMs: 0, effectsMs: 0 },
    } as RenderResult;
  }

  const echoL = new Float32Array(frames);
  const echoR = new Float32Array(frames);
  const reverbL = new Float32Array(frames);
  const reverbR = new Float32Array(frames);
  const mixStarted = now();
  mixer.render(
    left,
    right,
    { echo: [echoL, echoR], reverb: [reverbL, reverbR] },
    onProgress && ((done, total) => void onProgress('mix', done, total)),
  );
  const mixMs = now() - mixStarted;

  // The two sends, mixed back over the dry signal. Both are the game's own now --
  // topology, levels and all -- so there is nothing to scale here.
  const echo = new Echo(RATE, seq.echoTime, framesPerStep, seq.echoFeedback, seq.echoMix);
  const preset = reverbPreset(seq.reverb);
  const reverb = new Reverb(RATE, preset);
  // The plugin's output stage, in the engine's order (`fmodextinput.prx` 0x07c0):
  // the echo's wet is added to ALL FOUR channels -- the dry pair and the reverb
  // send pair -- and then all four are hard-clipped to +-1. Only after that does
  // the reverb DSP see its input.
  //
  // ⚠️ The clip is measured but its effect depends on our absolute level matching
  // the game's, which nothing here verifies. The share of frames it touches is
  // reported below; `LBP_NO_CLIP=1` removes it for an A/B.
  let dryEnergy = 0;
  let echoEnergy = 0;
  let reverbEnergy = 0;
  let clipped = 0;
  // The game's unless the caller asked otherwise: see `RenderOptions.master`.
  const master = new MasterStage(RATE, masterChoice);
  const effectsStarted = now();
  for (let i = 0; i < frames; i += 1) {
    if (onProgress && (i & 0x3ffff) === 0) void onProgress('effects', i, frames);
    dryEnergy += left[i] ** 2 + right[i] ** 2;
    const e = withEcho
      ? echo.process(echoL[i], echoR[i])
      : { left: 0, right: 0 };
    echoEnergy += e.left ** 2 + e.right ** 2;
    let dryL = left[i] + e.left;
    let dryR = right[i] + e.right;
    let sendL = reverbL[i] + e.left;
    let sendR = reverbR[i] + e.right;
    if (clip) {
      // ⚠️ **All four channels are clipped and the count used to watch two.** The
      // send pair is clipped by the same instruction (`vmaxps`/`vminps` on all
      // four lanes), so a frame whose reverb send clipped while the dry pair did
      // not was reported as untouched. Found 2026-09-06 while moving
      // `FOLD_GAIN`: `level-seq732985` read 0.05% before the move and 0.00%
      // after, and both numbers were under-counting.
      if (
        dryL > 1 || dryL < -1 || dryR > 1 || dryR < -1 ||
        sendL > 1 || sendL < -1 || sendR > 1 || sendR < -1
      ) {
        clipped += 1;
      }
      dryL = clipToUnit(dryL);
      dryR = clipToUnit(dryR);
      sendL = clipToUnit(sendL);
      sendR = clipToUnit(sendR);
    }
    // ⚠️ One call per frame, stereo. It used to be two calls -- one per channel --
    // through a single instance, which ran every delay line at twice the frame
    // rate and put both channels through the same state.
    const r = withReverb ? reverb.process(sendL, sendR) : { left: 0, right: 0 };
    reverbEnergy += r.left ** 2 + r.right ** 2;
    left[i] = dryL + r.left;
    right[i] = dryR + r.right;
  }
  // ❗ **The master bus, and it belongs HERE**: after the plugin's own clip and
  // after the reverb, where `Channel::addDSP` put the WaveHammer and where
  // FMOD's speaker matrix folds 7.1 to stereo. The fold's gain used to be
  // folded into each voice instead, which put it 4.645 dB upstream of all
  // three: our clip saw a signal the game's clip never sees at that level. One
  // pass after the loop is the same as one per frame -- nothing in the bus
  // feeds back -- and the WaveHammer's detector is causal, so a gain applied
  // as it is computed is what the engine does in three passes over a block.
  master.run(left, right, 0, frames);

  let peak = 0;
  let energy = 0;
  for (let i = 0; i < frames; i += 1) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    energy += left[i] ** 2 + right[i] ** 2;
  }
  return {
    left,
    right,
    frames,
    seconds,
    framesPerStep,
    events: events.length,
    played,
    skipped,
    stolen,
    stolenBy,
    echoRel: Math.sqrt(echoEnergy / dryEnergy),
    reverbRel: Math.sqrt(reverbEnergy / dryEnergy),
    clippedFrames: clipped,
    compressorGain: master.deepest,
    peak,
    rms: Math.sqrt(energy / (2 * frames)),
    echo,
    reverb,
    preset,
    timings: { voicesMs, mixMs, effectsMs: now() - effectsStarted },
  };
}

/** The 16-bit interleaved PCM a WAV writer wants, with the usual peak guard. */
export function toPcm16(
  left: Float32Array,
  right: Float32Array,
  normalise = true,
): { pcm: Int16Array; norm: number } {
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const norm = normalise && peak > 0.99 ? 0.99 / peak : 1;
  const pcm = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i += 1) {
    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767)));
  }
  return { pcm, norm };
}
