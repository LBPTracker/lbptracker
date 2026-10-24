import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/sequencer/chips.ts';
import { readNotes, NOTE_RECORD_SIZE } from '@lbptracker/cwlib/sequencer/notes.ts';
import { STEPS_PER_CELL, schedule, type Sequencer, type Track } from '@lbptracker/cwlib/sequencer/project.ts';
import { blockRoot, notePitch, quantise, unquantise, MAX_SCALE } from '../src/scale.ts';
import {
  DEFAULT_PPQ,
  META_TAGS,
  sameNotes,
  STEPS_PER_QUARTER,
  midiToSequencer,
  sequencerToMidi,
} from '../src/midi.ts';
import {
  controlChange, metaString, metaText, readMidi, tempoEvent, writeMidi, writeVar, varLength,
} from '../src/smf.ts';

/* ---------------------------------------------------------------- fixtures */

/** One control point, in the shape the record format stores. */
interface Point {
  step: number;
  subStep?: 0 | 1 | 2;
  pitch: number;
  volume?: number;
  modulation?: number;
}

/** Build a track's note bytes the way the game stores them, then read them back. */
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
    guid: 1234, name: 'test', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: grouped.notes, records: bytes, trailingRecords: grouped.trailing.length,
    ...over,
  };
}

function makeSequencer(tracks: Track[], over: Partial<Sequencer> = {}): Sequencer {
  let lengthSteps = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
    }
  }
  return {
    uid: 7, name: 'fixture', author: '', tempo: 120, swing: 0,
    echoFeedback: 0.54, echoTime: 1, echoMix: 0.6, reverb: 5,
    loop: true, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1],
    boardRows: 0,
    tracks, lengthSteps,
    ...over,
  };
}

/**
 * A sequencer's music, sampled -- which is the thing a round trip must preserve.
 *
 * ⚠️ **Not the control points.** The exporter resamples a glide so that it is
 * still a glide in a receiver that does not interpolate, and the importer folds
 * the samples back up; a point list can legitimately come back with a different
 * number of entries and describe the same line. What cannot change is where the
 * line is, so this reads pitch and volume at every third of a step, which is the
 * finest position the record format has.
 */
function music(sequencer: Sequencer) {
  // ⚠️ **Sorted, because the order notes sit in a clip is authoring order.**
  // `schedule` walks a track's records in file order, and this project treats
  // two clips holding the same notes as the same clip -- see `sameNotes` -- so a
  // comparison that counted the order would fail on a difference no note has.
  return schedule(sequencer).map((event) => {
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const midi = (raw: number) => notePitch(raw, track.scale, root);
    const samples: [number, number][] = [];
    const last = event.points[event.points.length - 1].step;
    for (let thirds = 0; thirds <= Math.round(last * 3); thirds += 1) {
      const at = thirds / 3;
      let i = 0;
      while (i + 1 < event.points.length && event.points[i + 1].step <= at) i += 1;
      const from = event.points[i];
      const to = event.points[i + 1];
      const span = to ? to.step - from.step : 0;
      const t = to && span > 0 ? (at - from.step) / span : 0;
      const pitch = to ? midi(from.pitch) + (midi(to.pitch) - midi(from.pitch)) * t : midi(from.pitch);
      const volume = to ? from.volume + (to.volume - from.volume) * t : from.volume;
      samples.push([pitch, volume]);
    }
    return {
      step: Math.round(event.step * 3) / 3,
      durationSteps: Math.round(event.durationSteps * 3) / 3,
      pitch: midi(event.pitch),
      volume: event.volume,
      modulation: Math.round(event.modulation * 15),
      samples,
    };
  }).sort((a, b) =>
    a.step - b.step
    || a.pitch - b.pitch
    || a.durationSteps - b.durationSteps
    || a.volume - b.volume
    || a.modulation - b.modulation);
}

/** Export then import, with everything at its default. */
function roundTrip(sequencer: Sequencer, options = {}) {
  const exported = sequencerToMidi(sequencer, options);
  const imported = midiToSequencer(exported.bytes);
  return { exported, imported };
}

/* --------------------------------------------------------------------- SMF */

test('a variable-length quantity round-trips at every boundary', () => {
  const out = new Uint8Array(8);
  for (const value of [0, 1, 0x7f, 0x80, 0x2000, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0x0fffffff]) {
    const end = writeVar(out, 0, value);
    assert.equal(end, varLength(value), `length of ${value}`);
    // Read it back the way readMidi does, through a one-event track.
    const file = readMidi(
      writeMidi({ format: 0, division: 480, tracks: [{ events: [{ tick: value, data: Uint8Array.of(0x90, 60, 100) }] }] }),
    );
    assert.equal(file.tracks[0].events[0].tick, value, `tick ${value}`);
  }
});

test('running status is decoded, and a file that uses it reads the same', () => {
  // Three note-ons sharing one status byte, as hardware writes them.
  const body = Uint8Array.of(
    0x00, 0x90, 60, 100,
    0x10, 62, 100,
    0x10, 64, 100,
    0x00, 0xff, 0x2f, 0x00,
  );
  const head = Uint8Array.of(
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length,
  );
  const file = new Uint8Array(head.length + body.length);
  file.set(head);
  file.set(body, head.length);

  const read = readMidi(file);
  const notes = read.tracks[0].events.filter((e) => (e.data[0] & 0xf0) === 0x90);
  assert.equal(notes.length, 3, 'all three note-ons survive the shared status byte');
  assert.deepEqual([...notes.map((n) => n.data[1])], [60, 62, 64]);
  assert.deepEqual([...notes.map((n) => n.tick)], [0, 16, 32]);
});

/* ------------------------------------------------------------------ export */

test('a triplet lands on an exact tick — the 96-PPQ bug', () => {
  // ⚠️ This is divergence 4 in ../cwlib-ts/steering/lbp-modding-toolchain.md. The toolkit
  // maps a triplet with `group*96 + pos*32`, which puts four positions of 32
  // ticks inside a 96-tick quarter and pushes the fourth onto the next beat.
  // At 480 PPQ a step is 120 ticks and a third of one is exactly 40.
  const seq = makeSequencer([
    makeTrack([
      [{ step: 4, pitch: 60 }],
      [{ step: 4, subStep: 1, pitch: 62 }],
      [{ step: 4, subStep: 2, pitch: 64 }],
      [{ step: 5, pitch: 65 }],
    ]),
  ]);
  const { bytes } = sequencerToMidi(seq);
  const file = readMidi(bytes);
  const ons = file.tracks
    .flatMap((t) => t.events)
    .filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0)
    .sort((a, b) => a.tick - b.tick);
  assert.deepEqual([...ons.map((e) => e.tick)], [480, 520, 560, 600]);
  assert.equal(DEFAULT_PPQ / STEPS_PER_QUARTER / 3, 40, 'a third of a step is a whole tick');
});

test('the file announces an MPE lower zone and its bend range', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]);
  const { bytes } = sequencerToMidi(seq, { bendRange: 48 });
  const head = readMidi(bytes).tracks[0].events.filter((e) => (e.data[0] & 0xf0) === 0xb0);
  const rpn = (channel: number, lsb: number) => {
    for (let i = 0; i + 2 < head.length; i += 1) {
      if (
        head[i].data[0] === (0xb0 | channel) && head[i].data[1] === 101 && head[i].data[2] === 0 &&
        head[i + 1].data[1] === 100 && head[i + 1].data[2] === lsb && head[i + 2].data[1] === 6
      ) {
        return head[i + 2].data[2];
      }
    }
    return undefined;
  };
  assert.equal(rpn(0, 6), 15, 'MCM on the master channel: 15 member channels');
  assert.equal(rpn(1, 0), 48, 'bend range on the first member channel');
  assert.equal(rpn(0, 0), 2, 'the master keeps MPE’s own smaller range');
});

/** Walk a file's note events, asserting no channel ever holds one pitch twice. */
function assertNoPitchCollision(bytes: Uint8Array): number {
  // ⚠️ **Per track, because that is the only reader this file is written
  // for.** A file's tracks share one set of sixteen channels, so flattening
  // them here would report a collision between two lanes of one part -- and a
  // DAW that lands one project track per MIDI track never sees it, which is
  // exactly the promise the export is built on. Within a track it is a real
  // error: two identical note-ons on one channel have indistinguishable
  // note-offs.
  let written = 0;
  for (const track of readMidi(bytes).tracks) {
    const sounding = new Set<number>();
    for (const event of [...track.events].sort((a, b) => a.tick - b.tick)) {
      const kind = event.data[0] & 0xf0;
      const key = ((event.data[0] & 0x0f) << 8) | event.data[1];
      if (kind === 0x90 && event.data[2] > 0) {
        assert.ok(
          !sounding.has(key),
          `channel ${event.data[0] & 0x0f} already holds note ${event.data[1]}`,
        );
        sounding.add(key);
        written += 1;
      } else if (kind === 0x80) {
        sounding.delete(key);
      }
    }
  }
  return written;
}

test('a chord bigger than the zone takes a second lane, and shares nothing', () => {
  // Twenty different pitches at once against fifteen member channels. This used
  // to cost five of them their own channel; the part is split across two MIDI
  // tracks instead, and a DAW plays them on two instances of one instrument.
  const chord: Point[][] = [];
  for (let i = 0; i < 20; i += 1) chord.push([{ step: 0, pitch: 40 + i }, { step: 8, pitch: 40 + i }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(chord)]));
  assert.equal(exported.notes, 20, 'every note is written');
  assert.equal(exported.sharedChannel, 0, 'and none of them has to share');
  assert.equal(exported.dropped, 0);
  assert.equal(assertNoPitchCollision(exported.bytes), 20);
  const { sequencer } = midiToSequencer(exported.bytes);
  assert.equal(sequencer.tracks.reduce((n, t) => n + t.notes.length, 0), 20);
});

