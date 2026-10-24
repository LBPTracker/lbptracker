/**
 * An LBP instrument as Live's Sampler: the `.rinst`'s zones, samples, loops,
 * envelopes, filter and level, for a track of the `.als` export.
 *
 * ❗ **What this can be is measured, and so is where it stops.** Every member
 * below is written as Live 11.3 writes it -- the Sampler and its Shaper are
 * trees read out of Live's own Core Library (`SAMPLER`, `SHAPER`, generated,
 * never typed) -- and every number that says what a Live value means was read
 * off Live itself, a debug set opened and its device panel captured
 * (`steering/ableton-interchange.md`, *The instruments*).
 *
 * | the engine | the Sampler |
 * |---|---|
 * | a slot and its key zone (`resolveSlot`) | a zone over the same raw notes: the notes are written raw (`als.ts`), as the engine picks the slot off them |
 * | `Key`, the track's commonest | in every pitched zone's root; another part's `Key` and the scale are per-note pitch (`als.ts`) |
 * | the slot's root and fine tune | `RootKey` and `Detune`: the ratio is `2^((note − root + fine)/12)` |
 * | an unpitched slot, which plays at one rate | one zone per key, each its own root |
 * | `fitBpm`, `tempo / baseBpm` | in `Detune`: the tempo is the song's, fixed |
 * | the sample, played frame for frame at 48 kHz whatever its header says | a WAV written with a 48 kHz header, the frames verbatim (`samplerSampleFile`) |
 * | the loop, `[dwStart, dwEnd + 1)` as the game's loader reads it | the sustain loop, forward, no crossfade |
 * | the amplitude ADSR, linear, a stage time `param² × 4 s` | Live's, with linear slopes and the times the engine's rates give |
 * | the Moog ladder's cutoff, resonance, key tracking and envelope | Live's filter, low-pass, set to the same corners |
 * | `Params[24]`, the output level | the Sampler's volume; the 2 it enters the gain with is the track's (`mixerOf`) |
 * | `Params[26]`, the drive | the Shaper |
 * | the note's level and its ramp | per-note pressure, every note's (`als.ts`), through the Pressure row to Volume |
 *
 * ⚠️ **The modulation is fixed per track.** Every `Params` range is evaluated
 * at the modulation the track's notes use most -- 95.6% of the corpus's notes
 * use their part's -- because Live's Sampler routes a per-note source to two
 * destinations and an LBP instrument moves seven with it, twenty on the ray
 * gun. The notes at another value are counted, not bent.
 *
 * Not here: the unison stack, the three LFOs, the mip levels and the ladder's
 * own saturation. Each is either absent from the Sampler or would be set with
 * a unit nobody has measured; the steering says which.
 */

import { emitDevice, Ids, v, type DeviceNode } from './als-xml.ts';
import { ADSR_PARAMS, ADSR_PARAMS_B, evaluateAdsr, evaluateParam, type Adsr } from './envelope.ts';
import { FILTER_BYPASS_CUTOFF, FILTER_PARAMS, ladderCoefficients } from './audio/moog.ts';
import { resolveSlot, zoneCount } from './instrument.ts';
import { OUTPUT_PARAMS } from './params.ts';
import { usedSlots, type RInstrument } from '@lbptracker/cwlib/resources/instrument.ts';
import { loopRegion, readWav } from './wav.ts';

/** An instrument and the sample files it plays, as the caller fetched them. */
export interface AlsInstrumentSource {
  readonly instrument: RInstrument;
  /** Sample GUID to its `.smp` file: the name it had and its bytes. */
  readonly samples: ReadonlyMap<number, { readonly name: string; readonly bytes: Uint8Array }>;
}

/** A sample as the set holds it: a WAV in the project's `Samples/Imported`. */
export interface SamplerSample {
  /** The file's name, `piano_c4.wav`. */
  readonly file: string;
  readonly frames: number;
  /** The engine's loop region, `[start, end)`, when the sample has one. */
  readonly loop?: { readonly start: number; readonly end: number };
  /** The WAV itself: the `.smp`'s frames, verbatim, under a 48 kHz header. */
  readonly wav: Uint8Array;
}

/** The rate the engine plays every sample's frames at, whatever the file says. */
const ENGINE_RATE = 48000;

/**
 * The key Live's Sampler filter tracks from: at `ModByPitch` 1 the cutoff is the
 * dial's at key 60 and moves an octave per octave from there. Read off Live's
 * meters with `dev/probe-als-filter.ts` (2026-10-04): a 1 kHz sine under a
 * 1 kHz cutoff read the same at key 60 with tracking on as with it off.
 */
const LIVE_KEY_TRACK_REFERENCE = 60;

/**
 * How far the slide row moves the filter at Amount 100: `slide/127` of 72
 * semitones up from the dial, none at 0. Read off Live's meters with
 * `dev/probe-als-slide.ts` (2026-10-04): slides 16, 32, 48, 64 and 80 opened a
 * 125 Hz dial by 9.1, 17.2, 27.6, 36.3 and 46.0 semitones, where 72 x s/127
 * gives 9.1, 18.1, 27.2, 36.3 and 45.4.
 */
export const LIVE_SLIDE_SEMITONES = 72;

