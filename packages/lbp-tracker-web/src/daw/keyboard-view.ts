/**
 * The Keyboard view: play the game's own sequencer instruments.
 *
 * ❗ This was `app.ts`, the instrument bench page, until the five pages became
 * one app on 2026-09-06; the code is the same, mounted into its view, its
 * element ids prefixed `kb-`, its keys answering only while the view is the
 * one shown, and its instrument following the chip selected on the board.
 * It keeps its own `AudioContext` and worklet: the bench A/Bs the engine
 * against the browser's resampler and loads samples under its own ids, which
 * the song's player must not see.
 *
 * Every piece of the chain this project has recovered meets here — the FARC
 * extraction, the varint `INSb` reader, the key splits, the pitch formula, the
 * mixer and the worklet. If any of them is wrong, this is where it becomes
 * audible.
 *
 * Assets are read from `fixtures/`, which is the user's own game data
 * extracted locally with `tools/ExtractGuid.java` and never committed. The dev
 * server only serves the repository, so nothing leaves this machine.
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
import { focusOwnsKeys } from '../keys.ts';
import { createApp, h, watch, type Component } from 'vue';
import { asset } from '../assets.ts';
import ControlPanel from '../controls/ControlPanel.vue';
import Fader from '../controls/Fader.vue';
import Checks from '../controls/Checks.vue';
import {
  bench,
  effectSettings,
  overrideAdsr,
  overrideFilter,
  overrideLfos,
} from '../controls/bench.ts';
import { CONTROLS } from '../controls/kit.ts';
import { ADSR_PARAMS, ADSR_PARAMS_B, evaluateAdsr } from '@lbptracker/lib/envelope.ts';
import { FILTER_PARAMS } from '@lbptracker/lib/audio/moog.ts';
import { LFO_PARAMS, OUTPUT_PARAMS, STACK_PARAMS } from '@lbptracker/lib/params.ts';
import { resolveSlot } from '@lbptracker/lib/instrument.ts';
import { readInstrument, usedSlots, type RInstrument } from '@lbptracker/cwlib/rinstrument.ts';
import { loadResource } from '@lbptracker/cwlib/resource.ts';
import { ENGINE_RATE, pitchRatio, velocityGain } from '@lbptracker/lib/voice.ts';
import { engineSample, loopRegion, readWav, type WavData } from '@lbptracker/lib/wav.ts';
import { webInflate } from '@lbptracker/cwlib/platform/web.ts';
import { engine as engineCard } from '../controls/engine.ts';
import { masterChoice, state } from './session.ts';
import { fillSoundField } from '../editor/glyph.ts';
import { pickInstrument } from '../editor/instrument-picker.ts';
import { instrumentsFrom, type InstrumentInfo } from '../editor/instruments.ts';

interface ManifestRow {
  guid: number;
  file: string;
  path: string;
  size: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Fetch an asset, failing loudly if the server did not serve it.
 *
 * Without the status check a 404 comes back as an HTML error page, and the
 * first thing to notice is `readWav` saying "not a RIFF/WAVE file" -- which
 * points at the parser instead of at the URL. That is exactly how the `#` in
 * `choir_g#4_v2.smp` hid for as long as it did.
 */
async function fetchAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }
  return response.arrayBuffer();
}
const log = (message: string, kind: 'info' | 'bad' = 'info') => {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = message;
  $('kb-log').prepend(line);
};

let context: AudioContext | undefined;
let node: AudioWorkletNode | undefined;
let master: GainNode | undefined;
let analyser: AnalyserNode | undefined;

let sampleIndex = new Map<number, ManifestRow>();
let instrument: RInstrument | undefined;
let loadedSlots: { guid: number; wav: WavData; name: string; baseNote: number }[] = [];
let engine: 'ours' | 'browser' = 'ours';

/**
 * Computer-keyboard layout, the one every tracker and DAW uses: the home row is
 * one octave with its sharps on the row above, and QWERTY is the octave above
 * that. The arrow keys shift octave.
 */
const KEY_MAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13,
  Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
  KeyO: 26, Digit0: 27, KeyP: 28,
};

/** MIDI note of the bottom key of the home row. C3 = 48 by default. */
let octaveBase = 48;
const heldKeys = new Set<string>();

async function ensureAudio(): Promise<AudioWorkletNode> {
  if (node) return node;
  context = new AudioContext();
  await context.audioWorklet.addModule(MIXER_WORKLET_URL);
  node = new AudioWorkletNode(context, 'lbp-mixer', { outputChannelCount: [2] });
  node.port.onmessage = (event) => {
    if (event.data?.type === 'missingSample') {
      log(`worklet has no sample "${event.data.id}"`, 'bad');
    }
  };
  analyser = new AnalyserNode(context, { fftSize: 2048 });
  master = new GainNode(context, { gain: 0.5 });
  node.connect(analyser);
  analyser.connect(master);
  master.connect(context.destination);
  meter();
  log(`audio started at ${context.sampleRate} Hz`);
  return node;
}

/** Pre-master peak, so clipping from summed voices is visible rather than guessed at. */
function meter(): void {
  const buf = new Float32Array(analyser!.fftSize);
  const tick = () => {
    analyser!.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    const over = peak > 1;
    $('kb-meter').textContent = `pre-master peak ${peak.toFixed(3)}${over ? '  ← OVER 1.0, clipping' : ''}`;
    $('kb-meter').className = over ? 'bad' : '';
    requestAnimationFrame(tick);
  };
  tick();
}

async function fetchManifest(dir: string): Promise<ManifestRow[]> {
  const response = await fetch(`/fixtures/${dir}/manifest.json`);
  if (!response.ok) {
    throw new Error(
      `no ${dir}/manifest.json: extract the game's data first with tools/ExtractGuid.java`,
    );
  }
  return response.json();
}

