import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/sequencer/chips.ts';
import { readNotes, NOTE_RECORD_SIZE } from '@lbptracker/cwlib/sequencer/notes.ts';
import { CHANNEL_HEADROOM, type Sequencer, type Track } from '@lbptracker/cwlib/sequencer/project.ts';
import { ALS_BEND_RANGE, LIVE_PALETTE, liveColour, sequencerToAls } from '../src/als.ts';
import { FOLD_GAIN } from '../src/audio/effects.ts';
import type { RInstrument } from '@lbptracker/cwlib/resources/rinstrument.ts';
import { GLUE, LIMITER, MASTER_DEFAULTS, glueLevels } from '../src/audio/master.ts';

/* ---------------------------------------------------------------- fixtures */

interface Point {
  step: number;
  subStep?: 0 | 1 | 2;
  pitch: number;
  volume?: number;
  modulation?: number;
}

/** A track's note bytes as the game stores them, read back -- as `midi.test.ts` builds them. */
function makeTrack(notes: Point[][], over: Partial<Track> = {}): Track {
  const flat = notes.flat();
  const bytes = new Uint8Array(flat.length * NOTE_RECORD_SIZE);
  let at = 0;
  for (const note of notes) {
    note.forEach((point, index) => {
      const sub = point.subStep ?? 0;
      bytes[at] = (point.step & 0x7f) | (sub > 0 ? 0x80 : 0);
      bytes[at + 1] = (point.pitch & 0x7f) | (index === note.length - 1 ? 0x80 : 0);
      bytes[at + 2] = point.volume ?? 0x60;
      bytes[at + 3] = Math.round((point.modulation ?? 0) * 15) | (sub === 2 ? 0x40 : 0);
      at += NOTE_RECORD_SIZE;
    });
  }
  const grouped = readNotes(bytes);
  return {
    guid: 1234, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: grouped.notes, records: bytes, trailingRecords: grouped.trailing.length,
    ...over,
  };
}

function makeSequencer(tracks: Track[], over: Partial<Sequencer> = {}): Sequencer {
  return {
    uid: 7, name: 'fixture', author: '', tempo: 120, swing: 0,
    echoFeedback: 0.54, echoTime: 1, echoMix: 0.6, reverb: 5,
    loop: true, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1],
    boardRows: 0, tracks, lengthSteps: 0,
    ...over,
  };
}

/* ---------------------------------------------------------------- reading the set */

const blocks = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0]);
const value = (xml: string, tag: string) => new RegExp(`<${tag} Value="([^"]*)"`).exec(xml)?.[1];
const trackName = (track: string) => value(track, 'UserName');
/** A mixer dial's value: the `Manual` right after its opening tag. */
const dial = (track: string, name: string) =>
  Number(new RegExp(`<${name}>\\n<LomId Value="0" />\\n<Manual Value="([^"]*)"`).exec(track)?.[1]);

function clipsOf(track: string) {
  return blocks(track, 'MidiClip').map((clip) => ({
    time: Number(/<MidiClip Id="\d+" Time="([^"]*)"/.exec(clip)?.[1]),
    end: Number(value(clip, 'CurrentEnd')),
    name: value(clip, 'Name'),
    notes: [...clip.matchAll(/<MidiNoteEvent Time="([^"]*)" Duration="([^"]*)" Velocity="(\d+)"[^>]*NoteId="(\d+)"/g)]
      .map((m) => ({ time: Number(m[1]), duration: Number(m[2]), velocity: Number(m[3]), id: Number(m[4]) })),
    keys: [...clip.matchAll(/<MidiKey Value="(\d+)"/g)].map((m) => Number(m[1])),
    lists: blocks(clip, 'PerNoteEventList').map((list) => ({
      note: Number(/NoteId="(\d+)"/.exec(list)?.[1]),
      cc: Number(/CC="(-?\d+)"/.exec(list)?.[1]),
      points: [...list.matchAll(/TimeOffset="([^"]*)" Value="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2])]),
    })),
  }));
}

/* ---------------------------------------------------------------- tests */