/**
 * The engine's ladder against Live's dial: for a nominal cutoff (`Params[3]²` of
 * 24 kHz, in Hz), where `MoogLadder` attenuates a sine by 8.0 dB, which is what
 * Live's Clean low-pass does at its own dial -- the same from 250 Hz to 8 kHz
 * (`dev/probe-als-cutoff.ts`, 2026-10-04). Generated by `dev/ladder-knee.ts`.
 *
 * ❗ **Equal nominal cutoffs are not equal filters.** The ladder's knee sits
 * 2 semitones under its nominal value at 500 Hz and 5 over it at 9 kHz, and
 * Live's softer knee already takes 3.3 dB off at half its dial where the
 * ladder takes 3.0. Mapped nominal to nominal, `Periastron`'s opening
 * `pulse_wave` sweep went dark in Live a second before the game. The shapes still
 * differ -- the ladder falls 23.6 dB an octave over its knee, Live 15.9 -- so no
 * dial copies the ladder everywhere, and this matches the two at Live's own
 * definition of its dial.
 */
const LADDER_KNEE: readonly (readonly [nominal: number, knee: number])[] = [
  [20.0, 13.5], [25.3, 18.3], [32.1, 24.3], [40.6, 32.0], [51.4, 41.6], [65.2, 53.7], [82.5, 69.1], [104.5, 88.6], [132.3, 113.3], [167.6, 144.7], [212.2, 184.7], [268.8, 235.6], [340.4, 300.5], [431.1, 383.5], [545.9, 489.7], [691.4, 626.3], [875.6, 802.4], [1108.8, 1030.7], [1404.3, 1328.2], [1778.4, 1718.7], [2252.2, 2235.9], [2852.2, 2927.7], [3612.2, 3862.8], [4574.5, 5139.2], [5793.3, 6887.9], [7336.7, 9254.5], [9291.4, 12313.3], [11766.9, 15884.0], [14901.8, 19425.3], [18872.0, 22283.3],
];

/** Live's dial, in Hz, where its filter attenuates as the engine's ladder at `freq` (0..1 of 24 kHz) does. */
export function liveDialHz(freq: number): number {
  const nominal = Math.max(0, freq) * (ENGINE_RATE / 2);
  if (nominal <= 0) return 0;
  const first = LADDER_KNEE[0];
  if (nominal <= first[0]) return nominal * (first[1] / first[0]);
  for (let i = 0; i + 1 < LADDER_KNEE.length; i++) {
    const [n0, k0] = LADDER_KNEE[i];
    const [n1, k1] = LADDER_KNEE[i + 1];
    if (nominal <= n1) return k0 * (k1 / k0) ** (Math.log(nominal / n0) / Math.log(n1 / n0));
  }
  // Past the last row the ladder never reaches -8 dB under Nyquist: Live's top, or past it.
  const last = LADDER_KNEE[LADDER_KNEE.length - 1];
  return nominal * (last[1] / last[0]);
}

/**
 * An `.smp` as a WAV Live plays exactly as the engine does.
 *
 * ❗ **The engine never reads the sample rate** (`steering/synth-engine.md`,
 * *The loader*): a frame is a frame at 48 kHz, and the 42 samples recorded at
 * 44.1 kHz play 8.8% fast in the game. Writing every file with a 48 kHz header
 * and the frames untouched gives Live the same frames at the same rate, with
 * nothing to correct in the zones. Only `fmt ` and `data` are kept; the loop is
 * the Sampler's own member, not the `smpl` chunk.
 */
export function samplerSampleFile(name: string, bytes: Uint8Array): SamplerSample {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let channels = 1;
  let data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'fmt ') channels = view.getUint16(at + 10, true);
    if (tag(at) === 'data') data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  if (data === undefined) throw new Error(`${name}: no data chunk`);
  const wav = new Uint8Array(44 + data.length);
  const out = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) wav[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  out.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, ENGINE_RATE, true);
  out.setUint32(28, ENGINE_RATE * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  ascii(36, 'data');
  out.setUint32(40, data.length, true);
  wav.set(data, 44);

  const read = readWav(bytes);
  const frames = read.channels[0].length;
  const region = read.loop ? loopRegion(read.loop, frames) : undefined;
  return {
    file: name.replace(/\.smp$/i, '') + '.wav',
    frames,
    loop: region !== undefined && region.end > region.start ? region : undefined,
    wav,
  };
}

/** What the track decides for the instrument it holds. */
export interface SamplerSettings {
  /** The modulation, 0..1, every `Params` range is read at. */
  readonly modulation: number;
  /** `Key`'s transposition in semitones, which every pitched zone's root takes. The zones stay where the engine's walk puts them. */
  readonly keyShift: number;
  /**
   * The base note the engine's key tracking measures from: the pitched slot the
   * track's notes play most (`trackingRoot`). The engine tracks each note from
   * its own slot's root, and a Sampler has one filter.
   */
  readonly trackingRoot: number;
  /**
   * The Sampler's volume as a linear gain, when the track does not want the
   * instrument's own at `modulation` (`heardLevel`): the loudest its notes
   * reach, with each note's pressure scaled down from it (`als.ts`).
   */
  readonly volume?: number;
  /**
   * The filter as the track wants it, when its notes move the cutoff: on if
   * any modulation it plays needs it, the dial at the lowest cutoff they reach,
   * and the slide routed to it to carry each note up from there (`als.ts`).
   * Absent, the filter is the instrument's at `modulation`.
   */
  readonly filter?: {
    readonly on: boolean;
    readonly hz: number;
    readonly slide: boolean;
    /** Semitones off the envelope amount, when the dial would have gone under Live's floor (`als.ts`). */
    readonly envelopeCut?: number;
  };
  /** The song's tempo, for a slot with `fitBpm`. */
  readonly tempo: number;
  /** The name the device shows. */
  readonly name: string;
}

