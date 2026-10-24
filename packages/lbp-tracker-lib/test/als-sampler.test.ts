import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/chips.ts';
import { readNotes, NOTE_RECORD_SIZE } from '@lbptracker/cwlib/notes.ts';
import { channelVolume, type Sequencer, type Track } from '@lbptracker/cwlib/project.ts';
import { alsProjectFiles, sequencerToAls } from '../src/als.ts';
import { Ids } from '../src/als-xml.ts';
import { liveDialHz, samplerDevice, samplerSampleFile, samplerZones, trackingRoot, type SamplerSample } from '../src/als-sampler.ts';
import { kneeHz } from '../dev/ladder-knee.ts';
import { ladderCoefficients, MoogLadder } from '../src/audio/moog.ts';
import type { RInstrument, SampleSlot } from '@lbptracker/cwlib/rinstrument.ts';

/* ---------------------------------------------------------------- fixtures */

/** A `.smp` as the game ships one: RIFF, 16-bit PCM, its own rate, an optional `smpl` loop. */
function smp(frames: number, rate: number, loop?: [number, number]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
    view.setUint32(4, body.length, true);
    out.set(body, 8);
    chunks.push(out);
  };
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, 1, true); fmt.setUint16(2, 1, true); fmt.setUint32(4, rate, true);
  fmt.setUint32(8, rate * 2, true); fmt.setUint16(12, 2, true); fmt.setUint16(14, 16, true);
  chunk('fmt ', new Uint8Array(fmt.buffer));
  const data = new DataView(new ArrayBuffer(frames * 2));
  for (let i = 0; i < frames; i += 1) data.setInt16(i * 2, (i * 37) % 2000 - 1000, true);
  chunk('data', new Uint8Array(data.buffer));
  if (loop) {
    const s = new DataView(new ArrayBuffer(36 + 24));
    s.setUint32(28, 1, true);
    s.setUint32(36 + 8, loop[0], true);
    s.setUint32(36 + 12, loop[1], true);
    chunk('smpl', new Uint8Array(s.buffer));
  }
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0);
  view.setUint32(4, 4 + body, true);
  out.set([87, 65, 86, 69], 8);
  let at = 12;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const slot = (over: Partial<SampleSlot> = {}): SampleSlot =>
  ({ baseNote: 60, baseBpm: 120, fineTune: 0, pitched: true, fitBpm: false, ...over });

/** An instrument with every `Params` range flat at `x = y = value`, bar those given. */
function instrument(
  slots: SampleSlot[],
  splits: number[],
  params: Record<number, number | { x: number; y: number }> = {},
): RInstrument {
  return {
    slots,
    sampleGuids: slots.map((_, i) => 100 + i),
    splitNotes: [...splits, ...Array(9 - splits.length).fill(0)],
    numStack: 1,
    params: Array.from({ length: 27 }, (_, i) => {
      const p = params[i] ?? 0;
      return typeof p === 'number' ? { x: p, y: p } : p;
    }),
    arpeggio: [],
    arpeggiate: false,
  };
}

const sample = (file: string, frames = 1000, loop?: { start: number; end: number }): SamplerSample =>
  ({ file, frames, loop, wav: new Uint8Array(44 + frames * 2) });

/** A device member's value, found by the dotted path of the tags down to it. */
function valueAt(xml: string, path: string): number {
  let rest = xml;
  for (const part of path.split('.')) {
    const k = rest.search(new RegExp(`<${part}[ >]`));
    assert.ok(k >= 0, `no ${part} in ${path}`);
    rest = rest.slice(k);
  }
  return Number(/<Manual Value="([^"]*)"/.exec(rest)?.[1] ?? /Value="([^"]*)"/.exec(rest)?.[1]);
}

/* ---------------------------------------------------------------- tests */