test('the set is well-formed and its ids are one space, all below NextPointeeId, with the master bus or without', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }, { step: 4, pitch: 72 }]]),
    makeTrack([[{ step: 2, pitch: 40 }]], { gridY: 3 }),
  ]);
  for (const masterBus of [undefined, MASTER_DEFAULTS]) wellFormed(sequencerToAls(seq, { masterBus }).xml);
});

function wellFormed(xml: string) {
  const stack: string[] = [];
  for (const [, close, name, self] of xml.matchAll(/<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (!close) stack.push(name);
    else assert.equal(stack.pop(), name);
  }
  assert.deepEqual(stack, []);
  const ids = [...xml.matchAll(/<(?:AutomationTarget|ModulationTarget|Pointee|ControllerTargets\.\d+|\w+ModulationTarget) Id="(\d+)"/g)]
    .map((m) => Number(m[1]));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Number(value(xml, 'NextPointeeId')) > Math.max(...ids));
  // ❗ The schema Live 11.3 writes, which Live 12 upgrades; see the module header.
  assert.match(xml, /MinorVersion="11\.0_11300"/);
}

test('without mergeRows a part is a track: named as the MIDI export names it, in board order, beside two returns', () => {
  const { xml, tracks, parts } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 2, guid: 5 }),
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 0, guid: 5 }),
    // Same row and instrument, a different pan: another part, told apart by `#2`.
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 0, guid: 5, pan: 0.3, gridX: 1, stepOffset: 16 }),
  ]), { instrumentName: (guid) => (guid === 5 ? 'saw_wave' : undefined), mergeRows: false });
  assert.equal(tracks, 3);
  assert.equal(parts, 3);
  assert.deepEqual(blocks(xml, 'MidiTrack').map(trackName), [
    'row 0 - saw_wave', 'row 0 - saw_wave #2', 'row 2 - saw_wave',
  ]);
  assert.deepEqual(blocks(xml, 'ReturnTrack').map(trackName), ['Reverb', 'Echo']);
  assert.equal(Number(value(blocks(xml, 'MasterTrack')[0].split('<Tempo>')[1], 'Manual')), 120);
});

/** A track's envelopes: which dial each moves, and its events. */
function envelopesOf(xml: string, track: string) {
  const dialOf = (id: string) => {
    const at = track.indexOf(`<AutomationTarget Id="${id}">`);
    return /<(Volume|Pan|Send)>/g.exec(track.slice(track.lastIndexOf('<', track.lastIndexOf('<LomId', at) - 1)))?.[1];
  };
  return blocks(track, 'AutomationEnvelope').map((env) => ({
    dial: dialOf(/<PointeeId Value="(\d+)"/.exec(env)![1]),
    events: [...env.matchAll(/<FloatEvent Id="\d+" Time="([^"]*)" Value="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2])]),
  }));
}

test('mergeRows, on by default: one track per row and instrument, the mixer stepping where each part takes over', () => {
  const { xml, tracks, parts, switches } = sequencerToAls(makeSequencer([
    // A at cell 0, B at cell 2, A again at cell 4: two parts, interleaved.
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 0, guid: 5, pan: 0.5, gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 1, pitch: 60 }]], { gridY: 0, guid: 5, pan: 0.25, gridX: 2, stepOffset: 32 }),
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 0, guid: 5, pan: 0.5, gridX: 4, stepOffset: 64 }),
  ]), { instrumentName: () => 'saw_wave' });
  assert.equal(parts, 2);
  assert.equal(tracks, 1);
  // ❗ Back to A at cell 4: a value set once per part would leave it on B's pan.
  assert.equal(switches, 2);
  const [track] = blocks(xml, 'MidiTrack');
  assert.equal(trackName(track), 'row 0 - saw_wave');
  assert.equal(dial(track, 'Pan'), 0);
  const envelopes = envelopesOf(xml, track);
  // Only the dial that differs is automated; a step is two events at one time.
  // The pan moves the fader too now, since Live's law is not the engine's.
  assert.deepEqual(envelopes.map((e) => e.dial), ['Volume', 'Pan']);
  const pan = envelopes[1].events;
  assert.deepEqual(pan.map(([t]) => t), [-63072000, 8.25, 8.25, 16, 16]);
  const b = (4 / Math.PI) * Math.atan2(0.25, 0.75) - 1;
  const values = pan.map(([, v]) => Math.round(v * 1e9) / 1e9);
  assert.deepEqual(values, [0, 0, b, b, 0].map((v) => Math.round(v * 1e9) / 1e9));
});