/** One zone: which keys it answers, what it plays and at what pitch. */
export interface SamplerZone {
  readonly sample: SamplerSample;
  readonly lo: number;
  readonly hi: number;
  readonly root: number;
  /** Cents. */
  readonly detune: number;
}

/**
 * The zones the engine's walk makes of an instrument, as Live's key ranges.
 *
 * `resolveSlot`'s rule run backwards: zone `z` answers the raw notes from
 * `splitNotes[z + 1]` (0 for the last) up to `splitNotes[z] − 1` (127 for the
 * first), its sample is the `z`-th slot that has one -- the renderer's
 * compacted list -- and its root, tuning and flags are slot `z`'s.
 *
 * ❗ **The ranges are the raw notes', never moved.** `Key` transposes what a
 * pitched slot plays, so it lowers that zone's root, and an unpitched slot
 * plays at one rate whatever the note, so its zones keep theirs.
 */
export function samplerZones(
  instrument: RInstrument,
  sample: (guid: number) => SamplerSample | undefined,
  keyShift: number,
  tempo: number,
): SamplerZone[] {
  const used = usedSlots(instrument)
    .map((u) => ({ ...u, sample: sample(u.guid) }))
    .filter((u): u is typeof u & { sample: SamplerSample } => u.sample !== undefined);
  if (used.length === 0) return [];
  const splits = instrument.splitNotes;
  const usable = Math.max(1, Math.min(used.length, splits.length, zoneCount(instrument)));
  const zones: SamplerZone[] = [];
  const clampKey = (k: number) => Math.min(127, Math.max(0, k));
  for (let z = 0; z < usable; z += 1) {
    const lo = z + 1 < usable ? splits[z + 1] : 0;
    const hi = z === 0 ? 127 : splits[z] - 1;
    if (lo > hi) continue;
    const played = used[Math.min(z, used.length - 1)];
    const slot = instrument.slots[Math.min(z, instrument.slots.length - 1)];
    // `2^((note − base + fine)/12) × tempo/baseBpm`, as a root and cents.
    const cents = 100 * slot.fineTune + (slot.fitBpm ? 1200 * Math.log2(tempo / slot.baseBpm) : 0);
    const whole = Math.round(cents / 100);
    const detune = cents - 100 * whole;
    const from = lo;
    const to = hi;
    if (slot.pitched) {
      zones.push({ sample: played.sample, lo: from, hi: to, root: clampKey(slot.baseNote - whole - keyShift), detune });
    } else {
      // ❗ An unpitched slot plays every note at the same rate, and a Sampler
      // zone transposes: one zone per key, each its own root, is the same.
      for (let key = from; key <= to; key += 1) {
        zones.push({ sample: played.sample, lo: key, hi: key, root: clampKey(key - whole), detune });
      }
    }
  }
  return zones;
}

/**
 * Whether the engine plays a raw note on a pitched slot. An unpitched one plays
 * at one rate whatever the note, `Key` or glide (`voice.ts`), so a note there
 * carries no per-note pitch.
 */
export function playsPitched(instrument: RInstrument, note: number): boolean {
  const z = resolveSlot(instrument, note, usedSlots(instrument).length);
  return instrument.slots[Math.min(z, instrument.slots.length - 1)]?.pitched ?? true;
}

/**
 * The instrument's level where a note is heard, at a modulation: the gain the
 * Sampler's volume carries.
 *
 * ❗ `Params[24]` alone. The factor of 2 it enters the engine's gain with
 * (`synth-engine.md`) is already the track's, in the pan law `mixerOf` runs
 * backwards: written here as well, every track played 6 dB over the game and
 * the master clipped (2026-09-29).
 *
 * ❗ **And the ladder's passband, which falls as its resonance rises where
 * Live's does not.** Each stage of the Stilson/Smith ladder passes DC at 1, so
 * the feedback `q` leaves `1/(1 + q)` below the cutoff; Live's Clean circuit
 * is flat there (measured, `steering/ableton-interchange.md`). The gain is
 * taken where the note is heard: at the sustain when the amplitude holds one,
 * at the peak of a pluck. `saw_wave` loses 5.5 dB there.
 */
export function heardLevel(instrument: RInstrument, modulation: number): number {
  const P = (index: number) => evaluateParam(instrument.params[index] ?? { x: 0, y: 0 }, modulation);
  const cutoff = P(FILTER_PARAMS.cutoff) ** 2;
  const resonance = P(FILTER_PARAMS.resonance);
  const amount = P(FILTER_PARAMS.envAmount);
  const envA = evaluateAdsr(instrument.params, ADSR_PARAMS, modulation);
  const envB = evaluateAdsr(instrument.params, ADSR_PARAMS_B, modulation);
  const factor = (env: number) => Math.max(0.001, 1 + amount * (env - 1));
  const bypassed = cutoff >= 0.99 && amount <= 0;
  const heard = envA.sustain > 0 ? envB.sustain : 1;
  const heardFreq = Math.min(1, cutoff * factor(heard));
  const passband = bypassed || heardFreq > FILTER_BYPASS_CUTOFF
    ? 1
    : 1 / (1 + ladderCoefficients(heardFreq, Math.min(1, resonance * factor(heard))).q);
  return P(OUTPUT_PARAMS.level) * passband;
}

