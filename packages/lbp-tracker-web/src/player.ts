/**
 * The live player: a song scheduled into the audio thread instead of a file.
 *
 * ⚠️ **It is not a second engine, and that is the whole design.** Every voice it
 * plays comes out of `renderSequencer` itself, through the `onVoice` seam and
 * with `planOnly` set, so the key splits, the pitch formula, the modulation
 * point, the stack layers, the sends, the pan width and the voice pool's
 * stealing are all decided by exactly the code that writes the WAV. This file
 * owns only *when* a voice is handed over, never *what* it is.
 *
 * The plan is built once, up front, because the voice pool has to be: the
 * allocator needs the whole note list to decide what gets stolen, and a
 * scheduler that only looked a second ahead would steal differently from the
 * renderer and drift.
 *
 * ⚠️ **`VoiceSpec.random` and `VoiceSpec.sample` cannot cross a thread** -- one
 * is a function and the other is megabytes of mipmaps. The sample is sent once
 * per instrument slot and referenced by id; the LFO phases are plain numbers on
 * the spec (`lfoPhase`, drawn by the render, one base per note) and cross as
 * they are, so dropping `random` costs the worklet nothing.
 *
 * ❗ **One player, one app.** This was the body of the live page until the
 * editor needed to play what it edits; it moved here whole rather than being
 * written a second time, because every invariant below was paid for by a
 * listener hearing it broken (`nextIndex` never moving backwards, `handed`,
 * the pool replayed by index) and a second copy would have re-learned each of
 * them. `daw/session.ts` owns the one instance and the transport drives it;
 * this owns the clock, the plan, the pool and the worklet, and says what
 * happened through `PlayerEvents`.
 */

/**
 * The mixer's AudioWorklet module, as a URL Vite has already built.
 *
 * ⚠️ **A worklet cannot resolve a bare specifier**, measured in Chrome and
 * written up in `vite.config.ts`: `audioWorklet.addModule` runs the module in a
 * realm with no import map, so `@lbptracker/lib/…` inside it fails to load.
 * `?worker&url` makes Vite resolve the whole graph ahead of time and hand back
 * a plain URL, which is also what keeps the built site relocatable — the URL is
 * relative to the page, never rooted at `/`.
 */
import MIXER_WORKLET_URL from '@lbptracker/lib/audio/mixer-worklet.ts?worker&url';
import { DropoutCounter } from '@lbptracker/lib/audio/dropouts.ts';
import { type VoiceSpec } from '@lbptracker/lib/audio/mixer.ts';
import { channelVolume, type Sequencer, type Track } from '@lbptracker/cwlib/sequencer/project.ts';
import {
  LiveVoicePool,
  VOICES_UNLIMITED,
  VOICE_POOL_SIZE,
  type PoolWalks,
} from '@lbptracker/lib/polyphony.ts';
import { STEPS_PER_BEAT, stepLength, swungFrame } from '@lbptracker/lib/swing.ts';
import { samplesPerStep } from '@lbptracker/lib/voice.ts';
import type { MasterChoice } from '@lbptracker/lib/audio/master-stage.ts';
import { RATE, renderSequencer, type InstrumentLoader } from '@lbptracker/lib/render.ts';
import { engineClock, type EngineClock } from '@lbptracker/lib/engine-clock.ts';
import { placeOnClock, spawnStep } from '@lbptracker/lib/engine-place.ts';

/**
 * One scheduled voice: when it starts, which sample it plays, and its spec.
 *
 * ⚠️ **`endFrame` and `cutFrame` are stored as DURATIONS here, not as the
 * absolute frames the render uses.** `Mixer.play` derives the note's life as
 * `endFrame - startFrame`, so a spec whose `startFrame` is rewritten to a
 * look-ahead delay while its `endFrame` still counts from the start of the song
 * gets a life of nearly the whole song -- every note rings until the end, which
 * is exactly what a first attempt sounded like. Rebasing at post time is the fix,
 * and keeping the durations rather than the absolutes is what makes it hard to
 * get wrong twice.
 */
export interface Planned {
  /**
   * Where the voice starts and ends **in steps**, not in frames.
   *
   * ❗ **Tempo, swing and the channel mixer are applied when the note is
   * posted, not when the plan is built.** None of the three changes a voice:
   * they change where it starts, how long it lasts and how loud it is, and all
   * three of those are one line of arithmetic over a musical position. Storing
   * frames instead meant every turn of the tempo knob re-ran the whole voice
   * pass -- `Ascetic` is 1,150 tracks -- on the thread that also feeds the
   * audio, which is exactly the stutter a listener heard.
   *
   * ⚠️ Tempo is only free of the voice because **no instrument the game
   * ships sets `fitBpm`** (0 of 68). One that did would have its playback rate
   * scaled by the tempo and would need a rebuild after all.
   */
  readonly startStep: number;
  readonly endStep?: number;
  /** The board row, which picks the mixer channel through `NumChannels`. */
  readonly row: number;
  /**
   * The placement's `Level`. `0x04d4`: the engine allocates no record when
   * `channelVolume × Level` is not positive, and the channel volume is the
   * fader as it stands when the note is posted.
   */
  readonly level: number;
  /** `voice.gain` with the channel's factor divided out, so it can be redone. */
  readonly baseGain: number;
  /**
   * The pool's score, likewise without the channel factor.
   *
   * ❗ The pool is in STEPS and so is immune to tempo and swing -- but its score
   * is `channelVolume * velocityGain`, so a fader or `NumChannels` changes
   * which voice gets stolen. That has to follow the mixer or the pool decides
   * by a mix nobody is listening to.
   */
  readonly baseScore: number;
  /** The score after each walk (`PooledNote.walks`), without the channel factor too. */
  readonly baseWalks: PoolWalks;
  /**
   * The note this voice is.
   *
   * ❗ **One entry per note, and the pool counts notes.** A stacked instrument
   * plays all its layers out of ONE of the engine's 32 records, and one
   * `VoiceSpec` carries them all (`voice.layers`), so the allocator is asked
   * once per entry. Asking per layer made `C4K3 S0NG` steal 3,634 notes of
   * 13,091 where the truth is 1,526.
   */
  readonly note: number;
  /**
   * Each control point's offset from the note's start, in steps.
   *
   * ❗ `automation` and `morph.points` hold frames from the voice's own start,
   * and those frames were bent by the tempo AND the swing. Everything else
   * about a voice is in seconds or is a ratio, so this is the only part a live
   * change has to rebuild. `packages/lbp-tracker-lib/dev/live-settings.ts` proves the rebuild exact.
   */
  readonly pointSteps: readonly number[];
  readonly sampleId: string;
  /**
   * ⚠️ **Without `engineGrid`.** The render's is the whole song's chunk table
   * on its own clock, hundreds of kilobytes that would be copied with every
   * note posted; `pump` puts the voice on the player's clock and posts the
   * window of chunks it lives in (`placeOnClock`).
   */
  readonly voice: Omit<VoiceSpec, 'sample' | 'random' | 'startFrame' | 'endFrame' | 'cutFrame' | 'engineGrid'>;
  /**
   * What the voice pool needs, in its own units.
   *
   * ⚠️ **The plan carries no cuts.** It is built uncapped and the pool is
   * applied as each voice is handed over, one note at a time, which is what the
   * engine does and what lets the size be changed without rebuilding anything.
   * `LiveVoicePool` is proved to decide exactly what `allocateVoices` decides
   * (packages/lbp-tracker-lib/test/polyphony.test.ts), and `packages/lbp-tracker-lib/dev/live-sim.ts` proves the audio is
   * bit-identical at pools of 2, 4, 8 and 32.
   */
  readonly poolStart: number;
  /** `PooledNote.rank`: the order the walk spawns notes of one step in. See `planOrder`. */
  readonly poolRank: number;
  readonly poolEnd: number;
  readonly score: number;
  readonly index: number;
  /**
   * The chip the voice belongs to, by the key the page gave `load` -- the
   * chip's id -- so one chip's voices can be swapped out, dropped or added
   * without the rest of the plan noticing where it sits in the list.
   */
  readonly track: number;
}