test('twenty-four unisons all survive, on two lanes', () => {
  // ⚠️ **This used to be the one case MPE genuinely could not express**:
  // more copies of a single pitch than there are channels to tell them apart,
  // so eight of these were reported dropped and the corpus had one such note in
  // `Avian`. Lanes end it -- a part over fifteen at once is written across
  // enough MIDI tracks to hold it, and each track has its own fifteen.
  //
  // ❗ `dropped` is kept even so. It is 0 on the corpus and on every shape that
  // could be constructed for it, but a converter that loses notes quietly is
  // exactly what the counter exists to prevent, and proving it unreachable is
  // not the same as it being unreachable.
  const chord: Point[][] = [];
  for (let i = 0; i < 24; i += 1) chord.push([{ step: 0, pitch: 60 }, { step: 8, pitch: 60 }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(chord)]));
  assert.equal(exported.notes, 24, 'every one of them is written');
  assert.equal(exported.dropped, 0);
  assert.equal(assertNoPitchCollision(exported.bytes), 24);
  const { sequencer } = midiToSequencer(exported.bytes);
  assert.equal(sequencer.tracks.reduce((n, t) => n + t.notes.length, 0), 24);
});

test('a glide is written as a glide, not as two steps', () => {
  // ⚠️ The trap this catches: MIDI pitch bend holds until the next message, so
  // two events an octave apart are a jump. The engine ramps between control
  // points, so the export has to resample.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 48 }, { step: 16, pitch: 60 }]])]);
  const { bytes } = sequencerToMidi(seq);
  const bends = readMidi(bytes)
    .tracks.flatMap((t) => t.events)
    .filter((e) => (e.data[0] & 0xf0) === 0xe0);
  assert.ok(bends.length > 16, `expected a resampled ramp, got ${bends.length} bend events`);
  const values = bends.map((e) => (e.data[2] << 7) | e.data[1]);
  assert.equal(values[0], 8192, 'it starts centred');
  // ⚠️ The last event is the reset the note leaves behind: nothing else
  // re-centres a member channel, so the next note to land there would inherit
  // the pitch this one finished on.
  assert.equal(values[values.length - 1], 8192, 'and is undone when the note ends');
  const ramp = values.slice(0, -1);
  for (let i = 1; i < ramp.length; i += 1) {
    assert.ok(ramp[i] >= ramp[i - 1], 'the ramp only ever rises');
  }
  assert.ok(ramp[ramp.length - 1] > 8192 * 1.2, 'and reaches the note it glides to');
});

/* ------------------------------------------------------------- round trips */

test('a plain sequencer survives the round trip note for note', () => {
  const seq = makeSequencer([
    makeTrack([
      [{ step: 0, pitch: 60, volume: 0x60 }],
      [{ step: 4, pitch: 64, volume: 0x40 }],
      [{ step: 8, pitch: 67, volume: 0x7f }],
      [{ step: 12, subStep: 1, pitch: 72, volume: 0x20 }],
    ]),
  ]);
  const { imported } = roundTrip(seq);
  assert.equal(imported.ours, true, 'it recognises its own header');
  assert.equal(imported.notes, 4);
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('glides, fades and modulation all come back', () => {
  const seq = makeSequencer([
    makeTrack([
      // A pitch glide of an octave over four steps.
      [{ step: 0, pitch: 48 }, { step: 4, pitch: 60 }],
      // A fade in from silence -- the case that used to render as nothing.
      [{ step: 8, pitch: 55, volume: 0 }, { step: 16, pitch: 55, volume: 0x7f }],
      // Both at once, and a modulation the note carries throughout.
      [
        { step: 24, pitch: 40, volume: 0x10, modulation: 1 },
        { step: 28, pitch: 47, volume: 0x70, modulation: 1 },
      ],
    ]),
  ]);
  const { imported } = roundTrip(seq);
  const before = music(seq);
  const after = music(imported.sequencer);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].step, before[i].step, `note ${i} position`);
    assert.equal(after[i].durationSteps, before[i].durationSteps, `note ${i} duration`);
    assert.equal(after[i].modulation, before[i].modulation, `note ${i} modulation`);
    for (let s = 0; s < before[i].samples.length; s += 1) {
      const [p0, v0] = before[i].samples[s];
      const [p1, v1] = after[i].samples[s];
      assert.ok(Math.abs(p1 - p0) <= 0.5, `note ${i} pitch at ${s / 3}: ${p1} vs ${p0}`);
      assert.ok(Math.abs(v1 - v0) <= 1, `note ${i} volume at ${s / 3}: ${v1} vs ${v0}`);
    }
  }
});

test('a glide comes back as the two points it was written with', () => {
  // The resampling is an export detail. If it leaked into the import, every
  // glide would come back as a hundred records and a re-export would grow again.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 48 }, { step: 16, pitch: 60 }]])]);
  const { imported } = roundTrip(seq);
  const points = imported.sequencer.tracks[0].notes[0].points;
  assert.equal(points.length, 2, `expected 2 points, got ${points.length}`);
  assert.equal(points[0].pitch, 48);
  assert.equal(points[1].pitch, 60);
});

test('Key and Scale both come back, by different means', () => {
  // ⚠️ The exporter folds both into the note numbers so the file plays
  // anywhere. Undoing that is the difference between a transposition and a
  // projection: `blockRoot(key) - 12` is invertible, `quantise` is measured NOT
  // to be idempotent, so the scale is undone by taking the LOWEST note that
  // snaps to the one the file names -- which always sounds right and only
  // reproduces the author's own field where they wrote on the scale. The record
  // patch covers the rest, which is why the default export is exact either way.

  // A key alone: the placement comes back exactly as it was written.
  const keyed = makeSequencer([
    makeTrack([[{ step: 0, pitch: 61 }], [{ step: 4, pitch: 66 }]], { key: 14, scale: 0 }),
  ]);
  const back = midiToSequencer(sequencerToMidi(keyed).bytes).sequencer;
  assert.equal(back.tracks[0].key, 14, 'the key is restored');
  assert.deepEqual(
    back.tracks[0].notes.map((n) => n.points[0].pitch),
    [61, 66],
    'and the record pitches with it',
  );
  assert.deepEqual(music(back), music(keyed));

  const scaled = makeSequencer([
    makeTrack([[{ step: 0, pitch: 61 }], [{ step: 4, pitch: 66 }]], { key: 14, scale: 2 }),
  ]);
  const t = scaled.tracks[0];
  const heard = [61, 66].map((p) => notePitch(p, t.scale, blockRoot(t.key)));

  // Without the patch: the placement is right and sounds right, but 61 and 66
  // are off the natural minor and come back as the tones they snapped to.
  const loose = midiToSequencer(sequencerToMidi(scaled, { exact: false }).bytes).sequencer;
  assert.equal(loose.tracks[0].scale, 2, 'the scale is restored');
  assert.equal(loose.tracks[0].key, 14, 'and the key with it');
  assert.deepEqual(loose.tracks[0].notes.map((n) => n.points[0].pitch), [60, 65]);
  assert.deepEqual(
    loose.tracks[0].notes.map((n) => notePitch(n.points[0].pitch, 2, blockRoot(14))),
    heard,
    'a different field, the same sound',
  );
  assert.deepEqual(music(loose), music(scaled));

  // With it, which is the default: the author's own fields come back.
  const exact = sequencerToMidi(scaled);
  assert.equal(exact.patched, 1, 'the clip could not be said in MIDI alone');
  const tight = midiToSequencer(exact.bytes).sequencer;
  assert.deepEqual(tight.tracks[0].notes.map((n) => n.points[0].pitch), [61, 66]);
  assert.deepEqual([...tight.tracks[0].records], [...scaled.tracks[0].records]);
});

test('an off-scale note has a preimage only where the scale reaches it', () => {
  // The tables are non-decreasing, so a tone the scale contains is its own
  // lowest preimage and `unquantise` is the identity on it.
  for (let scale = 0; scale <= MAX_SCALE; scale += 1) {
    for (let note = 0; note < 128; note += 1) {
      const snapped = quantise(note, scale);
      assert.equal(
        quantise(unquantise(snapped, scale), scale),
        snapped,
        `scale ${scale} note ${note}`,
      );
    }
  }
  // Natural minor reaches no 1, 4, 6, 9 or 11, and those come back untouched.
  for (const off of [1, 4, 6, 9, 11]) assert.equal(unquantise(60 + off, 2), 60 + off);
});

test('byte 3 keeps its resting bit 6, per clip', () => {
  // ⚠️ Inert -- the engine reads it only when byte 0's bit 7 is set -- and
  // still a fact about the file: eight of the ten corpus levels set it on every
  // record and the oldest sets it on none. Dropping it made 78% of the corpus's
  // clips come back different.
  const set = makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0 });
  const clear = makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 1 });
  set.records[3] |= 0x40;
  clear.records[3] &= ~0x40;
  const seq = makeSequencer([set, clear]);
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const at = (x: number) => back.tracks.find((t) => t.gridX === x)!;
  assert.equal(at(0).records[3] & 0x40, 0x40, 'the set clip keeps it');
  assert.equal(at(1).records[3] & 0x40, 0, 'the clear clip keeps it clear');
});