test('an .smp becomes a WAV with the same frames under a 48 kHz header, and the engine\'s loop', () => {
  const bytes = smp(500, 44100, [100, 399]);
  const s = samplerSampleFile('piano_c4.smp', bytes);
  assert.equal(s.file, 'piano_c4.wav');
  assert.equal(s.frames, 500);
  // ❗ The game never reads the rate: a frame is a frame at 48 kHz.
  const view = new DataView(s.wav.buffer, s.wav.byteOffset);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 1000);
  // The frames verbatim: the `data` chunk of the source, byte for byte.
  const source = bytes.subarray(12 + 8 + 16 + 8, 12 + 8 + 16 + 8 + 1000);
  assert.deepEqual([...s.wav.subarray(44)], [...source]);
  // The loader's region, `[dwStart, dwEnd + 1)`.
  assert.deepEqual(s.loop, { start: 100, end: 400 });
  assert.equal(samplerSampleFile('x.smp', smp(10, 48000)).loop, undefined);
});

test('the zones are the engine\'s walk run backwards, over the raw notes; the track\'s Key is in the pitched roots', () => {
  const inst = instrument([slot({ baseNote: 72 }), slot({ baseNote: 60 }), slot({ baseNote: 48 })], [87, 66, 54]);
  const files = new Map([[100, sample('a.wav')], [101, sample('b.wav')], [102, sample('c.wav')]]);
  const zones = samplerZones(inst, (g) => files.get(g), 0, 120);
  // A bound belongs to the zone above it: 66 is the top zone's, 54 the middle's.
  assert.deepEqual(zones.map((z) => [z.sample.file, z.lo, z.hi, z.root]), [
    ['a.wav', 66, 127, 72], ['b.wav', 54, 65, 60], ['c.wav', 0, 53, 48],
  ]);
  // Key 14 transposes by 2: the zones stay on the raw notes the engine picks
  // the slot from, and each root comes 2 down, so a raw note sounds 2 up.
  const keyed = samplerZones(inst, (g) => files.get(g), 2, 120);
  assert.deepEqual(keyed.map((z) => [z.lo, z.hi, z.root]), [[66, 127, 70], [54, 65, 58], [0, 53, 46]]);
  // An unpitched slot plays at one rate whatever the Key: its zones keep their roots.
  const drum = samplerZones(instrument([slot({ pitched: false }), slot()], [87, 126]), () => sample('k.wav'), 2, 120);
  assert.deepEqual(drum.map((z) => [z.lo, z.hi, z.root]), [[126, 126, 126], [127, 127, 127], [0, 125, 58]]);
});

test('fine tune and fitBpm go into the root and the cents; an unpitched slot is a zone per key', () => {
  const tuned = samplerZones(instrument([slot({ fineTune: 0.3 })], [87]), () => sample('a.wav'), 0, 120)[0];
  assert.deepEqual([tuned.root, Math.round(tuned.detune)], [60, 30]);
  const sharp = samplerZones(instrument([slot({ fineTune: 0.7 })], [87]), () => sample('a.wav'), 0, 120)[0];
  // 0.7 of a semitone up is a root one lower and 30 cents down.
  assert.deepEqual([sharp.root, Math.round(sharp.detune)], [59, -30]);
  // At twice its tempo a synced slot plays an octave up.
  const synced = samplerZones(instrument([slot({ fitBpm: true, baseBpm: 60 })], [87]), () => sample('a.wav'), 0, 120)[0];
  assert.deepEqual([synced.root, Math.round(synced.detune)], [48, 0]);
  const drum = samplerZones(instrument([slot({ pitched: false }), slot()], [87, 126]), () => sample('k.wav'), 0, 120);
  // 126 and 127 play the unpitched slot, each at its own root; the rest is one zone.
  assert.deepEqual(drum.map((z) => [z.lo, z.hi, z.root]), [[126, 126, 126], [127, 127, 127], [0, 125, 60]]);
});