/**
 * What the audio thread last said it was holding.
 *
 * ⚠️ `sounding` is **not the count of voices posted in the last tick**, which
 * is what the readout used to be and which is nearly always zero: the scheduler
 * posts in bursts every 100 ms, so on a sparse song most ticks post nothing
 * while plenty is still ringing. A voice can also outlive its gate by its
 * release, which no amount of counting on this side would know about.
 *
 * ❗ `notes` is the number the 32-voice cap applies to. The worklet counts
 * distinct `VoiceSpec.tag`s, and `pump` tags by note; a voice is one record
 * with its layers inside, so the two differ only by voices ringing past their
 * gate under a tag the pool has already given back.
 */
export interface Health {
  readonly sounding: number;
  readonly notes: number;
  /** Voices posted but not yet started. */
  readonly queued: number;
  /**
   * The share of the audio thread's time the mixer takes, averaged over a few
   * seconds (`LoadMeter` in `@lbptracker/lib/audio/load-meter.ts`). `null`
   * until there is a reading, which must not read as zero.
   */
  readonly audioLoad: number | null;
  /**
   * Times the audio thread fell behind and the device played silence, since
   * playback started: counted here, off the output's own clock
   * (`DropoutCounter` in `@lbptracker/lib/audio/dropouts.ts`).
   */
  readonly dropouts: number;
  /** How much sound those cost, in milliseconds. */
  readonly lostMs: number;
  /**
   * The gain the AGC after the game's bus is applying (`audio/agc.ts`), as
   * the worklet last reported it; `null` when another master bus is chosen.
   */
  readonly agcGain: number | null;
}

/** The song's output stage, as the worklet takes it minus the step length. */
export interface EffectSettings {
  readonly echoTime: number;
  readonly feedback: number;
  readonly mix: number;
  readonly reverbSetting: number;
  readonly echoOn: boolean;
  readonly reverbOn: boolean;
  readonly clip: boolean;
  /**
   * Which master bus ends the chain: the game's -- `SMS WaveHammer` and the
   * 7.1 fold -- when absent, with the AGC, ours or none. See `master-stage.ts`.
   */
  readonly master?: MasterChoice;
}

export interface PlayerEvents {
  /** The worklet reported; `health` is the whole picture. */
  health?(health: Health): void;
  /** The pool took a voice back; `total` since the last seek. */
  stolen?(total: number): void;
  missingSample?(id: string): void;
  /** The transport moved: once per scheduler tick while playing, and on seeks. */
  tick?(): void;
  /** Playing started or stopped, including reaching the end. */
  playing?(on: boolean): void;
  /** The plan is being built. A promise returned is awaited: it is how a watcher lets the page paint. */
  progress?(phase: string, done: number, total: number): void | Promise<void>;
}

/** What `load` found out about the song. */
export interface Loaded {
  readonly voices: number;
  readonly played: number;
  /** Notes whose instrument was not among the assets -- not pool drops. */
  readonly skipped: number;
  readonly samples: number;
  readonly seconds: number;
}

/**
 * How far ahead notes are posted.
 *
 * ⚠️ Long enough that a slow frame cannot leave a gap, short enough that moving
 * an effect control is heard within a beat. The worklet delays each voice by
 * `startFrame`, so accuracy does not depend on this -- only latency to a change
 * does.
 */
const LOOKAHEAD = 0.35;
const TICK = 100;

/**
 * How far past the song's end, in seconds, a run of the engine's clock is
 * simulated: the last notes' gates and releases are placed on it too.
 */
const RUN_TAIL = 10;

/**
 * The order the plan is posted and pooled in: the pool's start, then its rank,
 * then the note. ❗ It is `allocateVoices`'s own sort, which is what lets
 * `LiveVoicePool` decide what the render decides: on the engine's clock a step's
 * notes take records at its walk, the last clip first, sub-step or not.
 */
const planOrder = (a: Planned, b: Planned): number =>
  a.poolStart - b.poolStart || a.poolRank - b.poolRank || a.note - b.note;

/**
 * One run of the engine's clock under the transport: the clock restarted at a
 * step, and the transport frame its frame 0 sits at.
 */
interface ClockRun {
  readonly origin: number;
  readonly clock: EngineClock;
  /** The step it started at, and the frames it was simulated for, to grow it. */
  readonly start: number;
  readonly frames: number;
}

/** Tags below this are the player's own one-off voices, never a plan note's. */
const AUDITION_TAG_BASE = -1_000_000;

export class Player {
  private readonly events: PlayerEvents;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  /** One analyser per output channel, after the master: what the VU meter reads. */
  private analysers: [AnalyserNode, AnalyserNode] | null = null;
  private readonly scratch = new Float32Array(512);
  private volume = 1;
  private effects: EffectSettings | null = null;
  /** Sample ids the worklet already holds. Survives a re-plan: the buffers do. */
  private readonly sent = new Set<string>();

  plan: Planned[] = [];
  songFrames = 0;
  songSeconds = 0;
  /** `720000 / tempo` at the tempo now in force. */
  stepFrames = 0;
  swing = 0;
  /** The song's own length in steps, and the render's tail, so a tempo change
   * can put `songFrames` back without asking the renderer. */
  private songSteps = 0;
  private tailFrames = 0;

  /** Where the playhead is, in song frames, and when that was true. */
  private cursorFrames = 0;
  private startedAt = 0;
  playing = false;
  /** How far into `plan` the scheduler has already posted. */
  private nextIndex = 0;
  private timer = 0;

  /** The mixer as the page has it, read by `gainOf` on every note posted. */
  private liveChannels = 1;
  private liveVolumes: readonly number[] = [1, 1, 1, 1, 1, 1];
  private liveTempo = 0;
  /**
   * The board's height in cells, which bands rows into channels.
   *
   * ⚠️ **Without it `channelVolume` falls back to a modulo, and the plan's
   * gain was divided out under the bands.** `baseGain` is the render's gain
   * with the channel factor taken out -- a factor the render computed with the
   * board's bands -- so putting a modulo factor back re-routes the rows of any
   * multi-channel song (667 of 1,821 tracks on the corpus's ten, measured for
   * `channelVolume`). The live page ran that way for a day.
   */
  private boardRows = 0;
  private poolLimit: number = VOICE_POOL_SIZE;
  private pool = new LiveVoicePool(VOICE_POOL_SIZE);
  /** Note -> the end its record was given, so its other layers can take the same. */
  private noteEnd = new Map<number, number>();
  /** Note -> the step it was handed over at, for measuring a steal's cut from. */
  private noteStart = new Map<number, number>();
  /**
   * The STEP at which each handed-over voice started, so a theft can reach it.
   *
   * ❗ A step and not a frame: the tempo can move after the voice was handed
   * over, and a frame written under the old clock would measure a steal's cut
   * from the wrong place -- too long a cut leaves a stolen voice sounding, which
   * is loudness nobody asked for.
   */
  private readonly handed = new Map<number, number>();
  /**
   * The furthest step handed to the worklet, or -1 after a seek.
   *
   * ❗ **A re-plan while playing must start AFTER this, not at the playhead.**
   * The plan is rebuilt and re-indexed, so `handed` cannot say which of the new
   * voices are the ones already posted; but every voice up to this step was,
   * and posting them again is the doubled-notes flam that editing a chip while
   * the song played used to produce (measured: 5 voices re-posted per edit on
   * Ascetic at 240 BPM, the look-ahead window's worth). An edit inside the
   * window is therefore heard on the next pass, not this one.
   */
  private handedUntilStep = -1;
  /** Note ids handed out to re-planned tracks, past every id the full plan used. */
  private noteBase = 0;
  /** Voices the pool has taken back since the last seek, counted as it goes. */
  stolen = 0;
  private health: Health = {
    sounding: 0, notes: 0, queued: 0, audioLoad: null, dropouts: 0, lostMs: 0, agcGain: null,
  };
  private readonly lost = new DropoutCounter();
  private auditionTag = AUDITION_TAG_BASE;
  /**
   * The engine's clock as the transport runs it, from where it last started:
   * `play`, a tempo or swing change, a fold of the passes (see `startRun`).
   */
  private run: ClockRun | null = null;
  /** The clock every later time round a looped section runs on, origin aside. */
  private passRun: ClockRun | null = null;
  /** A track's key -> its rank in the whole song's walk, for a re-planned track. */
  private readonly rankOf = new Map<number, number>();