test('parts of one row that sound together stay on tracks of their own', () => {
  const { tracks, switches } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }, { step: 20, pitch: 60 }]], { gridY: 0, guid: 5, gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 64 }]], { gridY: 0, guid: 5, pan: 0.2, gridX: 1, stepOffset: 16 }),
  ]));
  assert.equal(tracks, 2);
  assert.equal(switches, 0);
});

test('a placement is a clip at its own cell, and its notes are relative to it', () => {
  const { xml, clips, placements } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 2, pitch: 60 }, { step: 5, pitch: 60 }]], { gridX: 3, stepOffset: 48 }),
  ]));
  assert.equal(clips, 1);
  assert.equal(placements, 1);
  const [clip] = clipsOf(blocks(xml, 'MidiTrack')[0]);
  // 48 steps is 12 beats; the note stops at step 6, and the clip goes on to the
  // end of the chip's grid, four bars of 8 steps.
  assert.equal(clip.time, 12);
  assert.equal(clip.end, 12 + 32 / 4);
  assert.equal(clip.name, 'cell 3');
  assert.deepEqual(clip.notes.map((n) => [n.time, n.duration]), [[0.5, 1]]);
  assert.deepEqual(clip.keys, [60]);
});

test('a clip is as long as its chip: the grid the notes need, or the one the editor drew', () => {
  const tracks = [
    // Notes to step 40: a grid of 48, six bars.
    makeTrack([[{ step: 0, pitch: 60 }, { step: 40, pitch: 60 }]], { gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridX: 8, stepOffset: 128 }),
  ];
  const ends = (xml: string) => clipsOf(blocks(xml, 'MidiTrack')[0]).map((c) => [c.time, c.end]);
  assert.deepEqual(ends(sequencerToAls(makeSequencer(tracks)).xml), [[0, 12], [32, 40]]);
  // A chip drawn longer than its notes: the clip follows the drawing.
  assert.deepEqual(ends(sequencerToAls(makeSequencer(tracks), { clipSteps: [48, 96] }).xml), [[0, 12], [32, 56]]);
});

test('a chip that covers the next one on its track with silence is cut where the next begins', () => {
  const part = { guid: 9, gridY: 1 };
  const { xml, clips } = sequencerToAls(makeSequencer([
    // A 64-step chip whose notes stop at step 4, and the next chip of its row at cell 2.
    makeTrack([[{ step: 0, pitch: 50 }, { step: 3, pitch: 50 }]], { ...part, gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 52 }]], { ...part, gridX: 2, stepOffset: 32 }),
  ]), { clipSteps: [64, 32] });
  assert.equal(clips, 2);
  const found = clipsOf(blocks(xml, 'MidiTrack')[0]);
  assert.deepEqual(found.map((c) => [c.name, c.time, c.end]), [['cell 0', 0, 8], ['cell 2', 8, 16]]);
});

test('placements of one part whose windows overlap become one clip, and no note is lost', () => {
  const part = { guid: 9, gridY: 1 };
  const { xml, clips, notes } = sequencerToAls(makeSequencer([
    // Reaches step 20 from cell 0, into cell 1's window.
    makeTrack([[{ step: 0, pitch: 50 }, { step: 20, pitch: 50 }]], { ...part, gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 52 }]], { ...part, gridX: 1, stepOffset: 16 }),
    makeTrack([[{ step: 0, pitch: 54 }]], { ...part, gridX: 4, stepOffset: 64 }),
  ]));
  assert.equal(clips, 2);
  assert.equal(notes, 3);
  const found = clipsOf(blocks(xml, 'MidiTrack')[0]);
  assert.deepEqual(found.map((c) => c.name), ['cells 0-1', 'cell 4']);
  // The union runs to the end of cell 1's chip, 16 + 32 steps.
  assert.deepEqual(found.map((c) => [c.time, c.end]), [[0, 12], [16, 24]]);
  assert.deepEqual(found[0].notes.map((n) => n.time).sort((a, b) => a - b), [0, 4]);
});