async function loadInstrument(row: ManifestRow): Promise<void> {
  $('kb-status').textContent = `loading ${row.file}…`;

  const bytes = new Uint8Array(await fetchAsset(`/fixtures/rinst/${encodeURIComponent(row.file)}`));
  const resource = await loadResource(bytes, webInflate);
  instrument = readInstrument(resource.data);

  const used = usedSlots(instrument);
  const slots: typeof loadedSlots = [];
  for (const { guid, slot } of used) {
    const sample = sampleIndex.get(guid);
    if (!sample) {
      log(`slot base ${slot.baseNote}: no sample for GUID ${guid}`, 'bad');
      continue;
    }
    // ⚠️ encodeURIComponent, not the bare name. Three of the game's 216 sample
    // files are named for sharps -- `choir_g#4_v2.smp`, `choir_f#3_v2.smp`,
    // `violin_spic_string4_f#4.smp` -- and a `#` in a URL starts the fragment,
    // so the browser requested `/fixtures/smp/choir_g` and silently dropped the
    // rest. It 404s, `readWav` then reports "not a RIFF/WAVE file", and the
    // instrument looks like a parser bug rather than a URL one. The 48 files
    // with spaces in their names had been working only because the browser
    // encodes those for you.
    const wavBytes = new Uint8Array(
      await fetchAsset(`/fixtures/smp/${encodeURIComponent(sample.file)}`),
    );
    const wav = readWav(wavBytes);
    slots.push({ guid, wav, name: sample.file, baseNote: slot.baseNote });
  }
  loadedSlots = slots;

  const worklet = await ensureAudio();
  slots.forEach((s, i) => {
    // The loader's loop region and its 16-frame patch, and the smoothed loop
    // its voices read with `declick`: see `engineSample`.
    const engine = engineSample(s.wav, s.guid);
    worklet.port.postMessage({
      type: 'load',
      sample: {
        id: `slot${i}`,
        channels: engine.channels,
        sampleRate: s.wav.sampleRate,
        loop: engine.loop,
        smoothed: engine.smoothed,
      },
    });
  });

  log(
    `${row.file}: ${slots.length} slots, revision ${resource.revision}, ` +
      `numStack ${instrument.numStack}${instrument.arpeggiate ? ', arpeggiate' : ''}`,
  );
  for (const s of slots) {
    log(
      `   ${s.name}: base ${noteName(s.baseNote)} (${s.baseNote}), ` +
        `${s.wav.sampleRate} Hz, ${s.wav.channels[0].length} frames` +
        (s.wav.loop ? `, loop ${s.wav.loop.start}..${s.wav.loop.end}` : ', no loop'),
    );
  }
  {
    const a = evaluateAdsr(instrument.params, ADSR_PARAMS, 0);
    log(
      `   ADSR: attack ${a.attack.toFixed(3)}s, decay ${a.decay.toFixed(3)}s, ` +
        `sustain ${a.sustain.toFixed(3)}, release ${a.release.toFixed(3)}s ` +
        `(Params[11..14])`,
    );
    const p = instrument.params;
    const b = evaluateAdsr(p, ADSR_PARAMS_B, 0);
    const lfos = LFO_PARAMS.map((l, n) =>
      p[l.depth].x > 0 || p[l.depth].y > 0
        ? `LFO${n + 1} rate ${p[l.rate].x.toFixed(2)} depth ${p[l.depth].x.toFixed(2)}`
        : null,
    ).filter(Boolean);
    log(
      `   output: level ${p[OUTPUT_PARAMS.level].x.toFixed(3)}, ` +
        `send ${p[OUTPUT_PARAMS.send].x.toFixed(3)}, ` +
        `drive ${p[OUTPUT_PARAMS.drive].x.toFixed(3)}; ` +
        (lfos.length ? lfos.join(', ') : 'no LFO'),
    );
    log(
      `   filter: cutoff ${p[3].x.toFixed(2)}, resonance ${p[4].x.toFixed(2)}, ` +
        `keytrack ${p[5].x.toFixed(2)}, env amount ${p[6].x.toFixed(2)}; ` +
        `its ADSR ${b.attack.toFixed(2)}/${b.decay.toFixed(2)}/` +
        `${b.sustain.toFixed(2)}/${b.release.toFixed(2)} (Params[3..10])`,
    );
  }
  log(`   splitNotes ${instrument.splitNotes.slice(0, slots.length + 1).join(', ')}`);

  buildKeyboard();
  $('kb-octave').textContent = `octave: ${noteName(octaveBase)}`;
  $('kb-status').textContent = `${row.file.replace(/\.rinst$/, '')} · ${slots.length} sample${slots.length === 1 ? '' : 's'}`;
  $('kb-controls').hidden = false;
  // Everything a console session needs to tap either engine. `master` matters:
  // it is where the worklet path and the AudioBufferSource path converge, so it
  // is the only place an A/B measurement can hear both.
  (window as unknown as { __lbp: unknown }).__lbp = {
    instrument, loadedSlots, context, node, master, analyser,
  };
}

function voiceFor(note: number) {
  if (!instrument || !context || loadedSlots.length === 0) return undefined;
  const zone = resolveSlot(instrument, note, loadedSlots.length);
  const s = loadedSlots[zone];
  const slot = usedSlots(instrument)[zone].slot;
  const ratio = pitchRatio(slot, note, 120);
  // The engine never reads a sample's own rate (the loader takes only
  // `nChannels` out of `fmt `): a frame per output frame at ratio 1, at the
  // engine's 48 kHz. See `ENGINE_RATE` in voice.ts.
  return { zone, s, ratio, playbackRate: ratio * (ENGINE_RATE / context.sampleRate) };
}

/** How long a note of a bench sequence is held, in seconds, from the slider. */
const noteSeconds = (): number => bench.value('length');

/**
 * The instrument's own ADSR, or undefined when the bench is asked to fall back
 * to the stand-ins so the two can be compared.
 *
 * `mod` is 0 here: the bench has no note word, so every `Params` range is taken
 * at its `.x` end, which is what a note with the modulation field at zero gets.
 */
function currentAdsr() {
  if (!instrument) return undefined;
  if (!bench.on('useEnvelope')) return undefined;
  return evaluateAdsr(instrument.params, ADSR_PARAMS, 0);
}

/**
 * The instrument's Moog ladder, or undefined when it is switched off.
 *
 * Left open (cutoff 1, no resonance, no envelope) the filter still colours the
 * sound -- this approximation loses a little even wide open -- so the checkbox
 * bypasses it entirely rather than setting it flat.
 */