test('a sub-step record still owns bit 6, whatever the clip rests at', () => {
  // ❗ The bit is the sub-step's high half when byte 0's bit 7 is set, so a
  // record at a third must have it CLEAR and one at two thirds must have it SET,
  // no matter what the rest of the clip does.
  const seq = makeSequencer([
    makeTrack([
      [{ step: 0, pitch: 60 }],
      [{ step: 1, subStep: 1, pitch: 62 }],
      [{ step: 2, subStep: 2, pitch: 64 }],
    ]),
  ]);
  seq.tracks[0].records[3] |= 0x40;
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const points = back.tracks[0].notes.map((n) => n.points[0]);
  assert.deepEqual(points.map((p) => p.subStep), [0, 1, 2]);
  assert.deepEqual(points.map((p) => p.timbre & 0x40), [0x40, 0, 0x40]);
});

test('the two fields MIDI has no room for come back through the patch', () => {
  // ⚠️ **Both are zero in all 1,448,224 corpus records**, so this is the only
  // place either is exercised: a volume above 127, which MIDI has no velocity
  // for, and `timbre` bits 4-5, the per-block table select that picks one of
  // four level/pan/send records and that nothing in `render.ts` reads either.
  // They cost nothing to carry because the patch already exists for the clips
  // that need it -- but a level unlike any of the 22 would need them.
  const built = makeTrack([[{ step: 0, pitch: 60 }], [{ step: 4, pitch: 62 }]]);
  built.records[2] = 200;
  built.records[7] |= 0x30;
  const grouped = readNotes(built.records);
  const track: Track = {
    ...built, notes: grouped.notes, trailingRecords: grouped.trailing.length,
  };
  const seq = makeSequencer([track]);

  const loose = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.equal(loose.tracks[0].records[2], 127, 'MIDI alone clamps the volume');
  assert.equal(loose.tracks[0].records[7] & 0x30, 0, 'and cannot say the table select');

  const tight = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.deepEqual([...tight.tracks[0].records], [...track.records]);
});

test('records come back in the order the editor writes them', () => {
  // ⚠️ **Three keys, each measured at 100% over the corpus and each found by
  // the failures the one before it left**: position ascending (58,693 of 59,029
  // clips), then pitch DESCENDING (27,124 of 27,124 clips with a tie), then the
  // END ascending (333 of 333 clips still tied). A fourth would be a guess --
  // among the 254 clips tied on all three, no key beats 98.8% -- so the 8 clips
  // that remain are authoring order and nothing in the music says what it was.
  const seq = makeSequencer([
    makeTrack([
      // Written deliberately out of every order the sort could impose.
      [{ step: 0, pitch: 51 }, { step: 15, pitch: 51 }],
      [{ step: 0, pitch: 51 }, { step: 24, pitch: 63 }],
      [{ step: 0, pitch: 60 }, { step: 8, pitch: 60 }],
      [{ step: 4, pitch: 40 }],
    ]),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes.map((n) => [n.startStep, n.points[0].pitch, n.endStep]),
    // pitch 60 before pitch 51 at step 0; then the shorter of the two 51s.
    [[0, 60, 8], [0, 51, 15], [0, 51, 24], [4, 40, 4]],
  );
});

test('a coincident pair states both modulations, in order', () => {
  // ❗ **The first record's modulation is not decoration the collapse can drop.**
  // `voice+0x28` is set from the note word that triggers the voice, and the
  // stack loop at `fmodextinput.prx` `0x1ae7` reads `Params[0..2]` -- per-layer
  // detune, spread and random start -- through it once, before any ramp runs.
  // The zero-length segment then jumps to the second value. Both are audible,
  // so both are written: CC 74 before the note-on, CC 74 after it.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 29, modulation: 0 },
      { step: 0, pitch: 28, modulation: 1 },
    ]]),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes[0].points.map((p) => [p.pitch, p.timbre & 15]),
    [[29, 0], [28, 15]],
    'both records, each with its own modulation',
  );
});

test('a control point survives even where nothing moves', () => {
  // ❗ **A repeated value is a control point**, and that is only readable
  // because the resampler never sends the same value twice. A rounded ramp is a
  // staircase, so resampling naturally produces runs of equal values;
  // suppressing them costs a receiver nothing and buys the one signal MIDI has
  // no other room for. 509 of the corpus's lost control points were this shape.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 41, volume: 60 },
      { step: 1, pitch: 41, volume: 60 },
      { step: 2, pitch: 41, volume: 60 },
      { step: 3, pitch: 41, volume: 60 },
    ]]),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes[0].points.map((p) => [p.step, p.pitch, p.volume]),
    [[0, 41, 60], [1, 41, 60], [2, 41, 60], [3, 41, 60]],
    'all four records, not just the two the curve needs',
  );
});

test('a plateau before a fade is still a plateau', () => {
  // ⚠️ **The event that opens a moving segment is a deliberate repeat too**,
  // and de-duplicating it took the corpus patch from 352 clips to 1,077: a note
  // that sat at 96 for two steps and then faded came back fading from its very
  // first frame. `k === 0` is exempt for that reason.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 60, volume: 96 },
      { step: 8, pitch: 60, volume: 96 },
      { step: 16, pitch: 60, volume: 0 },
    ]]),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes[0].points.map((p) => [p.step, p.volume]),
    [[0, 96], [8, 96], [16, 0]],
    'the fade starts at step 8, not at the note-on',
  );
});

test('the mixer rides on CC 7, 10, 91 and 90, and a fader move wins', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], {
      level: 0.25, pan: 0.35, reverbSend: 0.4, echoSend: 0.65,
    }),
  ]);
  const bytes = sequencerToMidi(seq).bytes;

  // A DAW sees the level's own mix instead of every part flat and centred.
  const ccs = new Map<number, number>();
  for (const t of readMidi(bytes).tracks.slice(1)) {
    for (const e of t.events) if ((e.data[0] & 0xf0) === 0xb0) ccs.set(e.data[1], e.data[2]);
  }
  assert.equal(ccs.get(7), Math.round(0.25 * 127));
  assert.equal(ccs.get(10), Math.round(0.35 * 127));
  assert.equal(ccs.get(91), Math.round(0.4 * 127));
  // ⚠️ CC 90 is UNDEFINED in the specification, which is why it was chosen:
  // a delay send has no controller of its own, and 94 -- tried first -- is read
  // as celeste/detune by more synths than read it as delay. Inert everywhere
  // beats right sometimes and wrong the rest. A judgement, not a measurement.
  assert.equal(ccs.get(90), Math.round(0.65 * 127));

  // ⚠️ Untouched, the meta's exact value stands -- seven bits cannot hold
  // 0.35, and rounding it every trip would walk the pan across the stereo field.
  const back = midiToSequencer(bytes).sequencer;
  assert.equal(back.tracks[0].level, 0.25);
  assert.equal(back.tracks[0].pan, 0.35);
  assert.equal(back.tracks[0].reverbSend, 0.4);
  assert.equal(back.tracks[0].echoSend, 0.65);

  // Moved, the controller wins.
  const file = readMidi(bytes);
  const edited = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t, i) => (i === 0 ? t : {
      events: t.events.map((e) => ((e.data[0] & 0xf0) === 0xb0 && e.data[1] === 10
        ? controlChange(e.tick, e.data[0] & 0x0f, 10, 0) : e)),
    })),
  });
  assert.equal(midiToSequencer(edited).sequencer.tracks[0].pan, 0);
});

test('a part with no meta at all takes its name from the track', () => {
  // A file from somewhere else has no `LBP-TRK`, so the track name is all there
  // is -- and it is taken whole, since `row N - ` is our own scheme and a
  // stranger's file will not follow it.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]);
  const file = readMidi(sequencerToMidi(seq).bytes);
  const stripped = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t) => ({
      events: t.events
        .filter((e) => metaString(e)?.type !== 0x01)
        .map((e) => (metaString(e)?.type === 0x03 ? metaText(e.tick, 0x03, 'Whatever') : e)),
    })),
  });
  const back = midiToSequencer(stripped);
  assert.equal(back.ours, false);
  assert.equal(back.sequencer.tracks[0].name, 'Whatever');
});

test('a coincident pair states both volumes too', () => {
  // ❗ `Jarred` writes a note as pitch 48 at volume 27 and pitch 75 at volume 96
  // on one step. Both pitches already travelled and both modulations did; the
  // first volume did not, and 23 clips needed a verbatim patch for want of one
  // channel-pressure message.
  //
  // ⚠️ **The jumped-to pressure has to sort AFTER the note-on and `rank`
  // cannot see the difference** -- pressure ranks 2 against a note-on's 3, so
  // pushing it later was not enough; it sorted in front anyway and the note
  // came back at 96. CC 74 escaped this only because it shares rank 3. The
  // exporter marks the event instead.
  const seq = makeSequencer([
    makeTrack([[
      { step: 23, pitch: 48, volume: 27 },
      { step: 23, pitch: 75, volume: 96 },
    ]]),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes[0].points.map((p) => [p.pitch, p.volume]),
    [[48, 27], [75, 96]],
  );
});

test('a chain stored out of order is the same chain', () => {
  // ⚠️ **Which record carries the end flag is not information.** It delimits
  // the chain, and `makeNote` sorts a chain into position order anyway, so two
  // chains holding the same records decode to the same note whatever order the
  // file stored them in. 45 corpus clips needed a verbatim patch for that alone.
  const forward = Uint8Array.of(23, 40, 0x60, 0x40, 28, 44 | 0x80, 0x60, 0x40);
  const reversed = Uint8Array.of(28, 44, 0x60, 0x40, 23, 40 | 0x80, 0x60, 0x40);
  assert.ok(sameNotes(forward, reversed), 'the same chain, stored the other way round');
  // And a genuinely different record is still different.
  const other = Uint8Array.of(23, 40, 0x60, 0x40, 29, 44 | 0x80, 0x60, 0x40);
  assert.ok(!sameNotes(forward, other));
});

test('the record patch is written only for what MIDI could not say', () => {
  // A plain clip needs none of it, and says so.
  const plain = sequencerToMidi(makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]));
  assert.equal(plain.patched, 0);
  assert.equal(plain.unpatched, 0);
  assert.ok(!new TextDecoder().decode(plain.bytes).includes('"fix"'));
});