/**
 * The base note of the pitched slot the most of `notes` (raw) play on, which is
 * where the engine's filter tracking is 1; 60 when none plays a pitched slot.
 */
export function trackingRoot(instrument: RInstrument, notes: Iterable<number>): number {
  const counts = new Map<number, number>();
  const used = usedSlots(instrument).length;
  for (const note of notes) {
    const slot = instrument.slots[Math.min(resolveSlot(instrument, note, used), instrument.slots.length - 1)];
    if (slot?.pitched) counts.set(slot.baseNote, (counts.get(slot.baseNote) ?? 0) + 1);
  }
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [LIVE_KEY_TRACK_REFERENCE, 0])[0];
}

/** A zone as Live writes a `MultiSamplePart` -- the member list of a part Live saved. */
function zoneXml(zone: SamplerZone, id: number): string {
  const s = zone.sample;
  const loop = s.loop;
  const range = (tag: string, min: number, max: number) =>
    [`<${tag}>`, v('Min', min), v('Max', max), v('CrossfadeMin', min), v('CrossfadeMax', max), `</${tag}>`].join('\n');
  return [
    `<MultiSamplePart Id="${id}" HasImportedSlicePoints="false" NeedsAnalysisData="false">`,
    v('LomId', 0), v('Name', s.file), v('Selection', id === 0), v('IsActive', true), v('Solo', false),
    range('KeyRange', zone.lo, zone.hi), range('VelocityRange', 1, 127), range('SelectorRange', 0, 127),
    v('RootKey', zone.root), v('Detune', Math.round(zone.detune)), v('TuneScale', 100), v('Panorama', 0),
    v('Volume', 1), v('Link', false), v('SampleStart', 0), v('SampleEnd', s.frames),
    // Mode 1 is the forward loop and 0 none; 3 switches the release loop off.
    // Read off Live's Sample tab: `steering/ableton-interchange.md`.
    '<SustainLoop>', v('Start', loop?.start ?? 0), v('End', loop?.end ?? s.frames), v('Mode', loop ? 1 : 0),
    v('Crossfade', 0), v('Detune', 0), '</SustainLoop>',
    '<ReleaseLoop>', v('Start', 0), v('End', s.frames), v('Mode', 3), v('Crossfade', 0), v('Detune', 0), '</ReleaseLoop>',
    '<SampleRef>', '<FileRef>',
    // ❗ 3 is "inside the current project": Live finds the file by the relative
    // path when the project folder has `Ableton Project Info` in it. Measured.
    v('RelativePathType', 3), v('RelativePath', `Samples/Imported/${s.file}`), v('Path', `Samples/Imported/${s.file}`),
    v('Type', 1), v('LivePackName', ''), v('LivePackId', ''), v('OriginalFileSize', s.wav.length), v('OriginalCrc', 0),
    '</FileRef>', v('LastModDate', 0), '<SourceContext />', v('SampleUsageHint', 0),
    v('DefaultDuration', s.frames), v('DefaultSampleRate', ENGINE_RATE), '</SampleRef>',
    v('SlicingThreshold', 100), v('SlicingBeatGrid', 4), v('SlicingRegions', 8), v('SlicingStyle', 0),
    '<SampleWarpProperties>', '<WarpMarkers>',
    '<WarpMarker Id="0" SecTime="0" BeatTime="0" />', '<WarpMarker Id="1" SecTime="0.0156250004415619675" BeatTime="0.03125" />',
    '</WarpMarkers>', v('WarpMode', 0), v('GranularityTones', 30), v('GranularityTexture', 65),
    v('FluctuationTexture', 25), v('ComplexProFormants', 100), v('ComplexProEnvelope', 128),
    v('TransientResolution', 6), v('TransientLoopMode', 2), v('TransientEnvelope', 100), v('IsWarped', false),
    '<Onsets>', '<UserOnsets />', v('HasUserOnsets', false), '</Onsets>',
    '<TimeSignature>', '<TimeSignatures>', '<RemoteableTimeSignature Id="0">', v('Numerator', 4), v('Denominator', 4),
    v('Time', 0), '</RemoteableTimeSignature>', '</TimeSignatures>', '</TimeSignature>',
    '<BeatGrid>', v('FixedNumerator', 1), v('FixedDenominator', 16), v('GridIntervalPixel', 20), v('Ntoles', 2),
    v('SnapToGrid', true), v('Fixed', false), '</BeatGrid>',
    '</SampleWarpProperties>',
    '<SlicePoints />', '<ManualSlicePoints />', '<BeatSlicePoints />', '<RegionSlicePoints />',
    v('UseDynamicBeatSlices', true), v('UseDynamicRegionSlices', true),
    '</MultiSamplePart>',
  ].join('\n');
}

/** Milliseconds, inside the range a Sampler envelope takes. */
const ms = (seconds: number, floor: number) => Math.min(60000, Math.max(floor, seconds * 1000));

/**
 * The engine's ADSR as a Live envelope's segment times.
 *
 * ❗ **The engine's stages are rates, Live's are durations.** The engine climbs
 * 0 → 1 in `attack`, falls at `1/decay` a second until it reaches the sustain,
 * and after the gate falls at `1/release` from wherever it is (`envelope.ts`).
 * So the decay lasts `decay × (1 − sustain)`, and the release `release ×` the
 * level it starts from -- the sustain when the note was held that long, which
 * is what this writes; a note let go during its decay releases for less in
 * the game than here. Every slope is 0: the engine's stages are straight lines.
 */