function currentFilter() {
  if (!instrument) return undefined;
  if (!bench.on('useFilter')) return undefined;
  const p = instrument.params;
  return {
    settings: {
      cutoff: p[FILTER_PARAMS.cutoff].x,
      resonance: p[FILTER_PARAMS.resonance].x,
      keyTrack: p[FILTER_PARAMS.keyTrack].x,
      envAmount: p[FILTER_PARAMS.envAmount].x,
    },
    envelope: evaluateAdsr(p, ADSR_PARAMS_B, 0),
  };
}

/** The instrument's three LFOs, evaluated at modulation 0, or undefined when off. */
function currentLfos() {
  if (!instrument) return undefined;
  if (!bench.on('useLfos')) return undefined;
  const p = instrument.params;
  const one = (l: (typeof LFO_PARAMS)[number]) => ({
    rate: p[l.rate].x,
    depth: p[l.depth].x,
    spread: p[l.spread].x,
  });
  return [one(LFO_PARAMS[0]), one(LFO_PARAMS[1]), one(LFO_PARAMS[2])] as const;
}

/**
 * The unison stack, the same one `render.ts` builds.
 *
 * ❗ Without it two instruments that share their samples and differ only in
 * `Numstack` and `Params[0..2]` sound **identical** here: `piano` (2 layers,
 * detune 0.000, spread 0.030) and `honky_tonk_piano` (4 layers, detune 0.148,
 * spread 0.150) both play the same five samples, and they are exactly that
 * pair -- which is how the omission was found.
 *
 * The rules are `render.ts`'s and the long comments there carry the addresses:
 * `sqrt(1/Numstack)` gain, one random detune and pan offset per layer
 * including layer 0, a start offset that layer 0 draws and then throws away,
 * and the LFO phases fanned across the layers from one draw per note.
 */
function stackLayers(basePan: number, frames: number) {
  const layers = Math.max(1, instrument?.numStack ?? 1);
  const P = (i: number) => instrument?.params[i].x ?? 0;
  const bipolar = () => Math.random() * 2 - 1;
  const basePhase = [0, 1, 2].map(() => Math.random() * 2 * Math.PI);
  const out = [];
  for (let layer = 0; layer < layers; layer += 1) {
    const start = P(STACK_PARAMS.startOffset) * frames * Math.random();
    out.push({
      detune: 1 + 0.05 * P(STACK_PARAMS.detune) * bipolar(),
      // Unclamped, as in `render.ts`: the mixer folds it the engine's way.
      pan: basePan + 0.5 * P(STACK_PARAMS.spread) * bipolar(),
      startPosition: layer === 0 ? 0 : start,
      lfoPhase: [0, 1, 2].map(
        (n) => basePhase[n] + P(LFO_PARAMS[n].spread) * ((2 * Math.PI) / layers) * layer,
      ) as unknown as readonly [number, number, number],
    });
  }
  return { layers, stackGain: Math.sqrt(1 / layers), out };
}

/**
 * A note that lasts until it is let go.
 *
 * The sequencer never needs this -- every note it writes already knows its own
 * length -- so the gate is left open (no `endFrame`) and `Mixer.release` closes
 * it when the key, the mouse or the MIDI note comes up. One tag per sounding
 * note; retriggering the same note releases the old one first, which is what a
 * keyboard does and what stops a stuck key ringing forever.
 *
 * ⚠️ **Keyed by channel AND note, not by note.** Under MPE the same pitch
 * sounds on two channels at once -- two fingers on one key, bent apart -- and a
 * map keyed by pitch would have had the second note-on release the first.
 */
interface Held {
  readonly note: number;
  readonly tag: number;
  /** The last expression posted for this voice; see `sendExpression`. */
  bend: number;
  pressure: number;
  timbre: number;
}

/** The channel the computer keyboard and the mouse play on: past MIDI's 0-15. */
const LOCAL = 16;
const keyOf = (channel: number, note: number) => channel * 128 + note;

let nextTag = 1;
const sounding = new Map<number, Held>();

function noteOn(note: number, velocity = 96, channel = LOCAL): void {
  const v = voiceFor(note);
  if (!v || !node || !context) return;
  // The browser-resampler control has no note-off; it stays timed, and says so.
  if (engine === 'browser') {
    playNote(note);
    return;
  }
  noteOff(note, channel);
  const tag = nextTag++;
  sounding.set(keyOf(channel, note), { note, tag, bend: 0, pressure: 1, timbre: 0 });
  const adsr = overrideAdsr() ?? currentAdsr();
  // Every layer carries the note's own tag, which is what lets one `release`
  // -- and one `expression` -- close over the whole stack.
  const stack = stackLayers(bench.value('pPan'), v.s.wav.channels[0].length);
  node.port.postMessage({
    type: 'play',
    sampleId: `slot${v.zone}`,
    voice: {
      playbackRate: v.playbackRate,
      gain:
        velocityGain(velocity) * 2 *
        (instrument?.params[OUTPUT_PARAMS.level].x ?? 0.5) * stack.stackGain,
      pan: bench.value('pPan'),
      // The whole stack in one voice: one of the engine's records.
      layers: stack.out,
      drive: bench.value('pDrive'),
      echoSend: bench.value('echoSend'),
      reverbSend: bench.value('reverbSend'),
      // No `endFrame`: the gate stays open until `release` closes it.
      release: adsr ? 0 : Math.round(0.12 * context.sampleRate),
      envelope: adsr,
      // As the player's voices are: see `RenderOptions.declick`.
      declick: true,
      filter: overrideFilter() ?? currentFilter(),
      lfos: overrideLfos() ?? currentLfos(),
      tag,
    },
  });  // ⚠️ **An MPE controller sends the note's opening bend, press and slide
  // BEFORE the note-on**, so the channel is already holding them here: a note
  // struck halfway up a glide has to start there rather than snap to it.
  sendExpression(channel);
  setKeyDown(note, true);
  $('kb-detail').textContent = describe(note);
}

function noteOff(note: number, channel = LOCAL): void {
  const key = keyOf(channel, note);
  const held = sounding.get(key);
  if (held === undefined) return;
  sounding.delete(key);
  node?.port.postMessage({ type: 'release', tag: held.tag });
  // Another channel may still be holding this pitch -- which is the point of
  // MPE -- so the key on screen comes up only when the last of them lets go.
  let stillHeld = false;
  for (const other of sounding.values()) if (other.note === note) stillHeld = true;
  if (!stillHeld) setKeyDown(note, false);
}