test('the Sampler: 32 voices, no retrigger, the level, the envelopes and the filter from the engine\'s terms', () => {
  const inst = instrument([slot()], [87], {
    3: 0.5, 4: 0.25, 5: 1, 6: 0.75, // cutoff 0.25 of Nyquist, envelope amount 0.75
    11: 0.5, 12: 0.5, 13: 0.5, 14: 1, // attack 1 s, decay 1 s, sustain 0.5, release 4 s
    24: 0.25, // output level 0.25, -12 dB: the engine's factor 2 is the track fader's
  });
  const xml = samplerDevice(new Ids(), inst, () => sample('a.wav', 1000, { start: 10, end: 900 }),
    { modulation: 0, keyShift: 0, trackingRoot: 60, tempo: 120, name: 'saw_wave' });
  const at = (path: string) => valueAt(xml, path);
  assert.match(xml, /<NumVoices Value="14" \/>/);
  assert.match(xml, /<RetriggerMode Value="false" \/>/);
  // The level, and the ladder's passband where the note sustains: envelope B
  // has fallen to 0 there, so the cutoff and the resonance are a quarter each.
  const passband = 1 / (1 + ladderCoefficients(0.25 * 0.25, 0.25 * 0.25).q);
  assert.ok(Math.abs(at('VolumeAndPan.Volume') - 20 * Math.log10(0.25 * passband)) < 1e-6);
  assert.equal(at('VolumeAndPan.Envelope.AttackTime'), 1000);
  // The decay falls 1 → 0.5 at one unit a second; the release from the sustain.
  assert.equal(at('VolumeAndPan.Envelope.DecayTime'), 500);
  assert.equal(at('VolumeAndPan.Envelope.SustainLevel'), 0.5);
  assert.equal(at('VolumeAndPan.Envelope.ReleaseTime'), 2000);
  // Resting at cutoff x (1 - amount), the envelope's full swing as semitones, each
  // end where Live's filter attenuates as the ladder does there (`liveDialHz`).
  assert.ok(Math.abs(at('SimplerFilter.Freq') - liveDialHz(0.25 * 0.25)) < 1e-6);
  assert.ok(Math.abs(at('SimplerFilter.Envelope.Amount') - 12 * Math.log2(liveDialHz(0.25) / liveDialHz(0.0625))) < 1e-6);
  assert.equal(at('SimplerFilter.Res'), 0.25);
  assert.equal(at('SimplerFilter.ModByPitch'), 1);
  // The zone: the loop as the loader reads it, forward, and the project-relative file.
  assert.match(xml, /<SustainLoop>\n<Start Value="10" \/>\n<End Value="900" \/>\n<Mode Value="1" \/>/);
  assert.match(xml, /<RelativePathType Value="3" \/>\n<RelativePath Value="Samples\/Imported\/a.wav" \/>/);
  // Pressure (`MidiCtrl.0`) to Volume (18).
  assert.match(xml, /<MidiCtrl\.0>\n<ModConnections\.0>\n<Amount Value="100" \/>\n<Connection Value="18" \/>/);
});

test('a held filter envelope meets the engine at its peak and its sustain, robot\'s shape', () => {
  // `robot`: cutoff² 0.504, envelope amount 0.98, envelope B holding at 0.58.
  const inst = instrument([slot()], [87], { 3: Math.sqrt(0.504), 6: 0.98, 9: 0.58, 13: 1 });
  const xml = samplerDevice(new Ids(), inst, () => sample('a.wav'), { modulation: 0, keyShift: 0, trackingRoot: 60, tempo: 120, name: 'robot' });
  const rest = valueAt(xml, 'SimplerFilter.Freq');
  const swing = valueAt(xml, 'SimplerFilter.Envelope.Amount');
  const live = (env: number) => rest * 2 ** ((swing * env) / 12);
  // The engine: `cutoff² × (1 + amount × (env − 1))`, as Live's dial (`liveDialHz`).
  const engine = (env: number) => liveDialHz(0.504 * (1 + 0.98 * (env - 1)));
  assert.ok(Math.abs(live(1) / engine(1) - 1) < 1e-6, `peak ${live(1)} against ${engine(1)}`);
  assert.ok(Math.abs(live(0.58) / engine(0.58) - 1) < 1e-6, `sustain ${live(0.58)} against ${engine(0.58)}`);
});

test('the Sampler\'s volume carries the ladder\'s passband, which falls as the resonance rises', () => {
  // `saw_wave`: cutoff² 0.733, resonance 0.76, the amplitude and envelope B both holding at 1.
  const inst = instrument([slot()], [87], { 3: Math.sqrt(0.733), 4: 0.76, 9: 1, 13: 1, 24: 0.294 });
  const xml = samplerDevice(new Ids(), inst, () => sample('a.wav'), { modulation: 0, keyShift: 0, trackingRoot: 60, tempo: 120, name: 'saw_wave' });
  const written = valueAt(xml, 'VolumeAndPan.Volume') - 20 * Math.log10(0.294);
  // What the engine's ladder does to a 110 Hz tone, run: the volume must take the same.
  const ladder = new MoogLadder();
  const c = ladderCoefficients(0.733, 0.76);
  let peak = 0;
  for (let i = 0; i < 48000; i += 1) {
    const y = ladder.process(0.1 * Math.sin((2 * Math.PI * 110 * i) / 48000), c);
    if (i > 24000) peak = Math.max(peak, Math.abs(y));
  }
  const measured = 20 * Math.log10(peak / 0.1);
  assert.ok(measured < -5, `the ladder takes ${measured} dB`);
  assert.ok(Math.abs(written - measured) < 0.1, `written ${written} dB against the ladder's ${measured} dB`);
});