test('the mixer travels in the header — divergence 5', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], {
    numChannels: 3, volumes: [0.5, 0.25, 1, 1, 1, 1], swing: 0.4, tempo: 173, reverb: 9,
  });
  const { imported } = roundTrip(seq);
  assert.equal(imported.sequencer.numChannels, 3);
  assert.deepEqual(imported.sequencer.volumes, [0.5, 0.25, 1, 1, 1, 1]);
  assert.equal(imported.sequencer.swing, 0.4);
  assert.equal(imported.sequencer.tempo, 173);
  assert.equal(imported.sequencer.reverb, 9);
});

test('every sequencer and placement field that survives, does', () => {
  // The whole inventory in one place, so that adding a field to `Sequencer` or
  // `Track` and forgetting the header meta shows up here rather than in a DAW.
  const seq = makeSequencer(
    [makeTrack([[{ step: 0, pitch: 60 }]], {
      guid: 4242, name: 'kalimba', gridY: 5, colour: 0xff8000ff | 0,
      level: 0.375, pan: 0.8, echoSend: 0.25, reverbSend: 0.6,
    })],
    {
      uid: 98765, name: 'A Song', author: 'Hug-Of-War', tempo: 173, swing: 0.35,
      echoFeedback: 0.42, echoTime: 3, echoMix: 0.75, reverb: 11,
      loop: false, startPoint: 7, numChannels: 4, boardRows: 12,
      volumes: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    },
  );
  const { sequencer: back } = midiToSequencer(sequencerToMidi(seq).bytes);
  for (const field of [
    // `author` has no MIDI message -- FF 02 is a copyright notice, which is a
    // claim the game's file never made -- so it rides in `LBP-SEQ`.
    'uid', 'name', 'author', 'tempo', 'swing', 'echoFeedback', 'echoTime', 'echoMix',
    // ⚠️ `boardRows` is here because MIDI has no board, and losing it re-routes
    // every track to a different mixer channel on the way back. See
    // `channelVolume` and answered question 9.
    'reverb', 'loop', 'startPoint', 'numChannels', 'boardRows',
  ] as const) {
    assert.deepEqual(back[field], seq[field], `sequencer.${field}`);
  }
  assert.deepEqual(back.volumes, seq.volumes);
  for (const field of [
    // ⚠️ `colour` is here because the chip's tint has no MIDI message at all:
    // drop it from `LBP-TRK` and 22,188 of the corpus's 62,158 chips come back
    // wearing their instrument's factory colour instead of the one they were
    // given. Measured by `dev/verify-midi.ts`.
    'guid', 'name', 'colour', 'gridY', 'level', 'pan', 'echoSend', 'reverbSend',
  ] as const) {
    assert.deepEqual(back.tracks[0][field], seq.tracks[0][field], `track.${field}`);
  }
  assert.equal(back.tracks[0].key, seq.tracks[0].key, 'track.key');
  assert.equal(back.tracks[0].scale, seq.tracks[0].scale, 'track.scale');
});

test('the header carries nothing MIDI has a message for', () => {
  // ⚠️ **A duplicated field is a field that can disagree with itself**, and
  // this one did: the header's `tempo` beat the tempo event, so a file
  // re-tempoed in a DAW imported at the level's old tempo. The name, the tempo,
  // the bend range and the MPE flag all have first-class MIDI carriers and none
  // of them belongs here. `stepsPerQuarter` was written and never read.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { name: 'A Song', tempo: 173 });
  const found = readMidi(sequencerToMidi(seq).bytes).tracks
    .flatMap((t) => t.events)
    .map(metaString)
    .find((m) => m?.type === 0x01 && m.text.startsWith(META_TAGS.sequencer));
  assert.ok(found, 'the header meta is there');
  const header = JSON.parse(found.text.slice(META_TAGS.sequencer.length));
  for (const gone of ['name', 'tempo', 'bendRange', 'mpe', 'stepsPerQuarter']) {
    assert.ok(!(gone in header), `${gone} is still in the header`);
  }
  // And each is still recoverable, from the message MIDI has for it.
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.equal(back.name, 'A Song');
  assert.equal(back.tempo, 173);
});

test('the tempo is the tempo event, and a DAW that changes it wins', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { tempo: 120 });
  const file = readMidi(sequencerToMidi(seq).bytes);
  const retempoed = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t, i) => (i !== 0 ? t : {
      events: t.events.map((e) => (e.data[0] === 0xff && e.data[1] === 0x51 ? tempoEvent(0, 174) : e)),
    })),
  });
  assert.equal(midiToSequencer(retempoed).sequencer.tempo, 174, 'the DAW set 174');

  // ❗ And a tempo nothing touched keeps its exact value. The message stores
  // MICROSECONDS per quarter, so a plain read of 174 gives 173.99979 and the
  // field would drift on every trip; the snap asks which whole BPM encodes to
  // exactly those microseconds. All 149 corpus tempos are whole, 70..240.
  for (const tempo of [70, 120, 173, 222, 240]) {
    const one = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { tempo });
    assert.equal(midiToSequencer(sequencerToMidi(one).bytes).sequencer.tempo, tempo);
  }
  // A fractional tempo is the one thing this costs, and it costs 1e-4 BPM.
  const odd = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { tempo: 137.5 });
  const backOdd = midiToSequencer(sequencerToMidi(odd).bytes).sequencer.tempo;
  assert.ok(Math.abs(backOdd - 137.5) < 0.002, `137.5 came back as ${backOdd}`);
});

test('an unnamed sequencer comes back unnamed', () => {
  // 10 of the corpus's 149 have no name, and the conductor track's name meta is
  // where the name lives now -- so substituting a friendly default would rename
  // them on the way back.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { name: '' });
  assert.equal(midiToSequencer(sequencerToMidi(seq).bytes).sequencer.name, '');
});

test('the bend range is read from a member channel, not the master', () => {
  // ❗ MPE puts the per-note range on RPN 0 of a MEMBER channel; the master has
  // its own, smaller one -- ours writes 2 -- and reading that instead would
  // flatten every glide by 24x. The file writes both, in that order.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 40 }, { step: 8, pitch: 100 }]]),
  ]);
  const out = sequencerToMidi(seq);
  const back = midiToSequencer(out.bytes).sequencer;
  assert.deepEqual(
    back.tracks[0].notes[0].points.map((p) => p.pitch),
    seq.tracks[0].notes[0].points.map((p) => p.pitch),
    'a 60-semitone glide needs the member range, not the master 2',
  );
});

test('a part longer than a clip is re-cut, and the music does not move', () => {
  // A record's step field is seven bits, so 128 steps is a clip. Notes past
  // that have to open a new one -- on a cell boundary, `gridX * 16`.
  const notes: Point[][] = [];
  for (let step = 0; step < 400; step += 8) notes.push([{ step: step % 128, pitch: 60 }]);
  const tracks = [0, 128, 256, 384].map((offset, index) =>
    makeTrack(
      notes.filter((_, i) => Math.floor((i * 8) / 128) === index).map((n) => n),
      { gridX: offset / STEPS_PER_CELL, stepOffset: offset },
    ),
  );
  const seq = makeSequencer(tracks.filter((t) => t.notes.length > 0));
  const { imported } = roundTrip(seq);
  assert.ok(imported.clips > 1, `expected several clips, got ${imported.clips}`);
  assert.equal(imported.dropped, 0);
  for (const track of imported.sequencer.tracks) {
    assert.equal(track.stepOffset % STEPS_PER_CELL, 0, 'clips start on a cell');
    for (const note of track.notes) assert.ok(note.endStep <= 127, 'and stay inside seven bits');
  }
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('clips that share an instrument and a row merge into one part', () => {
  // 1150 placements would be 1150 MIDI tracks; a DAW would be unusable. Clips
  // differing only in `gridX` are one part played at different times.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridX: 1, stepOffset: 16 }),
    makeTrack([[{ step: 0, pitch: 64 }]], { gridX: 2, stepOffset: 32 }),
    makeTrack([[{ step: 0, pitch: 67 }]], { gridX: 0, stepOffset: 0, gridY: 1, guid: 99 }),
  ]);
  const { exported, imported } = roundTrip(seq);
  assert.equal(exported.parts, 2, 'two instruments, two parts');
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('plain mode spends channels on parts and says what it dropped', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 48 }, { step: 8, pitch: 60 }], [{ step: 16, pitch: 55 }]]),
  ]);
  const exported = sequencerToMidi(seq, { mpe: false });
  assert.equal(exported.droppedGlides, 1, 'the glide could not be written, and is counted');
  const file = readMidi(exported.bytes);
  const bends = file.tracks.flatMap((t) => t.events).filter((e) => (e.data[0] & 0xf0) === 0xe0);
  assert.equal(bends.length, 0, 'and no channel-wide bend is invented in its place');
  const ons = file.tracks.flatMap((t) => t.events).filter((e) => (e.data[0] & 0xf0) === 0x90);
  assert.equal(new Set(ons.map((e) => e.data[0] & 0x0f)).size, 1, 'one channel for the part');
});

test('swing can be baked into the timing, or carried in the header', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }], [{ step: 1, pitch: 62 }]])], {
    swing: 0.5,
  });
  const straight = readMidi(sequencerToMidi(seq).bytes);
  const swung = readMidi(sequencerToMidi(seq, { bakeSwing: true }).bytes);
  const firstOffbeat = (file: ReturnType<typeof readMidi>) =>
    file.tracks
      .flatMap((t) => t.events)
      .filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[1] === 62)[0].tick;
  assert.equal(firstOffbeat(straight), 120, 'the grid is straight by default');
  assert.ok(firstOffbeat(swung) > 120, 'and stretched when the swing is baked');
  // Either way the sequencer's own swing survives, so a re-import still swings.
  assert.equal(midiToSequencer(sequencerToMidi(seq).bytes).sequencer.swing, 0.5);
});