/** Let go of everything, for Escape and for a lost focus. */
function panic(): void {
  for (const key of [...sounding.keys()]) noteOff(key % 128, Math.floor(key / 128));
  node?.port.postMessage({ type: 'stopAll' });
}

/**
 * Push the whole output stage to the worklet.
 *
 * Rebuilding an effect drops its tail, so this is called when a control moves
 * and not per note. ❗ The master bus is not the bench's: it is the engine
 * card's choice, so an instrument tried here goes through the same one as the
 * song, the AGC included.
 */
function pushEffects(): void {
  node?.port.postMessage({
    type: 'effects',
    ...effectSettings(context?.sampleRate ?? 48000),
    master: masterChoice(),
  });
}

function playNote(note: number, atSeconds = 0): void {
  const v = voiceFor(note);
  if (!v || !node || !context) return;
  const held = noteSeconds();
  const adsr = currentAdsr();
  const filter = currentFilter();
  const lfos = currentLfos();
  if (engine === 'browser') {
    const buffer = context.createBuffer(1, v.s.wav.channels[0].length, v.s.wav.sampleRate);
    buffer.copyToChannel(new Float32Array(v.s.wav.channels[0]), 0);
    const opts: AudioBufferSourceOptions = { buffer, playbackRate: v.ratio };
    if (v.s.wav.loop) {
      const region = loopRegion(v.s.wav.loop, v.s.wav.channels[0].length);
      opts.loop = true;
      opts.loopStart = region.start / v.s.wav.sampleRate;
      opts.loopEnd = region.end / v.s.wav.sampleRate;
    }
    const source = new AudioBufferSourceNode(context, opts);

    // ⚠️ The control is only worth having if it is actually equivalent. `loop`,
    // `loopStart` and `loopEnd` belong to AudioBufferSourceNode, NOT to
    // AudioBuffer -- setting them on the buffer is silently ignored, which left
    // this path not looping at all for three commits while our own mixer did.
    // A control that quietly differs is worse than no control, so say so loudly.
    if (Boolean(v.s.wav.loop) !== source.loop) {
      log(
        `control mismatch: sample ${v.s.name} ${v.s.wav.loop ? 'has' : 'has no'} loop ` +
          `but the browser source has loop=${source.loop}; the A/B is not comparing like with like`,
        'bad',
      );
    }

    const gain = new GainNode(context, { gain: velocityGain(96) * Math.SQRT1_2 });
    const at = context.currentTime + atSeconds;
    gain.gain.setValueAtTime(velocityGain(96) * Math.SQRT1_2, at + held);
    gain.gain.linearRampToValueAtTime(0, at + held + 0.12);
    source.connect(gain);
    gain.connect(master!);
    source.start(at);
    source.stop(at + held + 0.15);
    return;
  }
  const stack = stackLayers(0.5, v.s.wav.channels[0].length);
  node.port.postMessage({
    type: 'play',
    sampleId: `slot${v.zone}`,
    voice: {
      playbackRate: v.playbackRate,
      // The instrument's own level, Params[24], times sqrt(1/Numstack) -- the
      // equal-power correction the engine folds in for the stack this loop
      // now actually plays.
      gain:
        velocityGain(96) * 2 *
        (instrument?.params[OUTPUT_PARAMS.level].x ?? 0.5) * stack.stackGain,
      pan: 0.5,
      // The whole stack in one voice: one of the engine's records.
      layers: stack.out,
      startFrame: Math.round(atSeconds * context.sampleRate),
      // The samples loop, so a voice never ends on its own -- it has to be
      // released. Without this, low notes ring on and high notes cut off with
      // the sample rather than with the note.
      // With the instrument's own ADSR the end frame is the GATE, not the end:
      // the release runs on past it. Without it, the stand-in applies -- a
      // fixed 0.12 s linear fade.
      endFrame: Math.round(
        (atSeconds + held + (adsr ? 0 : 0.12)) * context.sampleRate,
      ),
      release: adsr ? 0 : Math.round(0.12 * context.sampleRate),
      envelope: adsr,
      declick: true,
      filter,
      lfos,
    },
  });}

function describe(note: number): string {
  const v = voiceFor(note);
  if (!v) return '';
  const semitones = note - v.s.baseNote;
  return (
    `${noteName(note)} (${note}) → slot ${v.zone} ${v.s.name} ` +
    `base ${noteName(v.s.baseNote)}, ${semitones >= 0 ? '+' : ''}${semitones} semitones, ` +
    `rate ${v.playbackRate.toFixed(4)}`
  );
}

/**
 * Which computer key plays a note, inverted from KEY_MAP for the caps.
 *
 * ⚠️ A `KeyboardEvent.code` is a name, not a character: `Comma`, `Period` and
 * `Slash` are three of the twenty-five keys in the map, and printing the code
 * verbatim put whole words across the keys they label.
 */
const CODE_GLYPH: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
  Backquote: '`',
};

function capsFor(note: number): string {
  const offset = note - octaveBase;
  for (const [code, value] of Object.entries(KEY_MAP)) {
    if (value !== offset) continue;
    return CODE_GLYPH[code] ?? code.replace(/^(Key|Digit)/, '');
  }
  return '';
}

/**
 * A real piano: white keys in a row, black keys overlaid between them.
 *
 * ⚠️ The black key's position cannot be derived from a count of naturals
 * alone -- there is no black key between E/F or B/C -- so each one is placed at
 * the boundary of the white key it follows. The offsets below are that
 * boundary, in white-key widths.
 */
const PIANO_LOW = 24; // C1
const PIANO_HIGH = 96; // C7
const BLACK_AFTER = new Set([0, 2, 5, 7, 9]); // C D F G A