  constructor(events: PlayerEvents = {}) {
    this.events = events;
  }

  // ------------------------------------------------------------------- audio

  get audioContext(): AudioContext | null {
    return this.context;
  }

  async ensureAudio(): Promise<AudioWorkletNode> {
    if (this.node) return this.node;
    const context = new AudioContext({ sampleRate: RATE });
    this.context = context;
    await context.audioWorklet.addModule(MIXER_WORKLET_URL);
    const node = new AudioWorkletNode(context, 'lbp-mixer', { outputChannelCount: [2] });
    this.node = node;
    this.master = new GainNode(context, { gain: this.volume });
    node.connect(this.master).connect(context.destination);
    // The meter taps the master through a splitter; an analyser is a sink
    // and needs no connection onward.
    const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    this.master.connect(splitter);
    const left = new AnalyserNode(context, { fftSize: 512 });
    const right = new AnalyserNode(context, { fftSize: 512 });
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    this.analysers = [left, right];
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type: string; id?: string; total?: number; sounding?: number; notes?: number;
        load?: number | null; agc?: number | null;
      };
      if (data.type === 'missingSample') this.events.missingSample?.(data.id ?? '?');
      // The only place that knows what is actually sounding is the audio thread.
      if (data.type === 'voices') {
        const sounding = data.sounding ?? 0;
        // Read as the report arrives: the two times are one sample's, so how
        // late the message is does not matter.
        const out = context.getOutputTimestamp?.();
        const lost = this.lost.observe(out?.performanceTime ?? 0, out?.contextTime ?? 0);
        this.health = {
          sounding,
          notes: data.notes ?? 0,
          queued: (data.total ?? 0) - sounding,
          audioLoad: data.load ?? null,
          dropouts: this.health.dropouts + lost.dropouts,
          lostMs: this.health.lostMs + lost.lostMs,
          agcGain: data.agc ?? null,
        };
        this.events.health?.(this.health);
      }
    };
    if (this.effects) this.pushEffects();
    return node;
  }

  /**
   * The output's peak over the last block, per channel, after the master
   * fader -- what a VU meter shows. `null` before the audio exists.
   */
  peaks(): [number, number] | null {
    if (!this.analysers) return null;
    const out: [number, number] = [0, 0];
    this.analysers.forEach((analyser, i) => {
      analyser.getFloatTimeDomainData(this.scratch);
      let peak = 0;
      for (let k = 0; k < this.scratch.length; k += 1) {
        const a = Math.abs(this.scratch[k]);
        if (a > peak) peak = a;
      }
      out[i] = peak;
    });
    return out;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.01);
    }
  }

  /** The song's output stage. Re-pushed whenever the tempo moves: the echo is in beats. */
  setEffects(settings: EffectSettings): void {
    this.effects = settings;
    this.pushEffects();
  }

  private pushEffects(): void {
    // Not before a song has a step length: the echo's delay is `echoTime`
    // beats of it, and a zero-length delay line is not a setting anyone meant.
    if (!this.effects || this.stepFrames <= 0) return;
    this.node?.port.postMessage({
      type: 'effects',
      ...this.effects,
      framesPerStep: this.stepFrames,
    });
  }

  /** Forget the dropout count: the page's reset button, and every start. */
  resetHealth(): void {
    this.lost.reset();
    this.health = { ...this.health, dropouts: 0, lostMs: 0 };
    this.events.health?.(this.health);
  }

  get lastHealth(): Health {
    return this.health;
  }

  // ---------------------------------------------------------------- the plan

  /**
   * Build the plan, and put the transport where the caller asks.
   *
   * `restart` is the whole difference between picking a song and changing what
   * is in it: one starts from the top with the song's own settings, the other
   * keeps playing and keeps the tempo, swing and mixer the listener has set.
   *
   * ⚠️ **Swapped underneath a running transport, without touching the audio.**
   * With `restart` off, voices already handed to the worklet keep their old
   * cuts and finish as they were going to; only notes not yet posted come from
   * the new plan. Re-pointing `nextIndex` at the current position is the whole
   * handover -- no `stopAll`, no seek, no gap.
   */
  async load(
    original: Sequencer,
    loader: InstrumentLoader,
    restart = true,
    /**
     * Where the transport stops, in steps. The sequencer's own `lengthSteps`
     * is the notes' end; a page with a board passes the end of its last chip.
     * ⚠️ The render's six-second tail is NOT added: the transport stops at the
     * end and lets the effects ring on, rather than running past the last
     * chip into silence.
     */
    endStep = original.lengthSteps,
    /** A key per track of `original`, in order; the track's index otherwise. */
    keys?: readonly number[],
  ): Promise<Loaded> {
    const seq: Sequencer = restart
      ? original
      : {
          ...original,
          tempo: this.liveTempo > 0 ? this.liveTempo : original.tempo,
          swing: this.swing,
          numChannels: this.liveChannels,
          volumes: this.liveVolumes,
          boardRows: this.boardRows || original.boardRows,
        };
    // Where we are in the music, not in seconds: a tempo change moves one and
    // not the other, and the music is what a listener is following.
    const stepBefore = !restart && this.stepFrames > 0 ? this.position() / this.stepFrames : 0;
    if (!restart) this.rebasePass();
    const wasPlaying = this.playing;

    const node = await this.ensureAudio();
    const built: Planned[] = [];
    const sent = this.sent;
    let samples = 0;

    const keyOf = (i: number) => keys?.[i] ?? i;
    this.rankOf.clear();
    original.tracks.forEach((_, i) => this.rankOf.set(keyOf(i), -i));
    const result = await this.collect(seq, loader, node, built, 0, keyOf, (rank) => rank);
    this.noteBase = built.reduce((m, v) => Math.max(m, v.note + 1), 0);

    // Sorted by the pool's own order, which is also the order they are posted
    // in: by the walk that takes them, at any tempo.
    built.sort(planOrder);
    this.plan = built;
    this.stepFrames = result.framesPerStep;
    this.liveTempo = seq.tempo;
    this.songSteps = Math.max(endStep, original.lengthSteps);
    this.tailFrames = 0;
    this.songFrames = Math.round(swungFrame(this.songSteps, this.stepFrames, seq.swing));
    this.songSeconds = this.songFrames / RATE;
    this.swing = seq.swing;
    this.liveChannels = seq.numChannels;
    this.liveVolumes = seq.volumes;
    this.boardRows = seq.boardRows;
    this.pushEffects();
    if (restart) {
      this.seek(0);
    } else {
      this.cursorFrames = Math.min(this.songFrames, stepBefore * this.stepFrames);
      if (this.context) this.startedAt = this.context.currentTime;
      this.playing = wasPlaying;
      // The transport went on where it was, but its frames may not have: a
      // section folded, or a tempo the run was not started at.
      if (this.playing) this.startRun();
      this.repoint();
      this.events.tick?.();
    }
    return {
      voices: built.length,
      played: result.played,
      skipped: result.skipped,
      samples: new Set(built.map((p) => p.sampleId)).size,
      seconds: this.songSeconds,
    };
  }

  /**
   * Plan a sequencer's voices into `built`, loading any sample the worklet
   * does not hold yet. `keyOf` turns a track's index in `seq` into the key
   * the entries carry; `noteBase` keeps their note ids clear of the plan's.
   */
  private async collect(
    seq: Sequencer,
    loader: InstrumentLoader,
    node: AudioWorkletNode,
    built: Planned[],
    noteBase: number,
    keyOf: (index: number) => number,
    /** The render's `poolRank` to the whole song's: the same, unless one track was planned alone. */
    rankOf: (rank: number) => number,
  ): Promise<{ played: number; skipped: number; framesPerStep: number }> {
    const sent = this.sent;
    const result = await renderSequencer(seq, loader, {
      planOnly: true,
      // ❗ And no cap: the pool is applied live, per note. See `Planned`.
      voiceLimit: VOICES_UNLIMITED,
      // The audio thread cannot spare the float32 ladder: see `exactLadder`.
      exactLadder: false,
      onVoice: (voice, where) => {
        const sampleId = `g${where.guid}z${where.zone}`;
        if (!sent.has(sampleId)) {
          sent.add(sampleId);
          const sample = voice.sample;
          node.port.postMessage({
            type: 'load',
            sample: {
              id: sampleId,
              // Copies, because the worklet keeps them and this thread replays
              // the same buffers for every later voice on the same slot.
              channels: sample.channels.map((c) => new Float32Array(c)),
              sampleRate: sample.sampleRate,
              loop: sample.loop,
              smoothed: sample.smoothed?.channels.map((c) => new Float32Array(c)),
            },
          });
        }
        const {
          sample: _s, random: _r, startFrame: _f, endFrame: _e, cutFrame: _c, engineGrid: _g, ...rest
        } = voice;
        built.push({
          startStep: where.startStep,
          endStep: where.endStep,
          row: where.row,
          level: where.level,
          // ❗ Divided out so the faders can put a different one back. It is
          // never zero: `CHANNEL_HEADROOM` is 0.75 and a volume of 0 would have
          // made the voice silent in the render too.
          baseGain: where.channelGain === 0 ? rest.gain : rest.gain / where.channelGain,
          baseScore: where.channelGain === 0 ? where.score : where.score / where.channelGain,
          baseWalks: where.channelGain === 0 ? where.walks : {
            from: where.walks.from,
            scores: where.walks.scores.map((score) => score / where.channelGain),
          },
          pointSteps: where.pointSteps,
          sampleId,
          voice: rest,
          poolStart: where.poolStart,
          poolRank: rankOf(where.poolRank),
          note: where.note + noteBase,
          poolEnd: where.poolEnd,
          score: where.score,
          index: built.length,
          track: keyOf(where.track),
        });
      },
      // The renderer reports every 1,024 events already. ⚠️ A further
      // `done & 0xfff` filter here let through only the first report of the
      // second half, and that only when the event count was a multiple of
      // 4,096, so nothing watching could see the voice pass move.
      onProgress: (phase, done, total) => this.events.progress?.(phase, done, total),
    });
    return { played: result.played, skipped: result.skipped, framesPerStep: result.framesPerStep };
  }

  /**
   * Swap one track's voices for a fresh plan of it, without stopping: what an
   * edit inside a chip costs while the song plays -- one track's voice pass
   * rather than the whole song's (Ascetic: 1,150 tracks, 50-100 ms, and every
   * one of the look-ahead window's voices posted twice).
   *
   * Voices of that track already handed to the worklet sound as they were,
   * old notes and all, and the new plan of it takes over past the frontier;
   * but the PLAN holds the fresh voices from the start, so a seek back, or the
   * section's next time round, plays the edit. See `dropTracks` for the trap.
   */
  async retrack(
    key: number,
    track: Track,
    seq: Sequencer,
    loader: InstrumentLoader,
    endStep = seq.lengthSteps,
  ): Promise<void> {
    const node = await this.ensureAudio();
    const fresh: Planned[] = [];
    // ❗ The renderer plans nothing past `lengthSteps`, and a one-track copy of
    // an empty sequencer has none: give it the song's end, which is never
    // before this track's.
    const one: Sequencer = { ...seq, tracks: [track], lengthSteps: Math.max(seq.lengthSteps, endStep) };
    // Alone in its sequencer the track ranks 0; the walk ranks it by its place
    // in the song, which `load` recorded.
    await this.collect(one, loader, node, fresh, this.noteBase, () => key, () => this.rankOf.get(key) ?? 0);
    this.noteBase = fresh.reduce((m, v) => Math.max(m, v.note + 1), this.noteBase);
    // The whole track out, the whole fresh plan of it in. `repoint` keeps the
    // scheduler past `handedUntilStep`, so nothing before the frontier is
    // posted now -- and nothing is posted twice.
    this.splice(this.plan.filter((p) => p.track !== key).concat(fresh), seq, endStep);
  }

  /**
   * Take chips out of the plan -- removed, or muted -- every voice of theirs,
   * handed over or not. Nothing is planned, so it costs one pass over the plan.
   *
   * ❗ **Not "keeping what was already handed over".** The filters here and in
   * `retrack` used to keep a gone chip's voices up to `handedUntilStep`, so
   * the plan "still held what the worklet had been given" -- and held it for
   * good: the plan was no longer the audible song. A solo pressed while the
   * song played held only from the frontier on, and a seek back played the
   * muted rows again up to it (measured 2026-09-09 on Ascetic: solo at step
   * 32, 70 stale voices kept, 53 of them posted after a seek to 0); a looped
   * section did the same every time round. Not posting twice is `repoint`'s
   * job, by the frontier -- not the plan's. The voices already in the worklet
   * finish as they were going to, and the pool's replay forgets them with the
   * plan.
   */
  dropTracks(keys: ReadonlySet<number>, seq: Sequencer, endStep = seq.lengthSteps): void {
    this.splice(this.plan.filter((p) => !keys.has(p.track)), seq, endStep);
  }

  /** A changed plan under the running clock: sorted, re-indexed, the end refreshed, the scheduler re-pointed. */
  private splice(merged: Planned[], seq: Sequencer, endStep: number): void {
    merged.sort(planOrder);
    this.plan = merged.map((p, i) => ({ ...p, index: i }));
    this.songSteps = Math.max(endStep, seq.lengthSteps);
    this.songFrames = Math.round(swungFrame(this.songSteps, this.stepFrames, this.swing));
    this.songSeconds = this.songFrames / RATE;
    this.repoint();
    this.events.tick?.();
  }

  /**
   * Point `nextIndex` at the first voice still to hand over after the plan
   * changed under a running clock: at the playhead, and never inside the
   * window already posted (see `handedUntilStep`). The pool is replayed up to
   * there so it holds what it would have been holding.
   */
  private repoint(): void {
    const now = this.rawPosition();
    const byFrame = this.plan.findIndex((p) => this.passFrame(p) >= now);
    let next = byFrame < 0 ? this.plan.length : byFrame;
    if (this.handedUntilStep >= 0) {
      const byStep = this.plan.findIndex((p) => this.passStep(p) > this.handedUntilStep);
      next = Math.max(next, byStep < 0 ? this.plan.length : byStep);
    }
    this.nextIndex = next;
    this.handed.clear();
    this.noteStart.clear();
    this.rebuildPoolTo(next);
  }

  /** Forget the song: the page is opening another. */
  clear(): void {
    this.stop();
    this.region = null;
    this.focusRow = null;
    this.pass = 0;
    this.plan = [];
    this.songFrames = 0;
    this.songSeconds = 0;
    this.cursorFrames = 0;
    this.events.tick?.();
  }

  get hasPlan(): boolean {
    return this.plan.length > 0;
  }

  /** The tempo now in force. */
  get tempo(): number {
    return this.liveTempo;
  }

  // ------------------------------------------------------ the engine's clock

  /**
   * Start the engine's clock again where the transport is: a restart, as the
   * engine's own is when a song starts (`0x1a48`) -- the first chunk renders
   * nothing new and the step it started in is walked at its end.
   *
   * ❗ **Only where the transport's frames stop following the clock**: `play`,
   * a tempo or swing change, a fold of the passes. A fader or an edit leaves
   * the clock running, so the notes after it keep the chunk grid the ones
   * before it had. The voices already handed over keep the run they were
   * placed on; the one-chunk seam a restart leaves is between them and the
   * notes after the frontier, never inside a note.
   */
  private startRun(): void {
    this.run = this.newRun(this.cursorFrames, this.stepAt(this.cursorFrames));
    this.passRun = null;
  }

  private newRun(origin: number, start: number, frames?: number): ClockRun {
    const span = frames ?? Math.max(0, this.songFrames - origin) + RUN_TAIL * RATE;
    return { origin, start, frames: span, clock: engineClock(this.liveTempo, this.swing, span, start) };
  }

  /**
   * The run a voice of pass `pass` is placed on, simulated at least as far as
   * `step`: pass 0 runs from where the transport started; every later time
   * round a section restarts at its first step, at the pass's own frame.
   */
  private runFor(pass: number, step: number): ClockRun {
    const r = pass > 0 ? this.activeRegion() : null;
    const rg = pass > 0 ? this.regionFrames() : null;
    if (r === null || rg === null) {
      this.run ??= this.newRun(this.cursorFrames, this.stepAt(this.cursorFrames));
      this.run = this.covering(this.run, step);
      return this.run;
    }
    if (this.passRun === null || this.passRun.start !== r.start) {
      this.passRun = this.newRun(0, r.start, rg.len + RUN_TAIL * RATE);
    }
    this.passRun = this.covering(this.passRun, step);
    return { ...this.passRun, origin: rg.startF + pass * rg.len };
  }

  /**
   * The same run simulated further when `step` is past its end -- a song made
   * longer while it plays. The clock is a pure function of its tempo, swing
   * and start, so the longer one has the shorter one's chunks to the frame.
   */
  private covering(run: ClockRun, step: number): ClockRun {
    const heads = run.clock.chunks.playheads;
    if (heads[heads.length - 1] > step + 2) return run;
    const ahead = (step + 4 - run.start) * this.stepFrames + RUN_TAIL * RATE;
    return { ...run, ...this.newRun(run.origin, run.start, Math.max(2 * run.frames, ahead)), origin: run.origin };
  }

  /** A position in pass-space steps -- `passStep`'s -- on the run its pass is placed on. */
  private passPlace(step: number): { run: ClockRun; local: number } {
    const r = this.pass > 0 ? this.activeRegion() : null;
    if (r === null) return { run: this.runFor(0, step), local: step };
    const span = r.end - r.start;
    const k = Math.max(0, Math.min(this.pass, Math.floor((step - r.start) / span)));
    const local = step - k * span;
    return { run: this.runFor(k, local), local };
  }

  /** The transport frame of the walk that takes the records of the whole step holding `step`. */
  private walkTransport(step: number): number {
    const { run, local } = this.passPlace(step);
    return run.origin + run.clock.walkFrame(spawnStep(local));
  }

  /** The transport frame a note at `step` is first rendered at. */
  private onsetTransport(step: number): number {
    const { run, local } = this.passPlace(step);
    return run.origin + run.clock.onsetFrame(local);
  }

  // --------------------------------------------------------- live settings

  private cutFrameAt(step: number): number {
    return Math.round(swungFrame(step, this.stepFrames, this.swing));
  }

  /**
   * Where a planned voice starts, how long it lasts and how loud it is, **now**.
   *
   * ❗ The three settings a listener turns while the music runs are applied
   * here and nowhere else, which is what makes them free: `startedAt` is
   * untouched, no message goes to the worklet, and the plan is read, not
   * rewritten.
   */
  private frameOf(p: Planned): number {
    return this.cutFrameAt(p.startStep);
  }

  private lifeOf(p: Planned): number | undefined {
    return p.endStep === undefined
      ? undefined
      : Math.max(0, this.cutFrameAt(p.endStep) - this.frameOf(p));
  }

  private mixerNow() {
    return { numChannels: this.liveChannels, volumes: this.liveVolumes, boardRows: this.boardRows };
  }

  private gainOf(p: Planned): number {
    const focus = this.focusRow !== null && p.row !== this.focusRow ? this.focusOthers : 1;
    return p.baseGain * channelVolume(this.mixerNow(), { gridY: p.row }) * focus;
  }

  private scoreOf(p: Planned): number {
    return p.baseScore * channelVolume(this.mixerNow(), { gridY: p.row });
  }

  /** `scoreOf` for every walk, on the pass's own steps. */
  private walksOf(p: Planned, passSteps: number): PoolWalks {
    const channel = channelVolume(this.mixerNow(), { gridY: p.row });
    return {
      from: p.baseWalks.from + passSteps,
      scores: p.baseWalks.scores.map((score) => score * channel),
    };
  }

  /**
   * Whether the engine would give this note a record at all.
   *
   * `0x04d4` in `fmodextinput.prx`: no record when `channelVolume × Level` is
   * not positive -- the fader at zero, not the note's velocity, which may open
   * at 0 and rise. A note that fails this is consumed silently: not pooled,
   * not posted, and not stealing anything.
   */
  private audible(p: Planned): boolean {
    return channelVolume(this.mixerNow(), { gridY: p.row }) * p.level > 0;
  }

  /** The voice with its in-note automation put back on the current clock. */
  private onClock(p: Planned): Planned['voice'] {
    const base = swungFrame(p.startStep, this.stepFrames, this.swing);
    const frameAt = (offset: number) =>
      Math.round(swungFrame(p.startStep + offset, this.stepFrames, this.swing) - base);
    const v = p.voice;
    return {
      ...v,
      automation: v.automation?.map((point, index) => ({
        ...point, frame: frameAt(p.pointSteps[index] ?? 0),
      })),
      morph: v.morph === undefined ? undefined : {
        ...v.morph,
        points: v.morph.points.map((point, index) => ({
          ...point, frame: frameAt(p.pointSteps[index] ?? 0),
        })),
      },
    };
  }

  /**
   * Tempo, swing, channel count and the faders, applied without a rebuild.
   *
   * ✅ **Nothing the audio thread is working on is regenerated.** The samples
   * it holds, the voices already sounding and the plan itself are all
   * untouched: three numbers change, the playhead is carried over in STEPS
   * because a tempo change moves the seconds a musical position sits at, and
   * the next note posted uses the new values. There is no debounce because
   * there is nothing to debounce -- this is a handful of arithmetic, not a
   * pass over the song.
   *
   * ⚠️ It used to set overrides and re-plan behind a 450 ms timer, which re-ran
   * the whole voice pass -- 1,150 tracks on `Ascetic` -- on the thread that
   * also feeds the audio. That is the stutter a listener heard, and the delay
   * was there to make it happen less often rather than to fix it.
   */
  setSettings(settings: {
    tempo?: number; swing?: number; numChannels?: number; volumes?: readonly number[];
    boardRows?: number;
  }): void {
    if (settings.boardRows !== undefined) this.boardRows = settings.boardRows;
    if (settings.numChannels !== undefined) this.liveChannels = settings.numChannels;
    if (settings.volumes !== undefined) this.liveVolumes = settings.volumes;
    if (settings.swing !== undefined) this.swing = settings.swing;
    if (settings.tempo !== undefined) this.liveTempo = settings.tempo;
    if (!this.plan.length) {
      if (settings.tempo !== undefined) this.stepFrames = samplesPerStep(RATE, settings.tempo);
      return;
    }
    // Where we are in the music, not in seconds: a tempo change moves one and
    // not the other, and the music is what a listener is following.
    const stepNow = this.stepFrames > 0 ? this.position() / this.stepFrames : 0;
    const folded = this.pass > 0;
    this.rebasePass();
    if (settings.tempo !== undefined) this.stepFrames = samplesPerStep(RATE, settings.tempo);
    this.songFrames = Math.round(this.songSteps * this.stepFrames) + this.tailFrames;
    this.songSeconds = this.songFrames / RATE;
    this.cursorFrames = Math.min(this.songFrames, Math.round(stepNow * this.stepFrames));
    if (this.context) this.startedAt = this.context.currentTime;
    // The engine reads the tempo every chunk; a new one, or a fold, is a new run.
    if (this.playing && (folded || settings.tempo !== undefined || settings.swing !== undefined)) {
      this.startRun();
    }
    const now = this.position();
    // ❗ **`nextIndex` must never go BACKWARDS.** `pump` posts a look-ahead
    // window to the worklet, and those voices are already there and already
    // sounding; a playhead that lands before the end of that window would hand
    // every one of them over a second time. Dragging the tempo slider did
    // exactly that, thirty times a second, and it sounded like the notes
    // repeating and the mix getting very loud -- because they were, and it was.
    //
    // ⚠️ `handed` is kept for the same reason: it is what a steal's `cutAt`
    // measures from, and clearing it left stolen voices uncut, which is the
    // other half of that loudness.
    const want = this.plan.findIndex((p) => this.frameOf(p) >= now);
    this.nextIndex = Math.max(this.nextIndex, want < 0 ? this.plan.length : want);
    this.rebuildPoolTo(this.nextIndex);
    // The echo delay is in beats, so it follows the tempo.
    this.pushEffects();
    this.events.tick?.();
  }

  /**
   * The voice pool's size, applied without a rebuild.
   *
   * ❗ The plan has no cuts in it, so a new size is a new pool and nothing
   * else. Replayed up to the playhead so it holds what a playthrough at this
   * size would have been holding.
   */
  setPool(limit: number): void {
    this.poolLimit = limit;
    this.rebuildPool(this.position());
  }

  get poolSize(): number {
    return this.poolLimit;
  }

  /**
   * Rebuild the pool's state so it matches a playthrough that reached `upTo`.
   *
   * ⚠️ Changing the size cannot just start an empty pool from here: the
   * engine's stealing depends on what it is holding, so a pool that forgot the
   * last minute of the song would steal differently from one that had been
   * this size all along. Replaying the decisions is pure arithmetic over the
   * notes already passed -- no audio, no rebuild of the plan.
   */
  private rebuildPool(upTo: number): void {
    this.rebuildPoolTo(this.plan.findIndex((p) => this.frameOf(p) >= upTo));
  }

  /**
   * Replay the pool over the first `limit` notes of the plan, `-1` meaning all.
   *
   * ❗ **By INDEX, not by frame, when the clock has just moved.** A settings
   * change re-points the playhead, and everything already handed to the
   * worklet has to stay in the pool -- rebuilding to the playhead instead would
   * forget the look-ahead window and then hand it over a second time.
   */
  private rebuildPoolTo(limit: number): void {
    this.pool = new LiveVoicePool(this.poolLimit);
    this.noteEnd = new Map();
    const upTo = limit < 0 ? this.plan.length : limit;
    for (let i = 0; i < upTo; i += 1) {
      const p = this.plan[i];
      if (!this.audible(p)) continue;
      const { end } = this.pool.add(p.note, {
        start: p.poolStart, end: p.poolEnd, score: this.scoreOf(p), walks: this.walksOf(p, 0),
      });
      this.noteEnd.set(p.note, end);
    }
  }

  // -------------------------------------------------------------- transport

  /** The playhead, in song frames. */
  position(): number {
    const raw = this.rawPosition();
    const rg = this.regionFrames();
    if (!rg || raw < rg.startF) return raw;
    return rg.startF + ((raw - rg.startF) % rg.len);
  }

  /**
   * The audio context's frame for a transport frame: where the worklet plays
   * it, whatever block the message reaches it in (`play.at` in
   * `mixer-worklet.ts`).
   */
  private contextFrame(transport: number): number {
    return Math.round(this.startedAt * RATE + (transport - this.cursorFrames));
  }

  /**
   * Where the song's beats fall in the next `seconds`, as audio-context times
   * -- the same timeline the voices are posted on, so a click lands with the
   * notes. A beat is `STEPS_PER_BEAT` steps from the start of the song, on the
   * swung grid; `accent` marks the first of four. A looped section is gone
   * round: the beats after its end are the ones after its start, one length
   * later, as the pump posts the next pass.
   */
  beatsAhead(seconds: number): { when: number; accent: boolean }[] {
    if (!this.playing || !this.context || this.stepFrames <= 0) return [];
    const now = this.context.currentTime;
    const pos = this.position();
    const rg = this.regionFrames();
    const reach = seconds * RATE;
    const out: { when: number; accent: boolean }[] = [];
    let offset = 0;
    let beat = Math.ceil(this.stepAt(pos) / STEPS_PER_BEAT - 1e-6);
    for (let guard = 0; guard < 64; guard += 1) {
      let f = this.frameAt(beat * STEPS_PER_BEAT);
      if (rg && f >= rg.endF) {
        offset += rg.len;
        beat = Math.ceil(rg.startF === 0 ? 0 : this.stepAt(rg.startF) / STEPS_PER_BEAT - 1e-6);
        f = this.frameAt(beat * STEPS_PER_BEAT);
      } else if (!rg && f > this.songFrames) break;
      const ahead = f + offset - pos;
      if (ahead > reach) break;
      out.push({ when: now + Math.max(0, ahead) / RATE, accent: beat % 4 === 0 });
      beat += 1;
    }
    return out;
  }

  /** The node the mix leaves by, after the master fader; `null` before the audio exists. */
  get mixBus(): AudioNode | null {
    return this.master;
  }

  /** The clock as it runs: past the end of a looped section, not folded. */
  private rawPosition(): number {
    if (!this.playing || !this.context) return this.cursorFrames;
    return this.cursorFrames + (this.context.currentTime - this.startedAt) * RATE;
  }

  /** The section being gone round: the chip's, else the song when its loop is on. */
  private activeRegion(): { start: number; end: number } | null {
    if (this.region) return this.region;
    if (this.loop && this.songSteps > 0) return { start: 0, end: this.songSteps };
    return null;
  }

  private regionFrames(): { startF: number; endF: number; len: number; steps: number } | null {
    const r = this.activeRegion();
    if (!r) return null;
    const startF = this.frameAt(r.start);
    const endF = this.frameAt(r.end);
    if (endF <= startF) return null;
    return { startF, endF, len: endF - startF, steps: r.end - r.start };
  }

  private passFrame(p: Planned): number {
    const rg = this.pass > 0 ? this.regionFrames() : null;
    return this.frameOf(p) + (rg ? this.pass * rg.len : 0);
  }

  private passStep(p: Planned): number {
    const r = this.pass > 0 ? this.activeRegion() : null;
    return p.startStep + (r ? this.pass * (r.end - r.start) : 0);
  }

  private tagOf(p: Planned): number {
    return p.note + this.pass * Player.PASS_SPAN;
  }

  /**
   * The cursor is about to be set from the folded position: the pass goes
   * back to zero, and the frontier of handed-over steps comes down with it.
   */
  private rebasePass(): void {
    if (this.pass === 0) return;
    const r = this.activeRegion();
    if (r && this.handedUntilStep >= 0) this.handedUntilStep -= this.pass * (r.end - r.start);
    this.pass = 0;
  }

  /**
   * Bring a clock that has gone round a section back into it, in place.
   *
   * ❗ **The pass is a property of the section being gone round, and the
   * section can change or go away under a running clock**: the song's loop
   * switched off, a chip's region cleared or moved, or the transport stopped
   * (which stores the *folded* position). `passFrame` then loses its
   * `pass * len` offset while `rawPosition` keeps it -- or the other way
   * round -- and every voice left in the plan lands at delay 0 in one burst
   * (switching the loop off during the second pass played the whole rest of
   * the song at once, 2026-09-09), or nothing posts until the clock has run
   * the offset out (a pause in a second pass resumed into silence).
   *
   * So, before `activeRegion()` can answer differently: the position is
   * folded into the section it was gone round, the pass comes back to zero
   * with the frontier of handed-over steps (`rebasePass`), the clock restarts
   * from the folded position, and the pool is replayed to the scheduler's
   * index so its steps are in the same space as the notes still to come. The
   * same rebase a live tempo change does; `nextIndex` and `handed` are kept,
   * because they are per plan entry and the pass never touched them.
   */
  private foldPass(): void {
    if (this.pass === 0) return;
    const folded = this.position();
    this.rebasePass();
    this.cursorFrames = Math.min(this.songFrames, folded);
    if (this.playing && this.context) this.startedAt = this.context.currentTime;
    if (this.playing) this.startRun();
    const want = this.plan.findIndex((p) => this.frameOf(p) >= folded);
    this.nextIndex = Math.max(this.nextIndex, want < 0 ? this.plan.length : want);
    this.rebuildPoolTo(this.nextIndex);
  }

  /** The playhead in steps, undoing the swing: the inverse of `swungFrame`. */
  stepAt(frames: number): number {
    if (this.stepFrames <= 0) return 0;
    const pairLength = 2 * this.stepFrames;
    const pair = Math.floor(frames / pairLength);
    let within = frames - pair * pairLength;
    const even = stepLength(0, this.stepFrames, this.swing);
    let step = pair * 2;
    if (within >= even) {
      within -= even;
      step += 1;
      return step + within / stepLength(1, this.stepFrames, this.swing);
    }
    return step + within / even;
  }

  /** The frame a step position lands on under the current tempo and swing. */
  frameAt(step: number): number {
    return swungFrame(step, this.stepFrames, this.swing);
  }

  /** Start over at the end instead of stopping: the song's own loop flag, mirrored here. */
  get loop(): boolean {
    return this.songLoop;
  }

  set loop(on: boolean) {
    if (on === this.songLoop) return;
    // Switching the song's loop off while it is the section being gone round
    // takes that section away: fold the clock first. See `foldPass`.
    if (!on && this.region === null) this.foldPass();
    this.songLoop = on;
  }

  private songLoop = false;

  /**
   * A section to go round instead of the song, in steps; and a row to hear
   * on its own, the others turned down to `focusOthers`. Ours, for working
   * on one chip in place or on a region dragged out on the board's ruler:
   * the game has neither. Neither touches the plan: the region is passes
   * posted with an offset (`pass` below), the focus a factor on each voice's
   * gain as it is handed over, so the pool steals exactly as before.
   */
  private region: { start: number; end: number } | null = null;
  private focusRow: number | null = null;
  private focusOthers = 0.2;
  /**
   * Which time round a looped section the scheduler is posting, and the
   * timeline that goes with it.
   *
   * ❗ **A loop is not a seek at the end.** The pump ticks every 100 ms and
   * posts 350 ms ahead, so a loop done as "seek when the playhead is past the
   * end" restarted up to a tick late every time round and had already posted
   * the next bars' first notes -- heard as a limp and a spill at each turn.
   * Instead the clock runs on unwrapped, the playhead shown is the position
   * folded into the section, and voices are posted with the pass's offset:
   * frame + pass * length, pool step + pass * steps, tag + pass * span. A
   * section is whole cells, so its length in steps is even and the swing
   * pattern lines up from one pass to the next (`cutFrameAt` relies on it).
   * The song's own loop is the same thing over [0, songSteps].
   */
  private pass = 0;
  private static readonly PASS_SPAN = 1 << 24;

  setRegion(start: number, end: number): void {
    const next = end > start ? { start, end } : null;
    const same =
      (next === null && this.region === null) ||
      (next !== null && this.region !== null && next.start === this.region.start && next.end === this.region.end);
    if (same) return;
    // A different section, or none: the passes counted on the old one are
    // meaningless against the new one. Fold before `activeRegion` changes.
    this.foldPass();
    this.region = next;
    // A clock left past the new section's end goes to its start: see `seek`.
    const rg = this.regionFrames();
    if (rg && this.rawPosition() >= rg.endF) this.seek(rg.startF);
  }

  clearRegion(): void {
    if (this.region === null) return;
    this.foldPass();
    this.region = null;
  }

  get regionNow(): { start: number; end: number } | null {
    return this.region;
  }

  setFocus(row: number | null, others = 0.2): void {
    this.focusRow = row;
    this.focusOthers = others;
  }

  seek(frames: number): void {
    const was = this.playing;
    if (was) this.stop(false);
    this.cursorFrames = Math.min(this.songFrames, Math.max(0, frames));
    // ⚠️ **Never past the end of the section being gone round.** The pump
    // wraps as soon as the next voice is at or past the end, and posts the
    // second pass at frame + length while the clock is further still: the
    // whole pass lands at delay 0 in one burst, and `position` folds the
    // clock into the section from wherever it is. So a seek there goes to the
    // section's start, as a loop would have.
    const rg = this.regionFrames();
    if (rg && this.cursorFrames >= rg.endF) this.cursorFrames = rg.startF;
    // Everything before the cursor is skipped rather than replayed. A voice
    // that straddles the point is not resurrected: the engine has no way to
    // start a note in the middle and neither has this.
    this.nextIndex = this.plan.findIndex((p) => this.frameOf(p) >= this.cursorFrames);
    if (this.nextIndex < 0) this.nextIndex = this.plan.length;
    this.handed.clear();
    this.noteStart.clear();
    this.handedUntilStep = -1;
    this.pass = 0;
    this.rebuildPool(this.cursorFrames);
    this.stolen = 0;
    this.events.stolen?.(0);
    this.events.tick?.();
    if (was) this.play();
  }

  play(): void {
    if (!this.context || !this.node || this.playing) return;
    void this.context.resume();
    // Both clocks start over: the load's window, and the dropout counter's
    // reading of the output, which a pause moves without losing anything.
    this.node.port.postMessage({ type: 'resetHealth' });
    this.resetHealth();
    this.startedAt = this.context.currentTime;
    this.playing = true;
    this.startRun();
    this.events.playing?.(true);
    this.pump();
  }

  stop(clear = true): void {
    if (!this.playing) return;
    // The stored cursor is the folded position, so the pass has to come down
    // with it or `play` resumes against a clock the passes no longer match.
    this.foldPass();
    this.cursorFrames = this.position();
    this.playing = false;
    window.clearTimeout(this.timer);
    if (clear) {
      this.node?.port.postMessage({ type: 'stopAll' });
      this.health = {
        sounding: 0, notes: 0, queued: 0,
        audioLoad: this.health.audioLoad, dropouts: 0, lostMs: 0, agcGain: this.health.agcGain,
      };
      this.events.health?.(this.health);
    }
    this.events.playing?.(false);
  }

  /**
   * Post everything that starts inside the look-ahead window.
   *
   * A voice names the context frame it starts at (`play.at`) and the worklet
   * counts its delay down from there, so a voice posted early is sample-
   * accurate whichever block its message lands in; the window only has to be
   * wide enough that the next tick is never late.
   */
  private pump = (): void => {
    const node = this.node;
    if (!this.playing || !node) return;
    const now = this.rawPosition();
    const until = now + LOOKAHEAD * RATE;
    const rg = this.regionFrames();
    for (;;) {
      const atEnd = this.nextIndex >= this.plan.length
        || (rg !== null && this.frameOf(this.plan[this.nextIndex]) >= rg.endF);
      if (atEnd) {
        if (!rg) break;
        // The section's next time round, once the window reaches it. The
        // indices are revisited, so `handed` starts over; the tags and the
        // pool's steps carry the pass, so nothing collides with what still rings.
        const wrapAt = rg.endF + this.pass * rg.len;
        if (wrapAt >= until) break;
        this.pass += 1;
        const first = this.plan.findIndex((q) => this.frameOf(q) >= rg.startF);
        this.nextIndex = first < 0 ? this.plan.length : first;
        this.handed.clear();
        continue;
      }
      const p = this.plan[this.nextIndex];
      // ❗ **Never twice.** The index arithmetic is supposed to guarantee this
      // and once did not: a settings change re-pointed the playhead into the
      // middle of the look-ahead window and every voice in it was handed over
      // again, which sounded like the notes repeating and the mix getting very
      // loud. `handed` is cleared by `seek`, where re-posting IS right because
      // the worklet has been told to stop everything.
      if (this.handed.has(p.index)) {
        this.nextIndex += 1;
        continue;
      }
      // ❗ Frames and gain derived HERE, from the tempo, swing and faders as
      // they stand this instant. Everything else about the voice was decided
      // once.
      //
      // On the engine's clock the voice is placed on the run of its pass, and
      // the window closes on its WALK, not its onset: the walk takes a step's
      // notes together, in the pool's order, and a sub-step note placed later
      // than one of a later rank must not hold that one back past its own time.
      const run = p.voice.engine !== undefined ? this.runFor(this.pass, p.startStep) : null;
      const placed = run === null ? undefined : placeOnClock(p.voice, p.startStep, p.endStep, run.clock);
      const at = run === null || placed === undefined ? this.passFrame(p) : run.origin + placed.startFrame;
      const due = run === null ? at : run.origin + run.clock.walkFrame(spawnStep(p.startStep));
      if (due >= until) break;
      if (!this.audible(p)) {
        // Consumed without a record, as the engine consumes it.
        this.handed.set(p.index, p.startStep);
        this.handedUntilStep = Math.max(this.handedUntilStep, this.passStep(p));
        this.nextIndex += 1;
        continue;
      }
      const life = placed === undefined
        ? this.lifeOf(p)
        : placed.endFrame === undefined ? undefined : placed.endFrame - placed.startFrame;
      // Its end and cut as durations from its start: the worklet puts the
      // start on the context frame `at` names and counts them from there.
      const tag = this.tagOf(p);
      const passSteps = this.passStep(p) - p.startStep;
      const poolEnd = p.poolEnd + passSteps;
      // ❗ One call per NOTE, and an entry is a note with its layers inside;
      // see `Planned.note`.
      const { end, stole } = this.pool.add(tag, {
        start: p.poolStart + passSteps,
        end: poolEnd,
        score: this.scoreOf(p),
        walks: this.walksOf(p, passSteps),
      });
      this.noteEnd.set(tag, end);
      if (!this.noteStart.has(tag)) this.noteStart.set(tag, this.passStep(p));
      // A theft is at the walk of the thief's step, on the engine's clock.
      const cut = end < poolEnd
        ? (placed === undefined ? this.cutFrameAt(end) : this.walkTransport(end)) - at
        : undefined;
      node.port.postMessage({
        type: 'play',
        sampleId: p.sampleId,
        // ❗ On the context's own frame, so a burst lands where it was meant to
        // whichever block the message reaches the worklet in; `startFrame` and
        // the rest count from it.
        at: this.contextFrame(at),
        voice: {
          // An engine voice reads its slides off its walks and its window of
          // chunks; the automation's frames are the tracker's clock's.
          ...(placed === undefined
            ? this.onClock(p)
            : { ...p.voice, engine: placed.engine, engineGrid: placed.engineGrid }),
          gain: this.gainOf(p),
          // ❗ **Tagged by NOTE, not by layer.** A stacked instrument's layers
          // all came out of one of the engine's records, so they are taken away
          // together, expressed together, and counted together -- which is also
          // what lets the worklet report notes beside voices.
          tag,
          startFrame: 0,
          endFrame: life,
          cutFrame: cut,
        },
      });
      this.handed.set(p.index, p.startStep);
      this.handedUntilStep = Math.max(this.handedUntilStep, this.passStep(p));
      if (stole) {
        this.stolen += 1;
        this.events.stolen?.(this.stolen);
        // The victim loses its record at the thief's start, and every layer of
        // it goes with it -- one message now that the tag is the note. `cutAt`
        // counts the frames it still gets to sound, so measure from where it is
        // now.
        const startStep = this.noteStart.get(stole.index);
        if (startStep !== undefined) {
          const engine = placed !== undefined;
          const theft = engine ? this.walkTransport(stole.at) : this.cutFrameAt(stole.at);
          const began = engine ? this.onsetTransport(startStep) : this.cutFrameAt(startStep);
          node.port.postMessage({
            type: 'cutAt',
            tag: stole.index,
            frames: Math.max(0, theft - Math.max(now, began)),
            at: this.contextFrame(theft),
            began: this.contextFrame(began),
          });
        }
      }
      this.nextIndex += 1;
    }
    if (!rg && now >= this.songFrames) {
      // The end: stop the clock but not the audio, so releases, the echo and
      // the reverb ring on as they would in the game.
      this.stop(false);
      this.cursorFrames = this.songFrames;
    }
    this.events.tick?.();
    if (this.playing) this.timer = window.setTimeout(this.pump, TICK);
  };

  /** A voice-per-pixel histogram of the plan, so a song has a shape before it plays. */
  densityBins(width: number): Float32Array {
    const bins = new Float32Array(width);
    if (!this.plan.length || this.songFrames <= 0) return bins;
    for (const p of this.plan) {
      const x = Math.min(
        width - 1, Math.max(0, Math.floor((this.frameOf(p) / this.songFrames) * width)),
      );
      bins[x] += 1;
    }
    return bins;
  }

  // --------------------------------------------------------------- audition

  /**
   * Play a sequencer once, now, outside the plan: what the editor does when a
   * note is placed or clicked.
   *
   * ❗ **Through `renderSequencer` like everything else**, so an auditioned note
   * is the note the song will play -- same slot, same pitch, same envelope,
   * same stack. The sequencer is expected to be tiny (one note, one track); it
   * is planned at its own tempo and posted with every voice's timing relative
   * to the first, with no pool, tagged below zero so a plan note can never be
   * mistaken for it. Returns the tag, for `releaseAudition`.
   */
  async audition(seq: Sequencer, loader: InstrumentLoader): Promise<number> {
    const node = await this.ensureAudio();
    void this.context?.resume();
    const tag = this.auditionTag--;
    const stepFrames = samplesPerStep(RATE, seq.tempo);
    const voices: { sampleId: string; voice: VoiceSpec; startStep: number; endStep?: number }[] = [];
    await renderSequencer(seq, loader, {
      planOnly: true,
      voiceLimit: VOICES_UNLIMITED,
      exactLadder: false,
      onVoice: (voice, where) => {
        const sampleId = `g${where.guid}z${where.zone}`;
        if (!this.sent.has(sampleId)) {
          this.sent.add(sampleId);
          node.port.postMessage({
            type: 'load',
            sample: {
              id: sampleId,
              channels: voice.sample.channels.map((c) => new Float32Array(c)),
              sampleRate: voice.sample.sampleRate,
              loop: voice.sample.loop,
              smoothed: voice.sample.smoothed?.channels.map((c) => new Float32Array(c)),
            },
          });
        }
        voices.push({ sampleId, voice, startStep: where.startStep, endStep: where.endStep });
      },
    });
    const first = voices.reduce((m, v) => Math.min(m, v.startStep), Infinity);
    // On the engine's clock the render placed every voice on its own clock;
    // its frames are relative to the first one's, and its chunk table is the
    // tiny sequencer's.
    const firstFrame = voices.reduce((m, v) => Math.min(m, v.voice.startFrame ?? 0), Infinity);
    for (const { sampleId, voice, startStep, endStep } of voices) {
      const { sample: _s, random: _r, startFrame: _f, endFrame: _e, cutFrame: _c, ...rest } = voice;
      const engine = voice.engine !== undefined;
      const delay = engine
        ? (voice.startFrame ?? 0) - firstFrame
        : Math.round(swungFrame(startStep - first, stepFrames, seq.swing));
      const life = endStep === undefined || voice.endFrame === undefined
        ? undefined
        : engine
          ? Math.max(0, voice.endFrame - (voice.startFrame ?? 0))
          : Math.max(0, Math.round(swungFrame(endStep - first, stepFrames, seq.swing)) - delay);
      node.port.postMessage({
        type: 'play',
        sampleId,
        voice: {
          ...rest,
          tag,
          startFrame: delay,
          endFrame: life === undefined ? undefined : delay + life,
        },
      });
    }
    return tag;
  }

  /** Close the gate on an auditioned note before its written end. */
  releaseAudition(tag: number): void {
    this.node?.port.postMessage({ type: 'release', tag });
  }
}