test('a file from somewhere else imports as a plain chromatic part', () => {
  // No LBP metas at all: two notes and a tempo, as any DAW would write them.
  const bytes = writeMidi({
    format: 1,
    division: 96,
    tracks: [
      {
        events: [
          { tick: 0, data: Uint8Array.of(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20) },
          { tick: 0, data: Uint8Array.of(0x90, 60, 100) },
          { tick: 96, data: Uint8Array.of(0x80, 60, 64) },
          { tick: 96, data: Uint8Array.of(0x90, 64, 80) },
          { tick: 144, data: Uint8Array.of(0x80, 64, 64) },
        ],
      },
    ],
  });
  const result = midiToSequencer(bytes, 'from a DAW');
  assert.equal(result.ours, false);
  assert.equal(result.notes, 2);
  assert.equal(result.sequencer.name, 'from a DAW');
  assert.equal(Math.round(result.sequencer.tempo), 120);
  const events = schedule(result.sequencer);
  assert.deepEqual(events.map((e) => e.pitch), [60, 64]);
  // 96 ticks at 96 PPQ is a quarter: step 0 for four steps, then step 4 for two.
  assert.deepEqual(events.map((e) => e.step), [0, 4]);
  assert.deepEqual(events.map((e) => e.durationSteps), [4, 2]);
  assert.deepEqual(events.map((e) => e.volume), [100, 80]);
});

test('a note shorter than the grid is lengthened, and counted', () => {
  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: [
        { tick: 0, data: Uint8Array.of(0x90, 60, 100) },
        { tick: 30, data: Uint8Array.of(0x80, 60, 64) },   // a 64th note
      ],
    }],
  });
  const result = midiToSequencer(bytes);
  assert.equal(result.lengthened, 1);
  assert.equal(schedule(result.sequencer)[0].durationSteps, 1, 'one step is the shortest there is');
});

test('the header survives a re-export, so a file can go round twice', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 48 }, { step: 8, pitch: 60 }], [{ step: 16, pitch: 55, volume: 0x30 }]], {
      key: 15, scale: 3,
    }),
  ], { tempo: 200, numChannels: 2, swing: 0.2 });
  const once = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const twice = midiToSequencer(sequencerToMidi(once).bytes).sequencer;
  assert.deepEqual(music(twice), music(once), 'the second trip changes nothing');
  assert.equal(twice.tempo, 200);
  assert.equal(twice.numChannels, 2);
});

test('a track is named for its row and instrument, and the Thing name rides along', () => {
  // ❗ The label is `row N - INSTRUMENT` because those two have no MIDI message
  // of their own and the name is the only thing a DAW can edit to change them.
  // `Track.name` is the Thing's own label -- empty on every corpus placement --
  // and it goes in the meta, where nothing else claims it.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], {
    name: 'lbp3/piano', guid: 4242, gridY: 7,
  })]);
  const { exported, imported } = roundTrip(seq);
  const names = readMidi(exported.bytes)
    .tracks.flatMap((t) => t.events)
    .map(metaString)
    .filter((m) => m?.type === 0x03)
    .map((m) => m?.text);
  assert.ok(names.includes('row 7 - guid 4242'), `track names: ${names.join(', ')}`);
  assert.equal(imported.sequencer.tracks[0].name, 'lbp3/piano');
  assert.equal(imported.sequencer.tracks[0].gridY, 7);
  assert.equal(imported.sequencer.tracks[0].guid, 4242, 'and the GUID, so it plays the same sample');
});

test('clips of one part keep their own names', () => {
  // ⚠️ **`Track.name` is not always empty**, which this project believed for
  // some time: 4,353 of the corpus's 62,158 placements carry one -- 23 distinct
  // strings, the editor's own defaults. The meta holds the part's, and a map
  // holds the clips that disagree, which 7 parts of 4,909 do; without it their
  // 84 clips came back unnamed.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, name: 'Synth: Ray Gun' }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridX: 1, name: 'Synth: Square Wave' }),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.deepEqual(
    [...back.tracks].sort((x, y) => x.gridX - y.gridX).map((t) => t.name),
    ['Synth: Ray Gun', 'Synth: Square Wave'],
  );
});

test('clips of one part keep their own tints, and a foreign file gets the factory one', () => {
  // ❗ **A part is a group of placements that share a mixer, and the tint is
  // not in that key** -- so it rides beside the name: one value for the part
  // and a map for the clips that disagree. 22,188 of the corpus's 62,158 chips
  // are tinted away from their instrument's own colour.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, guid: 129031, colour: 0x40ff0100 }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridX: 1, guid: 129031, colour: 0xff8000ff | 0 }),
  ]);
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.deepEqual(
    [...back.tracks].sort((x, y) => x.gridX - y.gridX).map((t) => t.colour),
    [0x40ff0100, 0xff8000ff | 0],
  );
  // ⚠️ A file nobody wrote a `LBP-TRK` into -- a DAW's own -- says nothing
  // about a tint, and nothing about an instrument either: the label is read
  // only against the meta's, so `guid` stays 0 and the chip takes
  // `factoryColour`'s fallback rather than a family's colour. That is the same
  // rule the board draws such a placement by.
  const file = readMidi(sequencerToMidi(seq).bytes);
  const stripped = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t) => ({
      events: t.events.filter((e) => metaString(e)?.type !== 0x01),
    })),
  });
  const plain = midiToSequencer(stripped);
  assert.equal(plain.ours, false);
  assert.equal(plain.sequencer.tracks[0].colour, DEFAULT_CHIP_COLOUR);
});

test('two placements sharing a label are told apart, and come back', () => {
  // ⚠️ **A label names two of a placement's eight fields.** `Ascetic` has the
  // same kit on row 0 twice -- pan 0.60 with no reverb, and pan 0.30 with 0.20
  // of it -- which the game treats as two placements and a track list showed as
  // one name twice. Measured: 2,539 of 4,911 part tracks (51.7%) shared a label,
  // separated by level, pan, either send, or the key.
  //
  // ❗ The index says nothing about WHAT differs, on purpose: the mixer is on
  // CC 7, 10, 91 and 90 now, so a DAW already shows each track's fader and pan.
  // The label only has to be something you can point at.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, stepOffset: 0, guid: 5, pan: 0.6 }),
    // ❗ `stepOffset` is `gridX * STEPS_PER_CELL` in a real level, and a fixture
    // that sets one without the other places a note outside its own cell.
    makeTrack([[{ step: 0, pitch: 62 }]], {
      gridX: 4, stepOffset: 4 * STEPS_PER_CELL, guid: 5, pan: 0.3, reverbSend: 0.2,
    }),
  ]);
  const names = readMidi(
    sequencerToMidi(seq, { instrumentName: () => 'kit', mergeRows: false }).bytes,
  ).tracks
    .slice(1)
    .map((t) => t.events.map(metaString).find((m) => m?.type === 0x03)?.text);
  assert.deepEqual(names, ['row 0 - kit', 'row 0 - kit #2']);

  // And the suffix comes off exactly, because the meta says which index it is.
  const back = midiToSequencer(sequencerToMidi(seq, { mergeRows: false }).bytes).sequencer;
  assert.deepEqual([...back.tracks].sort((a, b) => a.gridX - b.gridX).map((t) => t.pan), [0.6, 0.3]);
});

test('placements sounding at the same time are not merged', () => {
  // ❗ One track has one mixer state, and there is no honest way to give two
  // sounding placements different pans on it -- so overlapping ones fall back
  // to separate tracks and the `#2` tells them apart. Over the corpus that is 2
  // row groups of 850, which is what makes merging free rather than a trade.
  //
  // ⚠️ Overlapping is not two Things in one place: no two placements of a row
  // group ever share a cell. It is a clip started at an earlier cell still
  // sounding when a later one begins, which a cell of 16 steps and a clip of up
  // to 128 makes easy.
  const long: Point[][] = [[{ step: 0, pitch: 60 }, { step: 100, pitch: 60 }]];
  const seq = makeSequencer([
    makeTrack(long, { gridX: 0, stepOffset: 0, guid: 5, pan: 0.6 }),
    makeTrack([[{ step: 0, pitch: 62 }]], {
      gridX: 4, stepOffset: 4 * STEPS_PER_CELL, guid: 5, pan: 0.3,
    }),
  ]);
  const names = readMidi(sequencerToMidi(seq, { instrumentName: () => 'kit' }).bytes).tracks
    .slice(1)
    .map((t) => t.events.map(metaString).find((m) => m?.type === 0x03)?.text);
  assert.deepEqual(names, ['row 0 - kit', 'row 0 - kit #2'], 'two tracks, not one');

  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.deepEqual(
    [...back.tracks].sort((a, b) => a.gridX - b.gridX).map((t) => t.pan),
    [0.6, 0.3],
  );
});