function buildKeyboard(): void {
  const piano = $('kb-piano');
  piano.textContent = '';
  const whites: number[] = [];
  for (let note = PIANO_LOW; note <= PIANO_HIGH; note += 1) {
    if (!NOTE_NAMES[note % 12].includes('#')) whites.push(note);
  }
  const width = 100 / whites.length;

  whites.forEach((note, index) => {
    const key = document.createElement('div');
    key.className = 'wkey';
    key.dataset.note = String(note);
    key.title = describe(note);
    const v = voiceFor(note);
    const zone = document.createElement('div');
    zone.className = 'zone';
    if (v) zone.style.background = zoneColour(v.zone);
    const caps = document.createElement('div');
    caps.className = 'caps';
    caps.textContent = capsFor(note);
    const label = document.createElement('div');
    label.className = 'lbl';
    label.textContent = note % 12 === 0 ? noteName(note) : '';
    key.append(zone, caps, label);
    piano.append(key);

    // The sharp above this white key, if the pair has one.
    if (BLACK_AFTER.has(note % 12) && note + 1 <= PIANO_HIGH) {
      const sharp = note + 1;
      const black = document.createElement('div');
      black.className = 'bkey';
      black.dataset.note = String(sharp);
      black.title = describe(sharp);
      black.style.left = `${(index + 1) * width}%`;
      black.style.width = `${width * 0.62}%`;
      black.style.marginLeft = `${-width * 0.31}%`;
      const bz = document.createElement('div');
      bz.className = 'zone';
      const bv = voiceFor(sharp);
      if (bv) bz.style.background = zoneColour(bv.zone);
      const bc = document.createElement('div');
      bc.className = 'caps';
      bc.textContent = capsFor(sharp);
      black.append(bz, bc);
      piano.append(black);
    }
  });
}

/** Pointer play: press, glide across keys, release anywhere. */
function bindPiano(): void {
  const piano = $('kb-piano');
  let gliding = false;
  let last = -1;
  const noteAt = (target: EventTarget | null): number => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-note]');
    return el ? Number(el.dataset.note) : -1;
  };
  piano.addEventListener('pointerdown', (event) => {
    const note = noteAt(event.target);
    if (note < 0) return;
    // Playing a key takes the keyboard with it. Without this the page keeps
    // focus on whatever was clicked last -- a select, a slider -- and the letter
    // keys either do nothing or change that control instead of playing notes.
    piano.focus();
    gliding = true;
    last = note;
    piano.setPointerCapture(event.pointerId);
    noteOn(note);
    event.preventDefault();
  });
  piano.addEventListener('pointermove', (event) => {
    if (!gliding) return;
    // `elementFromPoint`, because the capture sends every move to the piano.
    const note = noteAt(document.elementFromPoint(event.clientX, event.clientY));
    if (note < 0 || note === last) return;
    noteOff(last);
    last = note;
    noteOn(note);
  });
  const up = () => {
    if (!gliding) return;
    gliding = false;
    noteOff(last);
    last = -1;
  };
  piano.addEventListener('pointerup', up);
  piano.addEventListener('pointercancel', up);
}

function zoneColour(zone: number): string {
  const hues = [150, 200, 265, 320, 20, 45, 90, 175];
  return `hsl(${hues[zone % hues.length]} 60% 55%)`;
}

/** Light the on-screen key, so the mapping is visible while playing. */
function setKeyDown(note: number, down: boolean): void {
  const el = document.querySelector<HTMLElement>(`#kb-piano [data-note="${note}"]`);
  el?.classList.toggle('down', down);
}

/** A flash for the timed bench buttons, which have no key-up to wait for. */
function flashKey(note: number): void {
  setKeyDown(note, true);
  setTimeout(() => setKeyDown(note, false), 140);
}

/** Octave changed: let go of everything and redraw the key caps. */
function shiftedOctave(): void {
  panic();
  $('kb-octave').textContent = `octave: ${noteName(octaveBase)}`;
  for (const el of document.querySelectorAll<HTMLElement>('#kb-piano [data-note]')) {
    const caps = el.querySelector('.caps');
    if (caps) caps.textContent = capsFor(Number(el.dataset.note));
  }
}

/* ----------------------------------------------------------------------- MPE
 *
 * MIDI Polyphonic Expression: one MIDI channel per sounding note, so pitch
 * bend, pressure and CC74 stop being channel-wide and become the note's own.
 * On a Seaboard, a LinnStrument or an Osmose that is the whole instrument --
 * without it, bending one finger bends every note under the others.
 *
 * ⚠️ **None of this is the game.** LBP3 has no MIDI at all. What the bench is
 * doing is reaching the engine's own per-voice quantities from a controller:
 * bend multiplies the rate exactly as a note's written glide does, and pressure
 * multiplies the gain exactly as its written volume glide does, so two of the
 * three dimensions land on paths the engine already has. The third, CC74, does
 * not -- see `Mixer.expression`, where that mapping is labelled as ours.
 */

/** A master channel and the member channels that carry its notes. */
interface Zone {
  readonly master: number;
  readonly members: readonly number[];
}

let zone: Zone | undefined;

/**
 * What each channel is currently being expressed with, as the controller left
 * it. Bend is the raw -1..1 fraction, before any range is applied, because the
 * range can change under a held note and the fraction is what the wheel said.
 *
 * ⚠️ **Seventeen long, not sixteen.** `LOCAL` is a channel here too, so the
 * computer keyboard and the mouse go through the same path as a controller and
 * read neutral values rather than off the end of the array -- where a typed
 * array gives `undefined`, `undefined * bendRange` gives NaN, and a NaN rate is
 * a note that never sounds.
 */
const chanBend = new Float64Array(LOCAL + 1);
const chanPress = new Float64Array(LOCAL + 1).fill(1);
/** CC74, 0..1, centred at 0.5 -- the value a controller idles at. */
const chanSlide = new Float64Array(LOCAL + 1).fill(0.5);
/** The RPN each channel has selected; 127/127 is MIDI's "none". */
const rpnMsb = new Int32Array(16).fill(127);
const rpnLsb = new Int32Array(16).fill(127);

/**
 * Semitones at full bend, per note.
 *
 * Starts at a plain wheel's 2 rather than at MPE's own 48: until a zone message
 * arrives there is no reason to believe the controller is an MPE one, and four
 * octaves on an ordinary wheel is unplayable. A zone -- announced or picked --
 * moves it to 48.
 */
let bendRange = 2;
/** Semitones at full bend on the master channel, which moves the whole zone. */
let masterBendRange = 2;

const mpeMode = () => $<HTMLSelectElement>('kb-mpeMode').value;

/**
 * The three dimensions a note on `channel` is being played with right now.
 *
 * The master channel's own bend is added to every member's, which is what makes
 * a zone-wide pitch wheel work while each finger keeps its own bend. It uses
 * its own range: a wheel that moved four octaves would be unplayable, and MPE
 * defaults the master to ±2 for that reason.
 */