function envelopeSet(prefix: string, adsr: Adsr, floor: number): Record<string, number> {
  return {
    [`${prefix}.AttackTime`]: ms(adsr.attack, 0.1),
    [`${prefix}.AttackSlope`]: 0,
    [`${prefix}.DecayTime`]: ms(adsr.decay * (1 - adsr.sustain), 1),
    [`${prefix}.DecaySlope`]: 0,
    [`${prefix}.SustainLevel`]: Math.min(1, Math.max(floor, adsr.sustain)),
    [`${prefix}.ReleaseTime`]: ms(adsr.release * (adsr.sustain > 0 ? adsr.sustain : 1), 1),
    [`${prefix}.ReleaseSlope`]: 0,
  };
}

/**
 * Where the Sampler's filter dial goes for an instrument at a modulation, in Hz,
 * and whether the engine bypasses its filter there.
 */
export function filterDial(
  instrument: RInstrument,
  modulation: number,
  keyShift: number,
  trackingRoot: number,
): { readonly hz: number; readonly bypassed: boolean; readonly swing: number; readonly keyTrack: number } {
  const P = (index: number) => evaluateParam(instrument.params[index] ?? { x: 0, y: 0 }, modulation);
  // The filter, the ladder's own terms put where Live keeps them. The cutoff
  // is a fraction of Nyquist at the engine's 48 kHz, and envelope B multiplies
  // it -- and the resonance -- by `1 + amount · (env − 1)` (`moog.ts`).
  const cutoff = P(FILTER_PARAMS.cutoff) ** 2;
  const amount = P(FILTER_PARAMS.envAmount);
  const envB = evaluateAdsr(instrument.params, ADSR_PARAMS_B, modulation);
  const factor = (env: number) => Math.max(0.001, 1 + amount * (env - 1));
  // ❗ **Live's envelope moves the cutoff in semitones, the engine's in
  // proportion, so the two agree at two levels and nowhere between.** The two
  // kept are the peak and the sustain, where a held note spends its time, or
  // the peak and the rest when the sustain is one of those. Fitted at the rest
  // and the peak, `robot` -- held at 0.58 of an amount of 0.98 -- sat 1.6
  // octaves under the game for as long as a note was held.
  // Past Live's 72 semitones the peak is kept and the rest rises: kept at
  // the rest, concertina's amount of 1 would peak at 6 % of its cutoff.
  // Each corner of the fit goes through the ladder's knee (`liveDialHz`): the
  // peak, and the sustain or the rest, as Live's dial would have to be to match.
  const knee = (x: number) => liveDialHz(Math.min(1, x));
  const held = envB.sustain > 0 && envB.sustain < 1;
  const peak = knee(cutoff * factor(1));
  const swing = Math.min(72, Math.max(-72, held
    ? (12 * Math.log2(peak / knee(cutoff * factor(envB.sustain)))) / (1 - envB.sustain)
    : 12 * Math.log2(peak / knee(cutoff * factor(0)))));
  const resting = peak / 2 ** (swing / 12);
  const bypassed = cutoff >= 0.99 && amount <= 0;
  // ❗ **Live's key tracking runs from MIDI 60, the engine's from the slot's
  // root.** The engine multiplies the cutoff by the note's playback rate, which
  // is 1 at the slot's base note after `Key` (`moog.ts`); Live's tracking at
  // 1 moves the cutoff an octave per octave from key 60, measured on its
  // meters (`probe-als-filter.ts`, 2026-10-04). So the dial goes up by the
  // distance between the two, in octaves, times the amount: `ghost`, rooted at
  // 48 on a track keyed +3, sat 15 semitones darker than the game until then.
  const keyTrack = Math.min(1, Math.max(0, P(FILTER_PARAMS.keyTrack)));
  const tracking = (keyTrack * (LIVE_KEY_TRACK_REFERENCE + keyShift - trackingRoot)) / 12;

  return { hz: resting * 2 ** tracking, bypassed, swing, keyTrack };
}
/**
 * The dial each control point wants: what puts Live's cutoff, where the note is
 * heard, at the engine's for that point's modulation and pitch.
 *
 * The Sampler is set at the `reference` modulation -- its filter envelope, its
 * key tracking -- and only the dial moves (the slide, `als.ts`). So for a
 * point the engine holds at `24 kHz x cutoff(m)² x keytrack x factor(env)`
 * (`moog.ts`), the dial is that over what Live adds on top of it: its
 * tracking from key 60 and its envelope at the reference's level. The level
 * is the one `heardLevel` takes, the sustain, or the peak of a pluck. At the
 * reference itself it is `filterDial`'s, so a track whose modulation never
 * moves is unchanged. `Infinity` where the engine bypasses its filter.
 */