test('past Live\'s 72 semitones the filter envelope keeps its peak, and the rest rises', () => {
  // Envelope amount 1, as concertina has it: the engine goes from 0 to the whole cutoff.
  const xml = samplerDevice(new Ids(), instrument([slot()], [87], { 3: 0.5, 6: 1 }), () => sample('a.wav'),
    { modulation: 0, keyShift: 0, trackingRoot: 60, tempo: 120, name: 'concertina' });
  assert.equal(valueAt(xml, 'SimplerFilter.Envelope.Amount'), 72);
  // The peak is 0.25 of Nyquist, as the engine's; the rest is 72 semitones under it.
  assert.ok(Math.abs(valueAt(xml, 'SimplerFilter.Freq') - liveDialHz(0.25) / 64) < 1e-6);
});

test('with instruments the set gets a Sampler per track, its samples and the project around them', () => {
  const bytes = new Uint8Array(3 * NOTE_RECORD_SIZE);
  // One flat note, and one whose volume moves -- which hands its volume to the pressure.
  bytes.set([0, 60 | 0x80, 96, 0], 0);
  bytes.set([4, 62, 30, 15], 4);
  bytes.set([8, 62 | 0x80, 90, 15], 8);
  const grouped = readNotes(bytes);
  const track: Track = {
    guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: grouped.notes, records: bytes, trailingRecords: 0,
  };
  const seq: Sequencer = {
    uid: 1, name: 'Song (1)', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0.5,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [track], lengthSteps: 9,
  };
  const inst = instrument([slot()], [87]);
  const instruments = new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'tone.smp', bytes: smp(64, 48000) }]]) }]]);
  const plain = sequencerToAls(seq);
  assert.equal(plain.samples.length, 0);
  assert.doesNotMatch(plain.xml, /<MultiSampler/);

  const r = sequencerToAls(seq, { instruments });
  assert.equal(r.instrumentTracks, 1);
  assert.deepEqual(r.samples.map((s) => s.file), ['tone.wav']);
  assert.equal((r.xml.match(/<MultiSampler Id="0">/g) ?? []).length, 1);
  // Half the notes are at modulation 0 and half at 1: the tie goes to the first seen.
  assert.equal(r.offModulation, 1);
  // Every note's level rides on the pressure, the flat note's as one point: a
  // note with none is silent through the Pressure row at 100.
  const velocities = [...r.xml.matchAll(/<MidiNoteEvent [^>]* Velocity="(\d+)" VelocityDeviation/g)].map((m) => Number(m[1]));
  assert.deepEqual(velocities, [127, 127]);
  const pressures = [...r.xml.matchAll(/<PerNoteEventList [^>]*CC="-1">\n<Events>\n([\s\S]*?)<\/Events>/g)]
    .map((m) => [...m[1].matchAll(/TimeOffset="([^"]+)" Value="([^"]+)"/g)].map((p) => [Number(p[1]), Number(p[2])]));
  assert.deepEqual(pressures, [[[0, 96]], [[0, 30], [1, 90]]]);
  // Without the Sampler only the ramp is on the pressure, and the flat note's level is its velocity.
  assert.equal((plain.xml.match(/CC="-1"/g) ?? []).length, 1);
  assert.match(plain.xml, /Velocity="96"/);

  const files = alsProjectFiles(seq.name, new Uint8Array([1]), r.samples).map((f) => f.name);
  assert.deepEqual(files, [
    'Song _1_ Project/Song _1_.als',
    'Song _1_ Project/Ableton Project Info/',
    'Song _1_ Project/Samples/Imported/tone.wav',
  ]);
});