function expressionOn(channel: number): [number, number, number] {
  const fromMaster =
    zone !== undefined && channel !== zone.master ? chanBend[zone.master] * masterBendRange : 0;
  return [
    chanBend[channel] * bendRange + fromMaster,
    bench.on('mpePress') ? chanPress[channel] : 1,
    bench.on('mpeSlide') ? chanSlide[channel] - 0.5 : 0,
  ];
}

/**
 * Push a channel's dimensions to every voice it is holding.
 *
 * ⚠️ **Unchanged values are dropped.** Controllers resend, generously: a
 * Seaboard idles at a few hundred messages a second per finger, and every one
 * that reaches the worklet is a thread hop for nothing. Comparing against what
 * was last posted for that voice is what keeps a ten-finger chord from
 * flooding the audio thread.
 */
function sendExpression(channel: number): void {
  if (!node) return;
  const [bend, pressure, timbre] = expressionOn(channel);
  let moved = false;
  for (const [key, held] of sounding) {
    if (Math.floor(key / 128) !== channel) continue;
    if (held.bend === bend && held.pressure === pressure && held.timbre === timbre) continue;
    held.bend = bend;
    held.pressure = pressure;
    held.timbre = timbre;
    moved = true;
    node.port.postMessage({ type: 'expression', tag: held.tag, bend, pressure, timbre });
  }
  // Only real movement reaches the readout. Every note-on calls this, and a
  // keyboard played with no controller attached would otherwise repaint a line
  // of zeroes on each key.
  if (moved) showMpeLive(channel, bend, pressure, timbre);
}

/** A master-channel move reaches every note in the zone. */
function sendZoneExpression(): void {
  if (zone === undefined) return;
  for (const member of zone.members) sendExpression(member);
}

/** Re-push everything, for when a mapping is switched rather than moved. */
function resendExpression(): void {
  const channels = new Set<number>();
  for (const key of sounding.keys()) channels.add(Math.floor(key / 128));
  for (const channel of channels) sendExpression(channel);
}

/**
 * Configure a zone, as the MPE Configuration Message does.
 *
 * `count` is the number of MEMBER channels, so a lower zone of 15 is master on
 * channel 1 and notes on 2..16. Zero switches the zone off, which is how a
 * controller says it is leaving MPE.
 */
function setZone(master: number, count: number): void {
  panic();
  const n = Math.min(Math.max(count, 0), 15);
  if (n === 0) zone = undefined;
  else if (master === 0) zone = { master: 0, members: Array.from({ length: n }, (_, i) => 1 + i) };
  else zone = { master: 15, members: Array.from({ length: n }, (_, i) => 15 - n + i) };
  showMpe();
}

/**
 * Put the bend range control on `semitones`, adding the option when a
 * controller announces a value the list does not have.
 */
function setBendRange(semitones: number): void {
  bendRange = Math.max(1, Math.min(96, Math.round(semitones)));
  const select = $<HTMLSelectElement>('kb-bendRange');
  if (![...select.options].some((o) => Number(o.value) === bendRange)) {
    const option = document.createElement('option');
    option.value = String(bendRange);
    option.textContent = `±${bendRange} (from the controller)`;
    select.append(option);
  }
  select.value = String(bendRange);
  // A range that moves under a held note moves the note: the wheel has not
  // changed, but what it means has.
  resendExpression();
  showMpe();
}

/**
 * A control change, including the two RPNs that matter.
 *
 * ⚠️ **Which channel RPN 0 is addressed to is read pragmatically here**,
 * not from a reading of the MPE text: on the master channel it sets the
 * zone-wide range, on any other it sets the per-note one. Controllers vary, and
 * the picker on the page is the override when one disagrees.
 */
function controlChange(channel: number, cc: number, value: number): void {
  if (cc === 120 || cc === 123) {
    panic();
    return;
  }
  if (cc === 74) {
    chanSlide[channel] = value / 127;
    if (zone !== undefined && channel === zone.master) sendZoneExpression();
    else sendExpression(channel);
    return;
  }
  if (cc === 101) {
    rpnMsb[channel] = value;
    return;
  }
  if (cc === 100) {
    rpnLsb[channel] = value;
    return;
  }
  // Data entry MSB. The LSB (CC 38) carries the bend range's cents, which
  // nothing here needs at a semitone's resolution.
  if (cc !== 6) return;
  const selected = (rpnMsb[channel] << 7) | rpnLsb[channel];
  if (selected === 6) {
    // The MPE Configuration Message -- the one RPN that can arrive on a channel
    // that is not yet part of any zone.
    if (mpeMode() !== 'auto') return;
    log(`MPE: zone message on ch ${channel + 1}, ${value} member channel${value === 1 ? '' : 's'}`);
    setZone(channel === 15 ? 15 : 0, value);
    if (value > 0) setBendRange(48);
  } else if (selected === 0) {
    if (zone !== undefined && channel === zone.master) {
      masterBendRange = Math.max(1, Math.min(96, value));
      showMpe();
    } else {
      setBendRange(value);
    }
    log(`MPE: bend range on ch ${channel + 1} is ±${value} semitones`);
  }
}

/** The zone, in words, under the pickers that set it. */
function showMpe(): void {
  const state = $('kb-mpeState');
  if (zone === undefined) {
    state.textContent =
      mpeMode() === 'auto'
        ? `plain MIDI, listening for a zone message. Bend ±${bendRange} st, whole channel.`
        : `plain MIDI, one bend for the whole channel, ±${bendRange} st.`;
    return;
  }
  const first = zone.members[0] + 1;
  const last = zone.members[zone.members.length - 1] + 1;
  state.textContent =
    `${zone.master === 0 ? 'lower' : 'upper'} zone: master ch ${zone.master + 1}, ` +
    `notes on ch ${Math.min(first, last)}–${Math.max(first, last)}. ` +
    `Bend ±${bendRange} st per note, ±${masterBendRange} st for the whole zone.`;
}

/**
 * The live readout, at the frame rate rather than the controller's.
 *
 * A Seaboard sends faster than the screen refreshes, so writing this on every
 * message is work the eye cannot see. The last values win and one frame paints.
 */