test('mergeRows puts a row on one track, with the mixer as automation', () => {
  // ❗ Two placements of one kit on one row, at different pans: one MIDI track,
  // one meta each, and CC 10 written where each placement's notes take over --
  // here their first notes open their cells. Over the corpus this is 4,911
  // tracks down to 3,224.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, stepOffset: 0, guid: 5, pan: 0.6 }),
    makeTrack([[{ step: 0, pitch: 62 }]], {
      gridX: 4, stepOffset: 4 * STEPS_PER_CELL, guid: 5, pan: 0.3,
    }),
  ]);
  const out = sequencerToMidi(seq, { mergeRows: true, exact: false });
  const file = readMidi(out.bytes);
  assert.equal(file.tracks.length - 1, 1, 'one track, not two');
  const pans = file.tracks[1].events
    .filter((e) => (e.data[0] & 0xf0) === 0xb0 && e.data[1] === 10)
    .map((e) => [e.tick, e.data[2]]);
  assert.deepEqual(pans, [[0, 76], [4 * STEPS_PER_CELL * 120, 38]], 'pan is automated');

  // ⚠️ Read from the meta's own clips, not from `part.cells` -- which is
  // filled in later, so taking the tick from there made every placement look
  // like it began at cell 0 and the second read the first one's pan: 0.598
  // instead of 0.3.
  const back = midiToSequencer(out.bytes).sequencer;
  assert.deepEqual(
    [...back.tracks].sort((a, b) => a.gridX - b.gridX).map((t) => [t.gridX, t.pan, t.notes.length]),
    [[0, 0.6, 1], [4, 0.3, 1]],
    'both placements come back, each with its own notes and pan',
  );
});

test('a part that comes back after another on a merged track gets its own mixer back', () => {
  // ❗ A at cell 0, B at cell 2, A again at cell 4. Until 2026-09-24 the CCs
  // were written once per part, at its first cell, so a DAW played A's cell 4
  // on B's pan -- 65,345 notes of the corpus -- while our import, reading at
  // each first cell, never noticed. Every note must be under its own dials.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, stepOffset: 0, guid: 5, pan: 0.6 }),
    // B's note is late in its cell, so its first cell is still under A.
    makeTrack([[{ step: 5, pitch: 62 }]], { gridX: 2, stepOffset: 2 * STEPS_PER_CELL, guid: 5, pan: 0.3 }),
    makeTrack([[{ step: 3, pitch: 64 }]], { gridX: 4, stepOffset: 4 * STEPS_PER_CELL, guid: 5, pan: 0.6 }),
  ]);
  const out = sequencerToMidi(seq, { mergeRows: true, exact: false });
  const file = readMidi(out.bytes);
  assert.equal(file.tracks.length - 1, 1, 'one track');
  let pan: number | undefined;
  const heard: [number, number | undefined][] = [];
  for (const e of file.tracks[1].events) {
    if ((e.data[0] & 0xf0) === 0xb0 && e.data[1] === 10) pan = e.data[2];
    if ((e.data[0] & 0xf0) === 0x90 && e.data[2] > 0) heard.push([e.data[1], pan]);
  }
  assert.deepEqual(heard, [[60, 76], [62, 38], [64, 76]], 'each note under its own placement\'s pan');

  // And the import reads each at one of its own notes, not at its first cell,
  // where B's would still be A's.
  const back = midiToSequencer(out.bytes).sequencer;
  assert.deepEqual(
    [...back.tracks].sort((a, b) => a.gridX - b.gridX).map((t) => [t.gridX, t.pan]),
    [[0, 0.6], [2, 0.3], [4, 0.6]],
  );
});

test('the MIDI tracks come out in board order', () => {
  // ❗ `gridY` is the Thing's own y, negated -- `boardToGrid` computes
  // `floor(-y / 105)` -- so row 0 is the top of the board and ascending is top
  // to bottom, which is how the sequencer draws it.
  //
  // ⚠️ The level's own order is not board order: of the corpus's 149
  // sequencers, exactly one already had its tracks ascending.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridY: 5, gridX: 0, guid: 11 }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridY: 1, gridX: 4, guid: 22 }),
    makeTrack([[{ step: 0, pitch: 64 }]], { gridY: 1, gridX: 0, guid: 33 }),
  ]);
  const names = readMidi(sequencerToMidi(seq).bytes).tracks
    .slice(1)
    .map((t) => t.events.map(metaString).find((m) => m?.type === 0x03)?.text);
  // Row before cell, cell before GUID.
  assert.deepEqual(names, ['row 1 - guid 33', 'row 1 - guid 22', 'row 5 - guid 11']);
});

test('the import never depends on the track name', () => {
  // ❗ **The label is cosmetic and a debugging aid; the meta is the carrier.**
  // A DAW that renames tracks to its own scheme, or drops the name, must not
  // change what comes back — so everything the label says is in the meta too,
  // and the label is read only to see whether it says something DIFFERENT.
  // Measured over the corpus: every track name removed, 62,158 clips of 62,158
  // still correct.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { guid: 4242, gridY: 7 })]);
  const file = readMidi(sequencerToMidi(seq, { instrumentName: () => 'saw_wave' }).bytes);
  const nameless = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t, i) => ({
      events: t.events.filter((e) => !(i > 0 && metaString(e)?.type === 0x03)),
    })),
  });
  const back = midiToSequencer(nameless).sequencer;
  assert.equal(back.tracks[0].guid, 4242);
  assert.equal(back.tracks[0].gridY, 7);
  assert.equal(back.tracks[0].notes.length, 1);
});

test('a resolver cannot change an instrument nobody renamed', () => {
  // ⚠️ **The meta carries the instrument's NAME as well as its GUID**, and
  // without it any resolver hit overrode the GUID: a manifest that mapped
  // `saw_wave` to a different GUID silently changed the instrument on a file
  // nobody had touched. Only a label that disagrees with the meta is an edit.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { guid: 4242 })]);
  const bytes = sequencerToMidi(seq, { instrumentName: () => 'saw_wave' }).bytes;
  const back = midiToSequencer(bytes, { instrumentGuid: () => 777 }).sequencer;
  assert.equal(back.tracks[0].guid, 4242, 'the resolver is not even asked');
});

test('renaming a track moves the part to another row and instrument', () => {
  // ❗ **The one thing a DAW could not do before.** A program change is seven
  // bits against a six-digit GUID and there is no message at all for a board
  // row, so both live in the track name -- and only the caller's own manifest
  // can turn `piano` back into a GUID.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { guid: 4242, gridY: 7 })]);
  const bytes = sequencerToMidi(seq, {
    instrumentName: (guid) => (guid === 4242 ? 'saw_wave' : 'piano'),
  }).bytes;
  const file = readMidi(bytes);
  const renamed = writeMidi({
    format: 1, division: file.division,
    tracks: file.tracks.map((t, i) => (i === 0 ? t : {
      events: t.events.map((e) => {
        const m = metaString(e);
        return m?.type === 0x03 ? metaText(e.tick, 0x03, 'row 2 - piano') : e;
      }),
    })),
  });
  const moved = midiToSequencer(renamed, {
    instrumentGuid: (name) => (name === 'piano' ? 9999 : undefined),
  }).sequencer;
  assert.equal(moved.tracks[0].gridY, 2, 'the row moved');
  assert.equal(moved.tracks[0].guid, 9999, 'and so did the instrument');

  // ⚠️ A name nothing resolves leaves the GUID alone: a typo in a track name
  // must not silence a part.
  const typo = midiToSequencer(renamed, { instrumentGuid: () => undefined }).sequencer;
  assert.equal(typo.tracks[0].guid, 4242, 'the meta still says what to play');
  assert.equal(typo.tracks[0].gridY, 2, 'but the row is plain enough to read');
});

test('a glide keeps its channel when flat notes are competing for it', () => {
  // ⚠️ **This is the shared-channel problem.** A zone has fifteen member
  // channels and this engine has thirty-two voices, so a dense passage runs
  // out — and allocating in plain time order let fifteen flat notes take every
  // channel a moment before the one note that actually needed one. Across the
  // corpus that flattened 3,593 notes where at most 1,172 ever had to.
  // ❗ **Lanes end the ordinary form of this**, so the shape that still reaches
  // it is the one the corpus's own 30 sharers have: ONE long flat note whose
  // tail crosses a run of glides that start later. Instantaneous polyphony
  // never passes two, so the part stays a single lane -- but the pool hands out
  // channels to the gliding pass first, round-robin, and by the time the flat
  // note is placed every channel has a glide somewhere inside its span.
  const notes: Point[][] = [[{ step: 0, pitch: 100 }, { step: 60, pitch: 100 }]];
  for (let i = 0; i < 15; i += 1) {
    notes.push([{ step: 2 + i * 3, pitch: 40 + i }, { step: 4 + i * 3, pitch: 52 + i }]);
  }
  const seq = makeSequencer([makeTrack(notes)]);

  const exported = sequencerToMidi(seq);
  assert.equal(exported.notes, 16);
  assert.equal(exported.flattened, 0, 'no glide is the one that gives way');
  assert.equal(exported.sharedChannel, 1, 'the flat note shares — it has nothing to lose');

  const { sequencer } = midiToSequencer(exported.bytes);
  for (const glide of schedule(sequencer).filter((e) => e.pitch < 100)) {
    assert.equal(glide.points.length, 2, `pitch ${glide.pitch} kept both points`);
    assert.equal(glide.points[1].pitch, glide.pitch + 12, 'and reaches where it was going');
  }
});

test('a note in front of a glide takes it away, and the loss is declared', () => {
  // The case the ordering cannot save: a flat note that starts BEFORE the glide
  // it has to share with. A reader tells the channel's owner by who arrived
  // first, so the glide has to be given up — never silently.
  // Two flat notes of ONE pitch spanning a run of later glides, so neither the
  // channels nor the master can take the second one without displacing a glide.
  const notes: Point[][] = [
    [{ step: 0, pitch: 100 }, { step: 60, pitch: 100 }],
    [{ step: 0, pitch: 100 }, { step: 60, pitch: 100 }],
  ];
  for (let i = 0; i < 15; i += 1) {
    notes.push([{ step: 2 + i * 3, pitch: 40 + i }, { step: 4 + i * 3, pitch: 52 + i }]);
  }
  const exported = sequencerToMidi(makeSequencer([makeTrack(notes)]));
  assert.equal(exported.notes, 17, 'every note is written');
  assert.equal(exported.dropped, 0, 'nothing is thrown away to save a glide');
  assert.equal(exported.flattened, 1, 'exactly one glide gave way, and it is counted');
});