test('with a Sampler, Live plays each channel at the renderer\'s gain: the instrument\'s 2 counted once', () => {
  const bytes = new Uint8Array(NOTE_RECORD_SIZE);
  bytes.set([0, 60 | 0x80, 127, 0], 0);
  const track: Track = {
    guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 0.8, pan: 0.25, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: readNotes(bytes).notes, records: bytes, trailingRecords: 0,
  };
  const seq: Sequencer = {
    uid: 1, name: 'Song', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0.5,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [0.5, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [track], lengthSteps: 4,
  };
  const inst = instrument([slot()], [87], { 24: 0.25 });
  const { xml } = sequencerToAls(seq, {
    instruments: new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'tone.smp', bytes: smp(64, 48000) }]]) }]]),
  });
  // The track's own mixer comes first; the Sampler's `Volume` is inside `VolumeAndPan`.
  const mixer = /<Mixer>[\s\S]*?<\/Mixer>/.exec(xml)?.[0] ?? '';
  const fader = (name: string) => Number(new RegExp(`<${name}>\\n<LomId Value="0" />\\n<Manual Value="([^"]*)"`).exec(mixer)?.[1]);
  const theta = ((fader('Pan') + 1) * Math.PI) / 4;
  const sampler = 10 ** (valueAt(xml, 'VolumeAndPan.Volume') / 20);
  const [left, right] = [Math.cos(theta), Math.sin(theta)].map((g) => Math.SQRT2 * g * fader('Volume') * sampler);
  // The renderer: level x channel x 2 x `Params[24]`, then `1 - p` and `p`.
  const gain = 0.8 * channelVolume(seq, track) * 2 * 0.25;
  assert.ok(Math.abs(left - 0.75 * gain) < 1e-9, `left ${left} against ${0.75 * gain}`);
  assert.ok(Math.abs(right - 0.25 * gain) < 1e-9, `right ${right} against ${0.25 * gain}`);
  // ❗ And nothing else on the way: Vel → Vol at 0, or Live adds 22.8 dB to a
  // velocity-127 note (measured on Live's meters, 2026-10-04), and every note
  // goes in at 127, its level on the pressure, which Live applies linearly.
  assert.equal(valueAt(xml, 'VolumeAndPan.VolumeVelScale'), 0);
  assert.match(xml, /Velocity="127"/);
});

test('with a Sampler a note is the raw one; another part\'s Key and the scale ride on per-note pitch', () => {
  // One row, one instrument: a pitched zone from 40 up, an unpitched one below.
  const inst = instrument([slot(), slot({ pitched: false })], [87, 40]);
  const placement = (gridX: number, key: number, scale: number, pitches: number[]): Track => {
    const bytes = new Uint8Array(pitches.length * NOTE_RECORD_SIZE);
    pitches.forEach((p, i) => bytes.set([i * 4, p | 0x80, 96, 0], i * NOTE_RECORD_SIZE));
    return {
      guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX, gridY: 0, stepOffset: gridX * 16,
      level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key, scale,
      notes: readNotes(bytes).notes, records: bytes, trailingRecords: 0,
    };
  };
  const seq: Sequencer = {
    uid: 1, name: 'Keys', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 1,
    tracks: [
      placement(0, 15, 0, [48, 48, 48]), // keyed D#, +3: the track's commonest
      placement(2, 14, 0, [48, 30]), // keyed D, +2; 30 is on the unpitched slot
      placement(4, 15, 1, [49]), // major: the engine plays 49 as 48, then +3
    ],
    lengthSteps: 80,
  };
  const { xml, tracks } = sequencerToAls(seq, {
    instruments: new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'a.smp', bytes: smp(64, 48000) }], [101, { name: 'k.smp', bytes: smp(64, 48000) }]]) }]]),
  });
  assert.equal(tracks, 1);
  const notes = [...xml.matchAll(/<MidiClip [\s\S]*?<\/MidiClip>/g)].flatMap((clip) => {
    const bend = new Map([...clip[0].matchAll(/<PerNoteEventList Id="\d+" NoteId="(\d+)" CC="-2">[\s\S]*?Value="([^"]*)"/g)]
      .map((m) => [m[1], Number(m[2]) / (8192 / 48)]));
    return [...clip[0].matchAll(/<KeyTrack [\s\S]*?<\/KeyTrack>/g)].flatMap((kt) => {
      const key = Number(/<MidiKey Value="(\d+)"/.exec(kt[0])![1]);
      return [...kt[0].matchAll(/NoteId="(\d+)"/g)].map((m) => [key, Math.round((bend.get(m[1]) ?? 0) * 1000) / 1000]);
    });
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // The keys are the raw notes, as the tracker's roll shows them. The +3 is in
  // the zone's root; the D part is 1 under it, the scaled 49 one under 49, and
  // the note on the unpitched slot has no pitch at all.
  assert.deepEqual(notes, [[30, 0], [48, -1], [48, 0], [48, 0], [48, 0], [49, -1]]);
  assert.match(xml, /<RootKey Value="57" \/>/);
});