export function heldDial(
  instrument: RInstrument,
  reference: number,
  keyShift: number,
  trackingRoot: number,
): { readonly at: (modulation: number, key: number, rate: number) => number; readonly heard: number } {
  const at = (m: number) => {
    const P = (index: number) => evaluateParam(instrument.params[index] ?? { x: 0, y: 0 }, m);
    const envA = evaluateAdsr(instrument.params, ADSR_PARAMS, m);
    const envB = evaluateAdsr(instrument.params, ADSR_PARAMS_B, m);
    return { P, heard: envA.sustain > 0 ? envB.sustain : 1 };
  };
  const ref = filterDial(instrument, reference, keyShift, trackingRoot);
  const heardRef = at(reference).heard;
  const live = 2 ** ((ref.swing * heardRef) / 12);
  const dial = (modulation: number, key: number, rate: number): number => {
    const { P, heard } = at(modulation);
    const cutoff = P(FILTER_PARAMS.cutoff) ** 2;
    const amount = P(FILTER_PARAMS.envAmount);
    if (cutoff >= 0.99 && amount <= 0) return Infinity;
    const keyTrack = Math.min(1, Math.max(0, P(FILTER_PARAMS.keyTrack)));
    const factor = Math.max(0.001, 1 + amount * (heard - 1));
    const engine = liveDialHz(Math.min(1, cutoff * (1 + (rate - 1) * keyTrack) * factor));
    return engine / (2 ** ((ref.keyTrack * (key - LIVE_KEY_TRACK_REFERENCE)) / 12) * live);
  };
  // `heard`: the reference envelope's level where the note is heard, which the
  // envelope amount is multiplied by there.
  return { at: dial, heard: heardRef };
}

/**
 * The playback rate the engine gives a note on its slot, which its filter's
 * key tracking multiplies by: 1 on an unpitched slot, else the sounding pitch
 * against the slot's base note (`voice.ts`, fine tune aside).
 */
export function slotRate(instrument: RInstrument, raw: number, sounding: number): number {
  const slot = instrument.slots[Math.min(resolveSlot(instrument, raw, usedSlots(instrument).length), instrument.slots.length - 1)];
  return slot?.pitched === false ? 1 : 2 ** ((sounding - (slot?.baseNote ?? 60)) / 12);
}

/**
 * An instrument as a Sampler device, for a track's device chain.
 *
 * `sample` hands back the prepared WAV for a sample GUID; the zones name
 * their files by it, so the caller writes the same files into the project.
 */
export function samplerDevice(
  ids: Ids,
  instrument: RInstrument,
  sample: (guid: number) => SamplerSample | undefined,
  settings: SamplerSettings,
): string {
  const P = (index: number) => evaluateParam(instrument.params[index] ?? { x: 0, y: 0 }, settings.modulation);
  const zones = samplerZones(instrument, sample, settings.keyShift, settings.tempo);

  const resonance = P(FILTER_PARAMS.resonance);
  const amount = P(FILTER_PARAMS.envAmount);
  const envA = evaluateAdsr(instrument.params, ADSR_PARAMS, settings.modulation);
  const envB = evaluateAdsr(instrument.params, ADSR_PARAMS_B, settings.modulation);
  const dial = filterDial(instrument, settings.modulation, settings.keyShift, settings.trackingRoot);
  const { swing, keyTrack } = dial;
  const filterOn = settings.filter?.on ?? !dial.bypassed;
  const filterHz = settings.filter?.hz ?? dial.hz;
  const filter = 'Filter.Slot.Value.SimplerFilter';
  const drive = Math.min(1, Math.max(0, P(OUTPUT_PARAMS.drive)));
  const volume = settings.volume ?? heardLevel(instrument, settings.modulation);

  return emitDevice(ids, ['c', 'MultiSampler', { Id: '0' }, SAMPLER_MEMBERS], {
    LastPresetRef: { xml: '<Value />' },
    SourceContext: { xml: '<Value />' },
    UserName: settings.name,
    ShouldShowPresetName: false,
    'Player.MultiSampleMap.SampleParts': { xml: zones.map(zoneXml).join('\n') },
    // ❗ **32 voices, and a repeated key does not cut the one before.** The
    // engine's pool is 32 (`synth-engine.md`) and it gives two notes of one key
    // a voice each. `NumVoices` is an index, read off Live: 5 shows 6 voices,
    // 13 shows 24 and 14 shows 32. The default 6 would have cut every chord
    // denser than that; the default retrigger, every overlap.
    'Globals.NumVoices': 14,
    'Globals.RetriggerMode': false,
    'VolumeAndPan.Volume': volume > 0 ? 20 * Math.log10(volume) : -36,
    // ❗ **Vel → Vol at 0, Live's own default: the velocity plays no part.**
    // The level is the pressure's alone, and every note goes in at velocity
    // 127. At 1 Live raised a velocity-127 note 22.8 dB over the dial (and a
    // velocity-64 one sat 2.4 dB under it): every track that loud, and the
    // master had to come down 20 dB not to clip. Read off Live's meters,
    // 2026-10-04 (`steering/ableton-interchange.md`, *The instruments*).
    'VolumeAndPan.VolumeVelScale': 0,
    ...envelopeSet('VolumeAndPan.Envelope', envA, 0.0003162277571),
    'Filter.IsOn': filterOn,
    [`${filter}.Freq`]: filterHz,
    [`${filter}.Res`]: resonance,
    [`${filter}.ModByPitch`]: keyTrack,
    [`${filter}.Envelope.IsOn`]: amount !== 0,
    [`${filter}.Envelope.Amount`]: swing - (settings.filter?.envelopeCut ?? 0),
    [`${filter}.Envelope.DecayLevel`]: 1,
    [`${filter}.Envelope.AttackLevel`]: 0,
    [`${filter}.Envelope.ReleaseLevel`]: 0,
    ...envelopeSet(`${filter}.Envelope`, envB, 0),
    'Shaper.IsOn': drive > 0,
    'Shaper.Slot.Value': drive > 0 ? { xml: emitDevice(ids, SHAPER, { Amount: drive * 100 }) } : { xml: '' },
    // The note's level and its ramp ride on per-note pressure (`als.ts`); the
    // Pressure row is `MidiCtrl.0` and Volume is destination 18, both read off
    // Live's MIDI tab. ❗ At 100 a note with no pressure is silent, so every
    // note the set holds carries some.
    'MidiCtrl.0.ModConnections.0.Amount': 100,
    'MidiCtrl.0.ModConnections.0.Connection': 18,
    // The slide row (`MidiCtrl.4`) to Filter Freq (12), when the cutoff moves
    // with the modulation: at 100 it raises the cutoff 72 semitones x
    // slide/127 (`LIVE_SLIDE_SEMITONES`), and each note's slide says how far.
    'MidiCtrl.4.ModConnections.0.Amount': settings.filter?.slide ? 100 : 0,
    'MidiCtrl.4.ModConnections.0.Connection': settings.filter?.slide ? 12 : 0,
  });
}