test('a glide is its control points, as per-note pitch at 8192/48 a semitone, after Key', () => {
  const { xml, glides } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }, { step: 4, subStep: 1, pitch: 72 }, { step: 8, pitch: 67 }]], { key: 14 }),
  ]));
  assert.equal(glides, 1);
  const [clip] = clipsOf(blocks(xml, 'MidiTrack')[0]);
  // Key 14 is D: everything two semitones up, the bend relative to the note.
  assert.deepEqual(clip.keys, [62]);
  const pitch = clip.lists.find((l) => l.cc === -2);
  assert.ok(pitch);
  const unit = 8192 / ALS_BEND_RANGE;
  assert.deepEqual(pitch.points.map(([t, v]) => [Math.round(t * 1e6) / 1e6, Math.round(v * 1e6) / 1e6]), [
    [0, 0],
    [Math.round(((4 + 1 / 3) / 4) * 1e6) / 1e6, Math.round(12 * unit * 1e6) / 1e6],
    [2, Math.round(7 * unit * 1e6) / 1e6],
  ]);
});

test('a flat note carries no per-note lists; a glide past 48 semitones is clamped and counted', () => {
  const flat = sequencerToAls(makeSequencer([makeTrack([[{ step: 0, pitch: 60 }, { step: 3, pitch: 60 }]])]));
  assert.deepEqual(clipsOf(blocks(flat.xml, 'MidiTrack')[0])[0].lists, []);

  const wide = sequencerToAls(makeSequencer([makeTrack([[{ step: 0, pitch: 10 }, { step: 4, pitch: 72 }]])]));
  assert.equal(wide.clampedBend, 1);
  const list = clipsOf(blocks(wide.xml, 'MidiTrack')[0])[0].lists.find((l) => l.cc === -2);
  assert.equal(list?.points[1][1], 8192);
});

test('a note that opens at volume 0 keeps it on the pressure, since Live has no velocity 0', () => {
  const { xml } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60, volume: 0 }, { step: 4, pitch: 60, volume: 100 }]]),
  ]));
  const [clip] = clipsOf(blocks(xml, 'MidiTrack')[0]);
  assert.equal(clip.notes[0].velocity, 1);
  assert.deepEqual(clip.lists.find((l) => l.cc === -1)?.points, [[0, 0], [1, 100]]);
});

test('the slide is on every note of a part whose modulation ever moves, and on none otherwise', () => {
  const { xml } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }], [{ step: 4, pitch: 62, modulation: 1 }]]),
  ]));
  const [clip] = clipsOf(blocks(xml, 'MidiTrack')[0]);
  const slides = clip.lists.filter((l) => l.cc === 74);
  assert.equal(slides.length, 2);
  assert.deepEqual(slides.map((l) => l.points[0][1]).sort((a, b) => a - b), [0, 127]);
});

/** What Live puts on each channel for a track's volume and pan: constant power, unity at the centre. */
const liveGains = (volume: number, pan: number) => {
  const theta = ((pan + 1) * Math.PI) / 4;
  return [Math.SQRT2 * Math.cos(theta) * volume, Math.SQRT2 * Math.sin(theta) * volume];
};