test('the filter dial makes up for Live tracking from key 60 where the engine tracks from the slot\'s root', () => {
  // ghost's shape: rooted at 48, cutoff 0.11 (290 Hz), tracking 1, on a track keyed +3.
  const ghost = instrument([slot({ baseNote: 48 })], [87], { 3: 0.11, 5: 1, 13: 1, 24: 0.5 });
  const freq = (keyShift: number, root: number) => valueAt(samplerDevice(new Ids(), ghost, () => sample('g.wav'),
    { modulation: 0, keyShift, trackingRoot: root, tempo: 120, name: 'ghost' }), 'SimplerFilter.Freq');
  const resting = liveDialHz(0.11 ** 2);
  // The engine plays raw 55 at rate 2^((55 + 3 - 48)/12): its cutoff is 290 Hz times that.
  // Live, from key 60 an octave per octave: the dial times 2^((55 - 60)/12). The dial
  // carries the 15 semitones between them.
  assert.ok(Math.abs(freq(3, 48) - resting * 2 ** (15 / 12)) < 1e-6);
  // At key 55 the engine's cutoff is the ladder at 290 Hz x 2^(10/12); Live, tracking
  // the dial from its root's knee, lands within a semitone of the knee there.
  const engine = liveDialHz(0.11 ** 2 * 2 ** ((55 + 3 - 48) / 12));
  assert.ok(Math.abs(12 * Math.log2((freq(3, 48) * 2 ** ((55 - 60) / 12)) / engine)) < 1);
  // No tracking, no correction.
  const flat = instrument([slot({ baseNote: 48 })], [87], { 3: 0.11, 5: 0, 13: 1, 24: 0.5 });
  assert.ok(Math.abs(valueAt(samplerDevice(new Ids(), flat, () => sample('g.wav'),
    { modulation: 0, keyShift: 3, trackingRoot: 48, tempo: 120, name: 'flat' }), 'SimplerFilter.Freq') - resting) < 1e-6);
  // The root the engine tracks from is the pitched slot the notes play most.
  const split = instrument([slot({ baseNote: 72 }), slot({ baseNote: 48 })], [87, 60]);
  assert.equal(trackingRoot(split, [40, 50, 70]), 48);
  assert.equal(trackingRoot(split, [61, 70, 50]), 72);
});

test('the level the modulation gives rides on each note\'s pressure, under a Sampler at the loudest', () => {
  // Params[24] doubles from modulation 0 to 1; no filter, so the level is all there is.
  const inst = instrument([slot()], [87], { 3: 1, 13: 1, 24: { x: 0.1, y: 0.2 } });
  const bytes = new Uint8Array(2 * NOTE_RECORD_SIZE);
  // One note at volume 96 whose modulation swells 0 -> 15 over 16 steps.
  bytes.set([0, 60, 96, 0], 0);
  bytes.set([16, 60 | 0x80, 96, 15], NOTE_RECORD_SIZE);
  const track: Track = {
    guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: readNotes(bytes).notes, records: bytes, trailingRecords: 0,
  };
  const seq: Sequencer = {
    uid: 1, name: 'Swell', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 1,
    tracks: [track], lengthSteps: 17,
  };
  const { xml } = sequencerToAls(seq, {
    instruments: new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'a.smp', bytes: smp(64, 48000) }]]) }]]),
  });
  assert.ok(Math.abs(valueAt(xml, 'VolumeAndPan.Volume') - 20 * Math.log10(0.2)) < 1e-6);
  const pressure = /<PerNoteEventList Id="\d+" NoteId="1" CC="-1">[\s\S]*?<\/PerNoteEventList>/.exec(xml)![0];
  const points = [...pressure.matchAll(/TimeOffset="([^"]*)" Value="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // Half the Sampler's level at the start, all of it at the end: 48 rising to 96,
  // with a moment at every sixteenth of the modulation between (`courseOf`).
  assert.equal(points.length, 16);
  assert.deepEqual(points[0], [0, 48]);
  assert.deepEqual(points[15], [4, 96]);
  // A third of the way: 5/15 of the modulation, Params[24] at 0.1333 of the 0.2.
  assert.ok(Math.abs(points[5][0] - 4 / 3) < 1e-9 && Math.abs(points[5][1] - 96 * (0.1 + 0.1 / 3) / 0.2) < 1e-9);
});