/* ---------------------------------------------------------------- the trees */
// Generated from Live 11.3's own files -- see the header of als-sampler.ts.

/** Live's default Sampler, `Core Library/Defaults/Instruments/Sampler.adv`. */
const SAMPLER: DeviceNode =
['c', 'MultiSampler', {}, [
  ['v', 'LomId', 0],
  ['v', 'LomIdView', 0],
  ['v', 'IsExpanded', true],
  ['b', 'On', true],
  ['v', 'ModulationSourceCount', 0],
  ['x', 'ParametersListWrapper', {'LomId':'0'}],
  ['x', 'Pointee', {'Id':'0'}],
  ['v', 'LastSelectedTimeableIndex', 0],
  ['v', 'LastSelectedClipEnvelopeIndex', 0],
  ['c', 'LastPresetRef', {}, [
    ['c', 'Value', {}, [
      ['c', 'FilePresetRef', {'Id':'0'}, [
        ['c', 'FileRef', {}, [
          ['v', 'RelativePathType', 5],
          ['v', 'RelativePath', 'Defaults/Instruments/Sampler.adv'],
          ['v', 'Path', '/Volumes/data/tmp/trunk/Core Library/Defaults/Instruments/Sampler.adv'],
          ['v', 'Type', 2],
          ['v', 'LivePackName', 'Core Library'],
          ['v', 'LivePackId', 'www.ableton.com/0'],
          ['v', 'OriginalFileSize', 0],
          ['v', 'OriginalCrc', 0],
        ]],
      ]],
    ]],
  ]],
  ['x', 'LockedScripts', {}],
  ['v', 'IsFolded', false],
  ['v', 'ShouldShowPresetName', true],
  ['v', 'UserName', ''],
  ['v', 'Annotation', ''],
  ['c', 'SourceContext', {}, [
    ['x', 'Value', {}],
  ]],
  ['v', 'OverwriteProtectionNumber', 2820],
  ['c', 'Player', {}, [
    ['c', 'MultiSampleMap', {}, [
      ['x', 'SampleParts', {}],
      ['v', 'LoadInRam', false],
      ['v', 'LayerCrossfade', 0],
      ['x', 'SourceContext', {}],
    ]],
    ['c', 'LoopModulators', {}, [
      ['v', 'IsModulated', false],
      ['f', 'SampleStart', 0, 0, 1],
      ['f', 'SampleLength', 1, 0, 1],
      ['b', 'LoopOn', false],
      ['f', 'LoopLength', 1, 0, 1],
      ['f', 'LoopFade', 0, 0, 1],
    ]],
    ['b', 'Reverse', false],
    ['b', 'Snap', false],
    ['f', 'SampleSelector', 0, 0, 127],
    ['c', 'SubOsc', {}, [
      ['b', 'IsOn', false],
      ['c', 'Slot', {}, [
        ['x', 'Value', {}],
      ]],
    ]],
    ['v', 'InterpolationMode', 1],
    ['v', 'UseConstPowCrossfade', true],
  ]],
  ['c', 'Pitch', {}, [
    ['f', 'TransposeKey', 0, -48, 48],
    ['f', 'TransposeFine', 0, -50, 50],
    ['f', 'PitchLfoAmount', 0, 0, 1],
    ['c', 'Envelope', {}, [
      ['b', 'IsOn', false],
      ['c', 'Slot', {}, [
        ['x', 'Value', {}],
      ]],
    ]],
    ['v', 'ScrollPosition', -1073741824],
  ]],
  ['c', 'Filter', {}, [
    ['b', 'IsOn', true],
    ['c', 'Slot', {}, [
      ['c', 'Value', {}, [
        ['c', 'SimplerFilter', {'Id':'0'}, [
          ['e', 'LegacyType', 0],
          ['e', 'Type', 0],
          ['e', 'CircuitLpHp', 0],
          ['e', 'CircuitBpNoMo', 0],
          ['b', 'Slope', true],
          ['f', 'Freq', 22000, 30, 22000],
          ['f', 'LegacyQ', 0.6999999881, 0.3000000119, 10],
          ['f', 'Res', 0.09090908617, 0, 1.25],
          ['f', 'X', 0, 0, 1],
          ['f', 'Drive', 0, 0, 24],
          ['c', 'Envelope', {}, [
            ['f', 'AttackTime', 0.1000000015, 0.1000000015, 20000],
            ['f', 'AttackLevel', 0, 0, 1],
            ['f', 'AttackSlope', 0, -1, 1],
            ['f', 'DecayTime', 600, 1, 60000],
            ['f', 'DecayLevel', 1, 0, 1],
            ['f', 'DecaySlope', 1, -1, 1],
            ['f', 'SustainLevel', 0, 0, 1],
            ['f', 'ReleaseTime', 50, 1, 60000],
            ['f', 'ReleaseLevel', 0, 0, 1],
            ['f', 'ReleaseSlope', 1, -1, 1],
            ['e', 'LoopMode', 0],
            ['f', 'LoopTime', 100, 0.200000003, 20000],
            ['f', 'RepeatTime', 3, 0, 14],
            ['f', 'TimeVelScale', 0, -100, 100],
            ['v', 'CurrentOverlay', 0],
            ['b', 'IsOn', true],
            ['f', 'Amount', 0, -72, 72],
            ['v', 'ScrollPosition', 0],
          ]],
          ['f', 'ModByPitch', 1, 0, 1],
          ['f', 'ModByVelocity', 0, 0, 1],
          ['f', 'ModByLfo', 0, 0, 24],
        ]],
      ]],
    ]],
  ]],
  ['c', 'Shaper', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'VolumeAndPan', {}, [
    ['f', 'Volume', -12, -36, 36],
    ['f', 'VolumeVelScale', 0, 0, 1],
    ['f', 'VolumeKeyScale', 0, -1, 1],
    ['f', 'VolumeLfoAmount', 0, 0, 1],
    ['f', 'Panorama', 0, -1, 1],
    ['f', 'PanoramaKeyScale', 0, -1, 1],
    ['f', 'PanoramaRnd', 0, 0, 1],
    ['f', 'PanoramaLfoAmount', 0, 0, 1],
    ['c', 'Envelope', {}, [
      ['f', 'AttackTime', 0.1000000015, 0.1000000015, 20000],
      ['f', 'AttackLevel', 0.0003162277571, 0.0003162277571, 1],
      ['f', 'AttackSlope', 0, -1, 1],
      ['f', 'DecayTime', 600, 1, 60000],
      ['f', 'DecayLevel', 1, 0.0003162277571, 1],
      ['f', 'DecaySlope', 1, -1, 1],
      ['f', 'SustainLevel', 1, 0.0003162277571, 1],
      ['f', 'ReleaseTime', 50, 1, 60000],
      ['f', 'ReleaseLevel', 0.0003162277571, 0.0003162277571, 1],
      ['f', 'ReleaseSlope', 1, -1, 1],
      ['e', 'LoopMode', 0],
      ['f', 'LoopTime', 100, 0.200000003, 20000],
      ['f', 'RepeatTime', 3, 0, 14],
      ['f', 'TimeVelScale', 0, -100, 100],
      ['v', 'CurrentOverlay', 0],
    ]],
    ['c', 'OneShotEnvelope', {}, [
      ['f', 'FadeInTime', 0.1000000015, 0, 2000],
      ['e', 'SustainMode', 0],
      ['f', 'FadeOutTime', 0.1000000015, 0, 2000],
    ]],
  ]],
  ['c', 'AuxEnv', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'Lfo', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'AuxLfos.0', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'AuxLfos.1', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'KeyDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'VelDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'RelVelDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'MidiCtrl.0', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.1', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.2', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.3', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.4', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.5', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'Globals', {}, [
    ['v', 'NumVoices', 5],
    ['v', 'NumVoicesEnvTimeControl', false],
    ['v', 'RetriggerMode', true],
    ['v', 'ModulationResolution', 2],
    ['f', 'SpreadAmount', 0, 0, 100],
    ['f', 'KeyZoneShift', 0, -48, 48],
    ['e', 'PortamentoMode', 0],
    ['f', 'PortamentoTime', 50, 0.1000000015, 10000],
    ['v', 'PitchBendRange', 5],
    ['v', 'MpePitchBendRange', 48],
    ['v', 'ScrollPosition', 0],
    ['c', 'EnvScale', {}, [
      ['f', 'EnvTime', 0, -100, 100],
      ['f', 'EnvTimeKeyScale', 0, -100, 100],
      ['b', 'EnvTimeIncludeAttack', true],
    ]],
    ['v', 'IsSimpler', false],
    ['v', 'PlaybackMode', 0],
    ['v', 'LegacyMode', false],
  ]],
  ['c', 'ViewSettings', {}, [
    ['v', 'SelectedPage', 0],
    ['v', 'ZoneEditorVisible', false],
    ['v', 'Seconds', false],
    ['v', 'SelectedSampleChannel', 0],
    ['v', 'VerticalSampleZoom', 1],
    ['v', 'IsAutoSelectEnabled', false],
    ['v', 'SimplerBreakoutVisible', false],
  ]],
  ['c', 'SimplerSlicing', {}, [
    ['v', 'PlaybackMode', 0],
  ]],
]];

/** Live's Shaper, from the Core Library's `Saw Filtered Bass` Sampler preset. */
const SHAPER: DeviceNode =
['c', 'SimplerShaper', {'Id':'0'}, [
  ['e', 'Type', 0],
  ['f', 'Amount', 67, 0, 100],
  ['b', 'Structure', false],
]];

/** The Sampler's members, without the root's own attributes. */
const SAMPLER_MEMBERS = SAMPLER[0] === 'c' ? SAMPLER[3] : [];