let liveChannel = -1;
let liveBend = 0;
let livePress = 1;
let liveSlide = 0.5;
let livePending = false;
function showMpeLive(channel: number, bend: number, pressure: number, timbre: number): void {
  liveChannel = channel;
  liveBend = bend;
  livePress = pressure;
  liveSlide = timbre + 0.5;
  if (livePending) return;
  livePending = true;
  requestAnimationFrame(() => {
    livePending = false;
    const where = liveChannel === LOCAL ? 'local' : `ch ${liveChannel + 1}`;
    $('kb-mpeLive').textContent =
      `${where} · bend ${liveBend >= 0 ? '+' : ''}${liveBend.toFixed(2)} st · ` +
      `press ${livePress.toFixed(2)} · slide ${liveSlide.toFixed(2)}`;
  });
}

/** The zone the mode picker asks for, and the range that mode implies. */
function applyMpeMode(): void {
  const mode = mpeMode();
  if (mode === 'lower') setZone(0, 15);
  else if (mode === 'upper') setZone(15, 15);
  else setZone(0, 0);
  // 48 semitones on a wheel is four octaves and unplayable; on a member channel
  // it is MPE's own default and what every MPE controller assumes. So the
  // default follows the mode, visibly, and stays overridable.
  setBendRange(mode === 'lower' || mode === 'upper' ? 48 : 2);
}

/**
 * Web MIDI, when the browser has it and the user allows it.
 *
 * ⚠️ `requestMIDIAccess` prompts, so it is asked for only when a device is
 * chosen -- opening the page must not put a permission dialog in the way of the
 * mouse and the computer keyboard, which need no permission at all.
 */
let midiAccess: MIDIAccess | null = null;

async function enableMidi(): Promise<void> {
  const state = $('kb-midiState');
  if (typeof navigator.requestMIDIAccess !== 'function') {
    state.textContent = 'not supported by this browser';
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    state.textContent = `refused: ${(error as Error).message}`;
    state.classList.remove('on');
    return;
  }
  const select = $<HTMLSelectElement>('kb-midiIn');
  const listed = [...(midiAccess?.inputs.values() ?? [])];
  select.innerHTML = '<option value="">none</option>';
  for (const input of listed) {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = input.name;
    select.append(option);
  }
  state.textContent = listed.length
    ? `${listed.length} input${listed.length === 1 ? '' : 's'}; pick one`
    : 'no inputs found';
  state.classList.toggle('on', listed.length > 0);
  if (listed.length === 1) {
    select.value = listed[0].id;
    listenTo(listed[0].id);
  }
}

function listenTo(id: string): void {
  for (const input of midiAccess?.inputs.values() ?? []) {
    input.onmidimessage = null;
  }
  const port = [...(midiAccess?.inputs.values() ?? [])].find((p) => p.id === id);
  const state = $('kb-midiState');
  if (!port) {
    state.textContent = 'no input selected';
    state.classList.remove('on');
    return;
  }
  port.onmidimessage = (event) => {
    const [status, a, b] = event.data ?? [];
    if (status === undefined) return;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    // 0x90 with velocity 0 is a note-off; every controller sends it that way.
    if (kind === 0x90 && b > 0) noteOn(a, b, channel);
    else if (kind === 0x80 || (kind === 0x90 && b === 0)) noteOff(a, channel);
    else if (kind === 0xe0) {
      // Pitch bend: 14 bits over two bytes, low seven first, centred at 8192.
      chanBend[channel] = (((b << 7) | a) - 8192) / 8192;
      if (zone !== undefined && channel === zone.master) sendZoneExpression();
      else sendExpression(channel);
    } else if (kind === 0xd0) {
      // Channel pressure -- MPE's Z, and per-note precisely because the channel
      // IS the note. `a` is the value; channel pressure has no second data byte.
      chanPress[channel] = a / 127;
      if (zone !== undefined && channel === zone.master) sendZoneExpression();
      else sendExpression(channel);
    } else if (kind === 0xb0) {
      controlChange(channel, a, b);
    }
  };
  state.textContent = `listening to ${port.name}`;
  state.classList.add('on');
}

function bindKeyboard(): void {
  /**
   * Anything inside the keyboard's own card counts as playing it.
   *
   * ⚠️ **A control still gets its keys while it has focus**, because a slider
   * that cannot be nudged with the arrows is worse than one that steals `Z`.
   * The card claims the keyboard only when the click did not land on a control.
   */
  const card = $('kb-piano').closest('section');
  card?.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, button, a')) return;
    $('kb-piano').focus();
  });

  window.addEventListener('keydown', (event) => {
    if (!active() || focusOwnsKeys(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.code === 'Escape') {
      panic();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowDown') {
      octaveBase = Math.max(0, octaveBase - 12);
      shiftedOctave();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowRight' || event.code === 'ArrowUp') {
      octaveBase = Math.min(108, octaveBase + 12);
      shiftedOctave();
      event.preventDefault();
      return;
    }

    const offset = KEY_MAP[event.code];
    if (offset === undefined) return;
    event.preventDefault();
    // Key repeat would retrigger the note dozens of times a second.
    if (event.repeat || heldKeys.has(event.code)) return;
    heldKeys.add(event.code);

    const note = octaveBase + offset;
    if (note < 0 || note > 127) return;
    noteOn(note);
  });

  window.addEventListener('keyup', (event) => {
    if (!heldKeys.delete(event.code)) return;
    const offset = KEY_MAP[event.code];
    if (offset !== undefined) noteOff(octaveBase + offset);
  });
  // A dropped keyup (alt-tab mid-note) would otherwise wedge the key -- and now
  // that a note lasts as long as its key is held, a wedged key rings forever.
  window.addEventListener('blur', () => {
    heldKeys.clear();
    panic();
  });
}

function playSequence(notes: number[], step: number): void {
  notes.forEach((n, i) => playNote(n, i * step));
  $('kb-detail').textContent =
    `${notes.length} notes, ${engine === 'ours' ? 'our mixer' : "the browser's resampler"}`;
}

let instruments: ManifestRow[] = [];
let loadedGuid = 0;
let active: () => boolean = () => true;
/** The palette the sound field and its picker show: built once the manifest is in. */
let palette: InstrumentInfo[] = [];