test('the cutoff the modulation gives rides on each note\'s slide, routed to the filter from the lowest dial', () => {
  // No filter at modulation 0 (cutoff 1), a quarter of Nyquist at 1 (0.5²): no envelope, no tracking.
  const inst = instrument([slot()], [87], { 3: { x: 1, y: 0.5 }, 13: 1, 24: 0.5 });
  const bytes = new Uint8Array(2 * NOTE_RECORD_SIZE);
  bytes.set([0, 60, 96, 0], 0);
  bytes.set([16, 60 | 0x80, 96, 15], NOTE_RECORD_SIZE);
  const track: Track = {
    guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: readNotes(bytes).notes, records: bytes, trailingRecords: 0,
  };
  const seq: Sequencer = {
    uid: 1, name: 'Sweep', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 1,
    tracks: [track], lengthSteps: 17,
  };
  const { xml, clampedSlide } = sequencerToAls(seq, {
    instruments: new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'a.smp', bytes: smp(64, 48000) }]]) }]]),
  });
  // The filter on, though the commonest modulation (0) has none, the dial at the lowest cutoff.
  assert.match(xml, /<Filter>\n<IsOn>\n<LomId Value="0" \/>\n<Manual Value="true" \/>/);
  assert.ok(Math.abs(valueAt(xml, 'SimplerFilter.Freq') - liveDialHz(0.25)) < 1e-6);
  // The slide row to Filter Freq at 100.
  assert.match(xml, /<MidiCtrl\.4>\n<ModConnections\.0>\n<Amount Value="100" \/>\n<Connection Value="12" \/>/);
  // The slide: all the way open at the start (Live's 22 kHz top), nothing at the end.
  const list = /<PerNoteEventList Id="\d+" NoteId="1" CC="74">[\s\S]*?<\/PerNoteEventList>/.exec(xml)![0];
  const points = [...list.matchAll(/TimeOffset="([^"]*)" Value="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(points.length, 16);
  assert.ok(Math.abs(points[0][1] - (127 * 12 * Math.log2(22000 / liveDialHz(0.25))) / 72) < 1e-6);
  assert.equal(points[15][1], 0);
  // Two thirds through the modulation the cutoff is (1 - 0.5 x 2/3)² of Nyquist, on the curve, not the straight line.
  const twoThirds = points[10];
  const cutoff = liveDialHz((1 - 0.5 * (10 / 15)) ** 2);
  assert.ok(Math.abs(twoThirds[1] - (127 * 12 * Math.log2(cutoff / liveDialHz(0.25))) / 72) < 1e-6);
  assert.equal(clampedSlide, 0);
});

test('Live\'s dial for an engine cutoff is where the ladder attenuates as Live does at its dial, -8 dB', () => {
  // The table is `dev/ladder-knee.ts`'s output; re-derived here off the grid, from the engine's own ladder.
  for (const nominal of [500, 3000, 9000]) {
    const derived = kneeHz(nominal / 24000);
    assert.ok(Math.abs(liveDialHz(nominal / 24000) / derived - 1) < 0.01, `${nominal} Hz: ${liveDialHz(nominal / 24000)} against ${derived}`);
  }
  // Under its nominal value low down, over it high up.
  assert.ok(liveDialHz(500 / 24000) < 500 && liveDialHz(9000 / 24000) > 9000 * 2 ** (4 / 12));
});