test('the mixer: Live plays each channel at the engine\'s linear gain, and both sends', () => {
  const { xml } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { level: 0.8, pan: 0.25, reverbSend: 0.4, echoSend: 0.2 }),
  ], { volumes: [0.5, 1, 1, 1, 1, 1] }));
  const track = blocks(xml, 'MidiTrack')[0];
  // The engine: `2(1 - p)` and `2p` times level and channel -- 1.5 : 0.5 of it here.
  const gain = 0.8 * CHANNEL_HEADROOM * 0.5;
  const [left, right] = liveGains(dial(track, 'Volume'), dial(track, 'Pan'));
  assert.ok(Math.abs(left - 2 * 0.75 * gain) < 1e-9, `left ${left}`);
  assert.ok(Math.abs(right - 2 * 0.25 * gain) < 1e-9, `right ${right}`);
  // The reverb send is the placement's; the echo send is the engine's, and an
  // instrument nobody knows sends nothing of its own, so 0.2 mutes it.
  const sends = blocks(track, 'TrackSendHolder').map((s) => Number(value(s, 'Manual')));
  assert.equal(sends[0], 0.4);
  assert.ok(sends[1] < 0.001, `echo send ${sends[1]}`);
});

test('the echo send is the engine\'s: the instrument\'s own Params[25], bent by the placement', () => {
  const params = (send: { x: number; y: number }) =>
    ({ params: Array.from({ length: 27 }, (_, i) => (i === 25 ? send : { x: 0, y: 0 })) }) as unknown as RInstrument;
  const echoOf = (echoSend: number, settings?: Map<number, RInstrument>, modulation = 0) => {
    const { xml } = sequencerToAls(
      makeSequencer([makeTrack([[{ step: 0, pitch: 60, modulation }], [{ step: 4, pitch: 62, modulation }]], { echoSend })]),
      { instrumentSettings: settings },
    );
    return Number(value(blocks(blocks(xml, 'MidiTrack')[0], 'TrackSendHolder')[1], 'Manual'));
  };
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} against ${b}`);
  const own = new Map([[1234, params({ x: 0.2, y: 0.2 })]]);
  // 0.5 leaves the instrument's own send alone, 0 mutes it, 1 forces unity...
  near(echoOf(0.5, own), 0.2);
  assert.ok(echoOf(0, own) < 0.001);
  near(echoOf(1, own), 1);
  // ...and between, `v + o*v` under 0.5 and `v + o*(1 - v)` over it, o = 2*echoSend - 1.
  near(echoOf(0.2, own), 0.2 - 0.6 * 0.2);
  near(echoOf(0.75, own), 0.2 + 0.5 * 0.8);
  // An instrument with no send of its own echoes only over 0.5 -- the field
  // written as the send put 0.4 into the echo here, where the game puts none.
  const none = new Map([[1234, params({ x: 0, y: 0 })]]);
  assert.ok(echoOf(0.4, none) < 0.001);
  near(echoOf(0.7, none), 0.4);
  // The send is read at the modulation the notes open at.
  near(echoOf(0.5, new Map([[1234, params({ x: 0, y: 0.3 })]]), 1), 0.3);
});

test('baking the swing moves an odd step and leaves an even one', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }], [{ step: 1, pitch: 62 }]])], { swing: 0.5 });
  const straight = clipsOf(blocks(sequencerToAls(seq).xml, 'MidiTrack')[0])[0].notes.map((n) => n.time).sort();
  const swung = clipsOf(blocks(sequencerToAls(seq, { bakeSwing: true }).xml, 'MidiTrack')[0])[0]
    .notes.map((n) => n.time).sort();
  assert.deepEqual(straight, [0, 0.25]);
  assert.equal(swung[0], 0);
  assert.ok(swung[1] > 0.25);
});

test('unbaked, the swing is a groove in the pool that every clip follows; baked or absent, there is none', () => {
  const tracks = [
    makeTrack([[{ step: 0, pitch: 60 }], [{ step: 1, pitch: 62 }]]),
    makeTrack([[{ step: 3, pitch: 40 }]], { gridY: 2, gridX: 1, stepOffset: 16 }),
  ];
  const grooveIds = (xml: string) =>
    blocks(xml, 'MidiTrack').flatMap((t) => [...t.matchAll(/<GrooveId Value="(-?\d+)"/g)].map((m) => Number(m[1])));
  const pool = (xml: string) => blocks(xml, 'GroovePool')[0];

  const xml = sequencerToAls(makeSequencer(tracks, { swing: 0.5 })).xml;
  const grooves = blocks(pool(xml), 'Groove');
  assert.equal(grooves.length, 1);
  const groove = grooves[0];
  assert.match(groove, /^<Groove Id="0">/);
  assert.equal(value(groove, 'Name'), 'LBP swing 50');
  // Base 1/16 (index 3), Timing 100 and nothing else, as Live's own swing grooves.
  assert.equal(value(groove.split('</Clip>')[1], 'Grid'), '3');
  assert.equal(value(groove, 'TimingAmount'), '100');
  for (const amount of ['QuantizationAmount', 'RandomAmount']) assert.equal(value(groove, amount), '0');
  // One bar of sixteenths: an even one on the grid, an odd one swing/2 of a step late.
  const times = clipsOf(groove)[0].notes.map((n) => n.time).sort((a, b) => a - b);
  assert.equal(times.length, 16);
  assert.equal(times[0], 0);
  assert.equal(times[1], (1 + 0.25) / 4);
  assert.equal(times[2], 0.5);
  assert.equal(times[15], (15 + 0.25) / 4);
  // The groove's own clip follows nothing; every clip on a track follows it.
  assert.equal(value(groove, 'GrooveId'), '-1');
  assert.deepEqual(grooveIds(xml), [0, 0]);
  // And the notes stay on the grid.
  assert.deepEqual(clipsOf(blocks(xml, 'MidiTrack')[0])[0].notes.map((n) => n.time).sort(), [0, 0.25]);

  for (const empty of [
    sequencerToAls(makeSequencer(tracks, { swing: 0.5 }), { bakeSwing: true }).xml,
    sequencerToAls(makeSequencer(tracks)).xml,
  ]) {
    assert.match(pool(empty), /<Grooves \/>/);
    assert.deepEqual(grooveIds(empty), [-1, -1]);
  }
});

test('two notes of one key overlapping on a clip are both written, and counted', () => {
  const { xml, overlapping } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }, { step: 1, pitch: 60 }], [{ step: 1, pitch: 60 }]]),
  ]));
  assert.equal(overlapping, 1);
  // Live keeps both (measured), so both go in, each at its own length.
  const [clip] = clipsOf(blocks(xml, 'MidiTrack')[0]);
  assert.deepEqual(clip.notes.map((n) => [n.time, n.duration]).sort(), [[0, 0.5], [0.25, 0.25]]);
});

test('the returns hold the song\'s reverb and echo, and the echo feeds the reverb', () => {
  const song = (over: Partial<Sequencer>) => sequencerToAls(makeSequencer(
    [makeTrack([[{ step: 0, pitch: 60 }]])],
    { reverb: 5, echoTime: 1.5, echoFeedback: 0.99, echoMix: 0.4, tempo: 150, ...over },
  )).xml;
  const [reverb, echo] = blocks(song({}), 'ReturnTrack');
  // Cathedral: 3.0 s, 70 ms before the tail, damped at 7 kHz.
  assert.equal(dial(reverb, 'DecayTime'), 3000);
  assert.equal(dial(reverb, 'PreDelay'), 70);
  assert.equal(dial(reverb, 'ShelfHiFreq'), 7000);
  // 1.5 beats is 6 sixteenths, index 5 of Live's menu; feedback stops at 0.95,
  // which in Live's own float is 0.9499999881.
  assert.equal(Number(/<DelayLine_SyncedSixteenthL>\n<LomId Value="0" \/>\n<Manual Value="(\d+)"/.exec(echo)?.[1]), 5);
  assert.ok(Math.abs(dial(echo, 'Feedback') - 0.95) < 1e-7);
  // EchoMix is the echo return's fader, and its send into the reverb is on, at 1.
  assert.equal(dial(echo, 'Volume'), 0.4);
  const sends = blocks(echo, 'TrackSendHolder').map((s) => [Number(value(s, 'Manual')), value(s, 'Active')]);
  assert.deepEqual(sends[0], [1, 'true']);
  assert.equal(sends[1][1], 'false');
  // A delay Live's menu has no sixteenths for goes in seconds at the tempo, unsynced.
  const [, odd] = blocks(song({ echoTime: 0.75 * 3 }), 'ReturnTrack');
  assert.ok(Math.abs(dial(odd, 'DelayLine_TimeL') - (2.25 * 60) / 150) < 1e-9);
  assert.match(odd, /<DelayLine_SyncL>\n<LomId Value="0" \/>\n<Manual Value="false"/);
});

test('a chip\'s tint becomes the nearest of Live\'s colours, on its track and its clip', () => {
  // Pure red and the synth family's sky blue land on Live's red and sky blue;
  // a second chip on the track keeps its own colour on its own clip.
  const red = 0xff0000ff | 0;
  const { xml } = sequencerToAls(makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { colour: red, gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 60 }]], { colour: DEFAULT_CHIP_COLOUR, gridX: 2, stepOffset: 32 }),
  ]));
  const track = blocks(xml, 'MidiTrack')[0];
  assert.equal(liveColour(red), 14);
  assert.equal(LIVE_PALETTE[liveColour(DEFAULT_CHIP_COLOUR)], 0x10a4ee);
  assert.equal(Number(value(track, 'Color')), 14);
  assert.deepEqual(blocks(track, 'MidiClip').map((c) => Number(value(c, 'Color'))),
    [14, liveColour(DEFAULT_CHIP_COLOUR)]);
  // Every palette colour is its own nearest.
  LIVE_PALETTE.forEach((rgb, index) => assert.equal(liveColour(((rgb << 8) | 0xff) | 0), index));
});

test('the master bus, asked for, is Live\'s Compressor set as our glue and Live\'s Limiter, on the master', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]);
  const devicesOf = (xml: string) => blocks(xml, 'MasterTrack')[0].split('<FreezeSequencer>')[1];
  assert.match(devicesOf(sequencerToAls(seq).xml), /<Devices \/>/);

  const master = devicesOf(sequencerToAls(seq, { masterBus: { amount: 7, ceilingDb: -0.3 } }).xml);
  const [compressor] = blocks(master, 'Compressor2');
  const [limiter] = blocks(master, 'Limiter');
  assert.match(compressor, /^<Compressor2 Id="0">/);
  assert.match(limiter, /^<Limiter Id="1">/);
  assert.ok(master.indexOf('<Compressor2') < master.indexOf('<Limiter'), 'the glue before the limiter');
  // The tracker's glue at 7, heard the fold's gain lower: the threshold comes
  // down by it and the makeup goes up by it.
  const fold = 20 * Math.log10(FOLD_GAIN);
  const { thresholdDb, makeupDb } = glueLevels(7);
  assert.ok(Math.abs(20 * Math.log10(dial(compressor, 'Threshold')) - (thresholdDb - fold)) < 1e-6);
  assert.ok(Math.abs(dial(compressor, 'Gain') - (makeupDb + fold)) < 1e-6);
  assert.equal(dial(compressor, 'Ratio'), GLUE.ratio);
  assert.equal(dial(compressor, 'Knee'), GLUE.kneeDb);
  assert.equal(dial(compressor, 'Attack'), GLUE.attackMs);
  assert.equal(dial(compressor, 'Release'), GLUE.releaseMs);
  // Peak, no lookahead, Live's own makeup off: ours is the Gain above.
  assert.equal(dial(compressor, 'Model'), 0);
  assert.equal(dial(compressor, 'LookAhead'), 0);
  assert.match(compressor, /<GainCompensation>\n<LomId Value="0" \/>\n<Manual Value="false" \/>/);
  assert.equal(dial(limiter, 'Ceiling'), -0.3);
  assert.equal(dial(limiter, 'Release'), LIMITER.releaseMs);
  // 1.5 ms, the nearest of Live's 1.5, 3 and 6 to our 2.
  assert.equal(dial(limiter, 'Lookahead'), 0);
  assert.match(limiter, /<AutoRelease>\n<LomId Value="0" \/>\n<Manual Value="false" \/>/);
  // Live's own digits for the ratio's range, never an exponent.
  assert.match(compressor, /<Max Value="340282326356119256160033759537265639424" \/>/);
});