// ------------------------------------------------------------------- splitting

test('splitting puts the parts in as few files as their polyphony needs', async () => {
  const { splitSequencerToMidi } = await import('../src/midi.ts');
  // Two parts of ten simultaneous notes each: twenty at once is over a zone's
  // fifteen, ten is not, so they belong in one file each and no note shares.
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);

  // ❗ One file DOES hold twenty at once, on two tracks -- which is only true
  // for a reader that gives each track its own instrument. Splitting is for the
  // reader that does not: separate files, so the parts never meet whatever
  // plays them.
  const whole = sequencerToMidi(seq);
  assert.equal(whole.sharedChannel, 0);

  const split = splitSequencerToMidi(seq);
  assert.equal(split.files.length, 2);
  assert.equal(split.notes, whole.notes, 'and every note is still written');
  assert.equal(split.sharedChannel, 0, 'with nothing left sharing');
  assert.ok(split.files.every((f) => /\.mid$/.test(f.name)));
});

test('a song that fits stays one file, and keeps the plain name', async () => {
  const { splitSequencerToMidi } = await import('../src/midi.ts');
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { name: 'Small Song' });
  const split = splitSequencerToMidi(seq);
  assert.equal(split.files.length, 1);
  assert.equal(split.files[0].name, 'Small Song.mid');
});

test('every file of a split imports on its own', async () => {
  const { splitSequencerToMidi } = await import('../src/midi.ts');
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)], { tempo: 137, numChannels: 2 });
  const split = splitSequencerToMidi(seq);
  let notes = 0;
  for (const file of split.files) {
    const imported = midiToSequencer(file.result.bytes);
    assert.equal(imported.ours, true, `${file.name} carries the header`);
    assert.equal(imported.sequencer.tempo, 137, 'every file knows the tempo');
    assert.equal(imported.sequencer.numChannels, 2, 'and the mixer');
    notes += imported.notes;
  }
  assert.equal(notes, 20, 'and between them they hold the whole song');
});

test('a zip of the split reads back as the files that went in', async () => {
  const { writeZip, crc32 } = await import('@lbptracker/cwlib/archives/zip.ts');
  const one = Uint8Array.of(1, 2, 3, 4, 5);
  const two = new Uint8Array(1000).fill(0x41);
  const zip = writeZip([{ name: 'one.mid', bytes: one }, { name: 'two.mid', bytes: two }]);

  // Read it the way an unzipper does: the central directory is the index.
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  assert.equal(view.getUint16(end + 8, true), 2, 'two entries');
  let at = view.getUint32(end + 16, true);
  const found: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < 2; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    // The local header repeats the name and the sizes; both copies must agree.
    assert.equal(view.getUint32(offset, true), 0x04034b50, `${name} local header`);
    assert.equal(view.getUint32(offset + 18, true), size, `${name} size agrees`);
    assert.equal(view.getUint32(offset + 14, true), crc, `${name} crc agrees`);
    const from = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const bytes = zip.subarray(from, from + size);
    assert.equal(crc32(bytes), crc, `${name} contents match their checksum`);
    found.push({ name, bytes });
    at += 46 + nameLen;
  }
  assert.deepEqual(found.map((f) => f.name), ['one.mid', 'two.mid']);
  assert.deepEqual([...found[0].bytes], [...one]);
  assert.equal(found[1].bytes.length, 1000);
});

test('every part gets all fifteen member channels, in one file', () => {
  // ⚠️ The point a DAW makes true: a file's tracks share one set of sixteen
  // channels, but Reaper — and anything else that lands one project track per
  // MIDI track — hands each track its own instrument, and that instrument sees
  // only its own track's events. There the parts never meet.
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);

  const split = sequencerToMidi(seq);
  assert.equal(split.sharedChannel, 0, 'ten and ten fit, one part to a track');
  assert.equal(split.notes, 20);

  // Both parts really are using the same channel numbers — that is the trade.
  const used = new Map<number, Set<number>>();
  for (const [index, track] of readMidi(split.bytes).tracks.entries()) {
    for (const e of track.events) {
      if ((e.data[0] & 0xf0) !== 0x90 || e.data[2] === 0) continue;
      const set = used.get(index) ?? new Set<number>();
      set.add(e.data[0] & 0x0f);
      used.set(index, set);
    }
  }
  const [a, b] = [...used.values()];
  assert.ok([...a].some((ch) => b.has(ch)), 'the two parts overlap on channel numbers');
});

test('a per-part file still reads back correctly here', () => {
  // This importer reads each MIDI track on its own, which is exactly what a DAW
  // does — so a file written this way round-trips even though a single-stream
  // player would hear the parts collide.
  const part = (row: number, base: number) =>
    makeTrack(
      [
        ...Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
        [{ step: 2, pitch: base }, { step: 10, pitch: base + 7 }],
      ],
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);
  const exported = sequencerToMidi(seq);
  assert.equal(exported.flattened, 0, 'and no glide had to be given up');
  const { sequencer } = midiToSequencer(exported.bytes);
  assert.deepEqual(music(sequencer), music(seq));
});

test('a track is named after its instrument when the level does not name it', () => {
  // ⚠️ `PInstrument` carries no name worth printing: `Track.name` is empty on
  // every placement of all 22 corpus levels. Without a resolver the file calls
  // every track `guid 148321` and a DAW is unreadable.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { name: '', guid: 148321 })]);

  const bare = readMidi(sequencerToMidi(seq).bytes);
  const named = readMidi(
    sequencerToMidi(seq, {
      instrumentName: (guid) => (guid === 148321 ? 'baiyon_drums_1' : undefined),
    }).bytes,
  );
  const names = (file: ReturnType<typeof readMidi>) =>
    file.tracks.flatMap((t) => t.events).map(metaString).filter((m) => m?.type === 0x03).map((m) => m?.text);

  assert.ok(names(bare).includes('row 0 - guid 148321'), 'the GUID is the fallback, not the goal');
  assert.ok(names(named).includes('row 0 - baiyon_drums_1'));
  // And the GUID still says what to play, whatever the label reads.
  const back = midiToSequencer(
    sequencerToMidi(seq, { instrumentName: () => 'baiyon_drums_1' }).bytes,
  );
  assert.equal(back.sequencer.tracks[0].guid, 148321);
});

test('the board cells come back, because the file remembers them', () => {
  // ⚠️ Clips of one part overlap heavily — a cell is 16 steps apart and a clip
  // holds 128 — so a note two cells could hold is genuinely ambiguous, and the
  // last cell that can hold it is the answer taken. What matters is that the
  // cells themselves are the author's and not a fresh greedy cut.
  const at = (gridX: number, pitch: number) =>
    makeTrack([[{ step: 0, pitch }, { step: 3, pitch }]], {
      gridX, stepOffset: gridX * STEPS_PER_CELL, gridY: 2, guid: 77,
    });
  const seq = makeSequencer([at(0, 60), at(9, 62), at(23, 64), at(40, 65)]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  assert.deepEqual(
    sequencer.tracks.map((t) => t.gridX).sort((a, b) => a - b),
    [0, 9, 23, 40],
    'the same cells, not a re-cut on multiples of eight',
  );
  for (const track of sequencer.tracks) {
    assert.equal(track.stepOffset, track.gridX * STEPS_PER_CELL);
    assert.equal(track.gridY, 2, 'and the row it was on');
  }
  assert.deepEqual(music(sequencer), music(seq));
});

test('a file with no cells to go on is still cut into legal clips', () => {
  // A DAW's file has no `LBP-TRK`, so there is nothing to restore; what it must
  // not do is write a step field that does not fit in seven bits.
  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: Array.from({ length: 40 }, (_, i) => [
        { tick: i * 120 * 10, data: Uint8Array.of(0x90, 60 + (i % 12), 100) },
        { tick: i * 120 * 10 + 600, data: Uint8Array.of(0x80, 60 + (i % 12), 64) },
      ]).flat(),
    }],
  });
  const result = midiToSequencer(bytes);
  assert.ok(result.clips > 1, `a 400-step part needs several clips, got ${result.clips}`);
  for (const track of result.sequencer.tracks) {
    assert.equal(track.stepOffset % STEPS_PER_CELL, 0, 'clips start on a cell');
    for (const note of track.notes) assert.ok(note.endStep <= 127, 'and stay inside seven bits');
  }
  assert.equal(result.dropped, 0);
});