/** The sound field shows the loaded instrument's glyph and name. */
function showSound(guid: number): void {
  fillSoundField($('kb-instrument'), palette.find((i) => i.guid === guid), 'pick one…');
}

/** Load the instrument a chip plays, when it is not the one loaded. */
function followSelection(): void {
  const clip = state.clip();
  const guid = clip?.guid ?? 0;
  if (!guid || guid === loadedGuid) return;
  const index = instruments.findIndex((row) => row.guid === guid);
  if (index < 0) return;
  loadedGuid = guid;
  showSound(guid);
  void loadInstrument(instruments[index]).catch((e) => log(String(e), 'bad'));
}

async function init(): Promise<void> {
  try {
    const [rows, samples] = await Promise.all([
      fetchManifest('rinst'),
      fetchManifest('smp'),
    ]);
    instruments = rows;
    sampleIndex = new Map(samples.map((s) => [s.guid, s]));

    instruments.sort((a, b) => a.file.localeCompare(b.file));
    palette = instrumentsFrom(instruments);
    // The sound field opens the same picker a new chip asks with.
    $('kb-instrument').addEventListener('click', async () => {
      const guid = await pickInstrument(palette, 'Which sound?');
      const row = guid === null ? undefined : instruments.find((r) => r.guid === guid);
      if (!row) return;
      loadedGuid = row.guid;
      showSound(row.guid);
      void loadInstrument(row).catch((e) => log(String(e), 'bad'));
    });
    $('kb-status').textContent =
      `${instruments.length} instruments and ${samples.length} samples ready; pick one`;
    log(`manifest: ${instruments.length} instruments, ${samples.length} samples`);
    // The piano is loaded to begin with, so the page plays the moment it opens
    // rather than after a choice; the first instrument otherwise, should the
    // extraction lack it.
    const first = Math.max(0, instruments.findIndex((row) => row.file === 'piano.rinst'));
    if (instruments.length > 0) {
      loadedGuid = instruments[first].guid;
      showSound(loadedGuid);
      void loadInstrument(instruments[first]).catch((e) => log(String(e), 'bad'));
    }
    followSelection();
  } catch (error) {
    $('kb-status').textContent = String(error);
    log(String(error), 'bad');
    return;
  }

  $('kb-octaves').addEventListener('click', () => {
    // One note per slot, at that slot's own base note: every one plays at
    // ratio 1.0, so they should sound like one instrument.
    playSequence(loadedSlots.map((s) => s.baseNote).reverse(), 0.7);
  });
  $('kb-scale').addEventListener('click', () => {
    const major = [0, 2, 4, 5, 7, 9, 11];
    const notes: number[] = [];
    for (let octave = 0; octave < 5; octave += 1) {
      for (const step of major) notes.push(36 + octave * 12 + step);
    }
    playSequence(notes, 0.16);
  });
  $('kb-chromatic').addEventListener('click', () => {
    const notes: number[] = [];
    for (let n = 24; n <= 96; n += 1) notes.push(n);
    playSequence(notes, 0.12);
  });
  $('kb-stop').addEventListener('click', () => node?.port.postMessage({ type: 'stopAll' }));
  bindKeyboard();
  $<HTMLSelectElement>('kb-engine').addEventListener('change', (e) => {
    engine = (e.target as HTMLSelectElement).value as 'ours' | 'browser';
    log(`engine: ${engine}`);
  });
  $<HTMLSelectElement>('kb-interp').addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    node?.port.postMessage({ type: 'interpolator', name });
    log(
      name === 'engine'
        ? "sampler: the game's, linear, with the /2 and /4 copies above rate 2 and 4"
        : `sampler: ${name} over the full-rate sample (not what the game does)`,
    );
  });
  bindPiano();

  // The panel is Vue, and `src/controls/spec.ts` is the only place a fader is
  // declared. Nothing below this line reads an `<input>`.
  //
  // ⚠️ **Four mounts, not one app.** These are islands in a page that is
  // otherwise plain markup, so each attaches where its markup used to be rather
  // than the page being rebuilt around a root component. `Checks` is the same
  // component twice with a different group.
  const island = (root: Component, at: string, props?: Record<string, unknown>) => {
    const app = createApp(props ? { render: () => h(root, props) } : root);
    app.provide(CONTROLS, bench);
    app.mount(at);
  };
  island(ControlPanel, '#kb-control-panel');
  island(Fader, '#kb-note-length', { id: 'length' });
  island(Checks, '#kb-stage-toggles', { group: 'stage' });
  island(Checks, '#kb-mpe-toggles', { group: 'mpe' });

  // ❗ **Two things react to the store rather than living in it**, because
  // neither is state: the master gain is an `AudioParam` and has to be ramped
  // rather than set, and the output stage is rebuilt by a message to the
  // worklet. Both used to be `input` listeners on particular elements.
  watch(
    () => bench.value('gain'),
    (g) => {
      if (master && context) master.gain.setTargetAtTime(g, context.currentTime, 0.01);
    },
  );
  watch(bench.effectsSignature, () => pushEffects());
  watch(engineCard.effectsSignature, () => pushEffects());

  $<HTMLSelectElement>('kb-mpeMode').addEventListener('change', applyMpeMode);
  $<HTMLSelectElement>('kb-bendRange').addEventListener('change', (e) => {
    setBendRange(Number((e.target as HTMLSelectElement).value));
  });
  for (const id of ['mpePress', 'mpeSlide']) {
    $(id).addEventListener('change', resendExpression);
  }
  showMpe();

  const midiSelect = $<HTMLSelectElement>('kb-midiIn');
  midiSelect.addEventListener('mousedown', () => {
    if (!midiAccess) void enableMidi();
  }, { once: true });
  midiSelect.addEventListener('change', () => listenTo(midiSelect.value));
}

export function mountKeyboard(opts: { isActive: () => boolean; onShow: (l: () => void) => void }): void {
  active = opts.isActive;
  void init();
  // The chip selected on the board is the instrument here, whenever the view is
  // shown or the selection moves while it is.
  opts.onShow(followSelection);
  state.onChange(() => {
    if (active()) followSelection();
  });
  // Leaving the view lets go of every held note: a key held across the switch
  // would otherwise ring until the view came back.
  opts.onShow(() => {});
}