test('a clip length tells overlapping clips apart', () => {
  // ⚠️ Cells alone are not enough: clips of one part overlap — a cell is 16
  // steps and a clip may hold 128 — so on the cells alone 86.50% of the
  // corpus's notes fit more than one clip. With each clip's own extent as
  // well it is 0.09%.
  //
  // Here the clip at cell 0 is four steps long and the one at cell 1 is
  // twenty. A note at step 18 fits only the second — but on cells alone it
  // would fit both, and the first is the one the old rule would have taken.
  const short = makeTrack([[{ step: 0, pitch: 60 }, { step: 3, pitch: 60 }]], {
    gridX: 0, stepOffset: 0, gridY: 1, guid: 5,
  });
  const long = makeTrack(
    [[{ step: 2, pitch: 64 }, { step: 19, pitch: 64 }]],
    { gridX: 1, stepOffset: STEPS_PER_CELL, gridY: 1, guid: 5 },
  );
  const seq = makeSequencer([short, long]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const cells = sequencer.tracks
    .map((t) => ({ x: t.gridX, notes: t.notes.length }))
    .sort((a, b) => a.x - b.x);
  assert.deepEqual(cells, [{ x: 0, notes: 1 }, { x: 1, notes: 1 }], 'one note each, as written');
  assert.deepEqual(music(sequencer), music(seq));
});

test('a clip with no notes at all still comes back', () => {
  // ⚠️ 52 placements across the corpus hold nothing — an instrument dropped on
  // the board and never written in. There is nothing in a MIDI file to bring
  // one back except the cell list, so the importer emits every declared cell
  // whether or not anything landed in it.
  const empty = makeTrack([], { gridX: 154, stepOffset: 154 * STEPS_PER_CELL, gridY: 2, guid: 148321 });
  const played = makeTrack([[{ step: 0, pitch: 60 }]], {
    gridX: 3, stepOffset: 3 * STEPS_PER_CELL, gridY: 2, guid: 148321,
  });
  const seq = makeSequencer([empty, played]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  assert.deepEqual(
    sequencer.tracks.map((t) => [t.gridX, t.notes.length]).sort((a, b) => a[0] - b[0]),
    [[3, 1], [154, 0]],
    'both cells, and the empty one is still empty',
  );
});

test('a part too polyphonic for one zone is split across tracks, and merged back', async () => {
  const { readMidi: read } = await import('../src/smf.ts');
  // ⚠️ Twenty notes of one part gliding at once. Fifteen member channels is
  // the ceiling, so five of them have nowhere to go — 825 notes across the
  // corpus lost a glide exactly here, and the two-pass allocator cannot help
  // when every note wants a channel of its own. Two tracks give the part thirty
  // channels, and a DAW plays them on two instances of the same instrument,
  // which is the same sound.
  const notes: Point[][] = [];
  for (let i = 0; i < 20; i += 1) {
    notes.push([{ step: 0, pitch: 40 + i }, { step: 15, pitch: 52 + i }]);
  }
  const seq = makeSequencer([makeTrack(notes, { guid: 7, gridY: 3 })]);

  const split = sequencerToMidi(seq, { instrumentName: () => 'saw_wave' });
  assert.equal(split.flattened, 0, 'two lanes hold twenty glides where one cannot');
  assert.equal(split.dropped, 0);
  assert.equal(split.parts, 1, 'and it is still reported as one part');

  const file = read(split.bytes);
  const named = file.tracks
    .flatMap((t) => t.events)
    .map(metaString)
    .filter((m) => m?.type === 0x03)
    .map((m) => m?.text);
  assert.ok(named.includes('row 3 - saw_wave (1)'), `lanes are named: ${named.join(', ')}`);
  assert.ok(named.includes('row 3 - saw_wave (2)'));

  // And they come back as one placement, with the glide intact.
  const { sequencer } = midiToSequencer(split.bytes);
  assert.equal(sequencer.tracks.length, 1, 'the lanes merged back into one clip');
  assert.equal(sequencer.tracks[0].gridY, 3, 'on the row the label named, not a lane');
  assert.deepEqual(music(sequencer), music(seq));
});

test('every one of the sixteen modulation values survives CC 74', () => {
  // ⚠️ The modulation is a FOUR-bit field riding on a seven-bit controller, so
  // the mapping has to be exact rather than close: `round(k*127/15)` back
  // through `round(v/127*15)` must return k for every k, or a round trip
  // returns a nibble one step from the one it was given.
  const notes: Point[][] = [];
  for (let k = 0; k <= 15; k += 1) notes.push([{ step: k * 2, pitch: 60, modulation: k / 15 }]);
  const seq = makeSequencer([makeTrack(notes)]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const got = schedule(sequencer)
    .sort((a, b) => a.step - b.step)
    .map((e) => Math.round(e.modulation * 15));
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('a modulation ramp comes back as a ramp', () => {
  // ⚠️ This was dropped until the engine was read: `sub_0x3930` writes a slide
  // rate for the modulation beside the ones for volume and pitch, so a note
  // that moves it changes its filter, level, LFOs and drive as it sounds. The
  // exporter carried only the opening value, which lost the ramp on all 34,449
  // corpus notes that have one.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 60, modulation: 0 },
      { step: 16, pitch: 60, modulation: 1 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  assert.equal(note.points.length, 2, `expected the two points back, got ${note.points.length}`);
  assert.equal(Math.round(note.points[0].modulation * 15), 0);
  assert.equal(Math.round(note.points[1].modulation * 15), 15);
  assert.equal(note.points[1].step, 16, 'and the ramp still ends where it did');
  // The record's own nibble, which is what the game reads.
  const records = sequencer.tracks[0].notes[0].points;
  assert.deepEqual(records.map((r) => r.timbre & 0x0f), [0, 15]);
});

test('a modulation that holds still writes no extra points', () => {
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 48, modulation: 0.4 },
      { step: 8, pitch: 60, modulation: 0.4 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  assert.equal(note.points.length, 2, 'the glide, and nothing the modulation added');
  for (const p of note.points) assert.equal(Math.round(p.modulation * 15), 6);
});

test('a glide into a coincident pair keeps the glide', () => {
  // ⚠️ The last two notes in the corpus whose curve the round trip could not
  // explain, both in `Diode`: a dive from 68 down to 37 over two steps that
  // snaps back to 68 in the same instant it arrives. Coincident points collapse
  // to the later value — the engine's `t = span > 0 ? … : 1` — but collapsing
  // one mid-note dropped the record the ramp before it was aiming at, and the
  // dive came out flat.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 68 },
      { step: 2, pitch: 37 },
      { step: 2, pitch: 68 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  const low = Math.min(...note.points.map((p) => p.pitch));
  assert.ok(low < 50, `the dive is there: ${JSON.stringify(note.points.map((p) => [p.step, p.pitch]))}`);
  assert.equal(note.points[note.points.length - 1].pitch, 68, 'and it still snaps back');

  // ⚠️ **It reaches 42, not 37, and that is the closest anything can hear.**
  // The 37 exists only at the instant the pair supersedes it, so no sampler --
  // ours or the engine's -- ever reads it; the deepest value that sounds is the
  // ramp a third of a step earlier. The reconstruction aims its ramp at that
  // instead, which leaves the curve out by at most **a sixth of a semitone**.
  // That is the 0.167 the corpus check reports as its worst pitch deviation:
  // this case is where it comes from.
  const before = music(seq)[0].samples;
  const after = music(sequencer)[0].samples;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.ok(
      Math.abs(after[i][0] - before[i][0]) <= 1 / 6 + 1e-9,
      `third ${i}: ${after[i][0]} against ${before[i][0]}`,
    );
    assert.equal(after[i][1], before[i][1], `volume at third ${i}`);
  }
});

test('a coincident pair at the note’s start keeps both pitches', () => {
  // The other half: a pair at position 0 writes both its samples onto the
  // note-on's own tick, where they are skipped, so that one collapses on the
  // way out and is rebuilt from the opening bend on the way in.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 17 }, { step: 0, pitch: 16 }, { step: 4, pitch: 16 }]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const points = sequencer.tracks[0].notes[0].points;
  assert.equal(points[0].pitch, 17, 'the key that was struck');
  assert.equal(points[1].pitch, 16, 'and where it went in the same instant');
});

test('a ramp that ends where another note starts keeps its last value', () => {
  // ⚠️ Both halves of one trap, on one channel. The exporter writes every
  // note's opening modulation immediately before its note-on, so a newcomer's
  // CC 74 must not join the ramp of whoever owns the channel — but it is the
  // LAST CC 74 before the note-on that belongs to the newcomer, not every one
  // at that tick. Excluding the whole tick threw away the owner's own final
  // sample whenever a note happened to start on the instant its ramp ended:
  // three notes in `Orb` and `Blackfire` stopped one step short.
  const on = (tick: number, ch: number, note: number, vel: number) =>
    ({ tick, data: Uint8Array.of(0x90 | ch, note, vel) });
  const off = (tick: number, ch: number, note: number) =>
    ({ tick, data: Uint8Array.of(0x80 | ch, note, 64) });
  const cc = (tick: number, ch: number, n: number, v: number) =>
    ({ tick, data: Uint8Array.of(0xb0 | ch, n, v) });

  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: [
        // An MPE zone, so the reader routes by channel owner.
        cc(0, 0, 101, 0), cc(0, 0, 100, 6), cc(0, 0, 6, 15),
        cc(0, 1, 74, 127), on(0, 1, 60, 100),
        cc(480, 1, 74, 20),      // the owner's ramp, arriving
        cc(480, 1, 74, 127),     // and the newcomer's own opening, right behind
        on(480, 1, 64, 100),
        off(720, 1, 64),
        off(960, 1, 60),
      ],
    }],
  });

  const { sequencer } = midiToSequencer(bytes);
  const notes = schedule(sequencer).sort((a, b) => a.pitch - b.pitch);
  const owner = notes.find((n) => n.pitch === 60);
  const newcomer = notes.find((n) => n.pitch === 64);
  assert.ok(owner && newcomer);

  // 20/127 lands on nibble 2; the ramp has to arrive there rather than stop short.
  assert.equal(Math.round(owner.points[0].modulation * 15), 15, 'the owner opens full');
  assert.equal(
    Math.round(owner.points[owner.points.length - 1].modulation * 15),
    2,
    `the owner's ramp arrives: ${JSON.stringify(owner.points.map((p) => Math.round(p.modulation * 15)))}`,
  );
  // And the newcomer keeps its own, rather than inheriting the ramp it landed on.
  assert.equal(Math.round(newcomer.modulation * 15), 15, 'the newcomer keeps its own');
});
