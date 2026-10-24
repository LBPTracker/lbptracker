/**
 * The editor's model and its boundary with the file's records.
 *
 * `encodeNotes` is tested here rather than in `cwlib` for the reason
 * `notes.test.ts` gives: the corpus check below needs the level reader, and
 * the model that drives the encoder lives in this package.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CHIP_COLOUR, factoryColour } from '@lbptracker/cwlib/sequencer/chips.ts';
import { decodeRecords, encodeNotes, readNotes, type WriteNote } from '@lbptracker/cwlib/sequencer/notes.ts';
import { readLevelProject, type Track } from '@lbptracker/cwlib/sequencer/project.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';

import {
  addClip,
  addNote,
  addRow,
  addPoint,
  clampClipShift,
  clipsAnchor,
  clipsCollide,
  clipsEndCell,
  duplicateClip,
  duplicateClips,
  freeClipShift,
  moveClips,
  clipStepsFor,
  movePoint,
  lastThirds,
  movePoints,
  pointShiftLimits,
  moveNote,
  newSong,
  removePoint,
  removeRow,
  resizeClip,
  sequencerFromSong,
  setSongEnd,
  songEndSteps,
  NEW_SONG_END_STEPS,
  songFromJson,
  songFromSequencer,
  songToJson,
  trackFromClip,
} from '../src/song.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';

const point = (
  step: number,
  pitch: number,
  over: Partial<WriteNote['points'][number]> = {},
): WriteNote['points'][number] => ({ step, subStep: 0, pitch, volume: 96, timbre: 0, ...over });

// ------------------------------------------------------------ encodeNotes

test('encodeNotes writes the measured order: position, then pitch descending, then the end', () => {
  const bytes = encodeNotes([
    { points: [point(4, 60), point(7, 60)] }, // longer, same pitch as the next
    { points: [point(4, 60), point(5, 60)] }, // shorter -> first of the two
    { points: [point(4, 72)] }, // higher -> first at step 4
    { points: [point(0, 48)] }, // earliest
  ]);
  const notes = readNotes(bytes).notes;
  assert.deepEqual(
    notes.map((n) => [n.startStep, n.points[0].pitch, n.endStep]),
    [
      [0, 48, 0],
      [4, 72, 4],
      [4, 60, 5],
      [4, 60, 7],
    ],
  );
  assert.equal(readNotes(bytes).trailing.length, 0);
});

test('encodeNotes packs the sub-step and the resting bit the way the engine reads them', () => {
  const bytes = encodeNotes(
    [{ points: [point(2, 60, { subStep: 0 }), point(2, 60, { subStep: 1 }), point(3, 62, { subStep: 2, timbre: 15 })] }],
    1,
  );
  const records = decodeRecords(bytes);
  assert.deepEqual(records.map((r) => [r.step, r.subStep, r.end]), [[2, 0, false], [2, 1, false], [3, 2, true]]);
  // Bit 6 of byte 3: set at rest (rest = 1), clear at sub-step 1, set at sub-step 2.
  assert.equal(bytes[3] & 0x40, 0x40, 'the resting bit is written on an inert record');
  assert.equal(bytes[7] & 0x40, 0, 'sub-step 1 needs the bit clear');
  assert.equal(bytes[11] & 0x40, 0x40, 'sub-step 2 needs it set');
  assert.equal(bytes[11] & 0x0f, 15, 'the nibble is the timbre');
  assert.equal(records[2].modulation, 1);

  const cleared = encodeNotes([{ points: [point(0, 60)] }], 0);
  assert.equal(cleared[3] & 0x40, 0, 'rest = 0 leaves an inert record clear');
});

test('encodeNotes clamps to the record grid rather than wrapping', () => {
  const bytes = encodeNotes([{ points: [point(0, 200, { volume: 300, timbre: 99 })] }]);
  const [r] = decodeRecords(bytes);
  assert.equal(r.pitch, 127);
  assert.equal(r.volume, 127);
  assert.equal(r.timbre & 0x0f, 15);
});

// ------------------------------------------------------------------ the model

test('a song round-trips through a sequencer and through JSON', () => {
  const song = newSong('test');
  song.author = 'Festerd_Jester';
  song.tempo = 150;
  song.swing = 0.25;
  song.numChannels = 2;
  song.boardRows = 6;
  const clip = addClip(song, { cell: 3, row: 2 }, 129085, 'lead');
  clip.colour = 0xffff00ff | 0;
  clip.key = 14;
  clip.scale = 3;
  clip.level = 0.7;
  clip.pan = 0.25;
  clip.echoSend = 0.5;
  clip.reverbSend = 0.3;
  const held = addNote(song, clip, { thirds: 3, pitch: 60, volume: 100, timbre: 4 });
  addPoint(clip, held, 12); // a held note: two points
  const bend = addNote(song, clip, { thirds: 0, pitch: 72 });
  addPoint(clip, bend, 4);
  movePoint(clip, bend, bend.points[1], { pitch: 79 });
  const triplet = addNote(song, clip, { thirds: 16, pitch: 64 }); // step 5 + 1/3

  const seq = sequencerFromSong(song, 7);
  assert.equal(seq.uid, 7);
  assert.equal(seq.author, 'Festerd_Jester');
  assert.equal(seq.tempo, 150);
  assert.equal(seq.tracks.length, 1);
  const track = seq.tracks[0];
  assert.equal(track.stepOffset, 48);
  assert.equal(track.gridY, 2);
  assert.equal(track.colour, 0xffff00ff | 0);
  assert.equal(track.key, 14);
  assert.equal(track.notes.length, 3);
  // The bend at step 0 comes first, then the held note at step 1, then the triplet.
  assert.deepEqual(
    track.notes.map((n) => [n.startPosition, n.endStep, n.points[0].pitch, n.hasPitchAutomation]),
    [
      [0, 1, 72, true],
      [1, 4, 60, false],
      [5 + 1 / 3, 5, 64, false],
    ],
  );
  assert.equal(seq.lengthSteps, 48 + 5 + 1);
  assert.equal(track.notes[1].points[0].modulation, 4 / 15);

  const back = songFromSequencer(seq);
  assert.equal(back.author, 'Festerd_Jester');
  assert.equal(back.tempo, 150);
  assert.equal(back.swing, 0.25);
  assert.equal(back.clips.length, 1);
  const again = back.clips[0];
  assert.equal(again.cell, 3);
  assert.equal(again.row, 2);
  assert.equal(again.steps, 32);
  assert.equal(again.colour, 0xffff00ff | 0);
  assert.equal(again.rest, 1);
  assert.equal(again.notes.length, 3);
  const flat = (c: typeof clip) =>
    c.notes
      .map((n) => n.points.map((p) => [p.thirds, p.pitch, p.volume, p.timbre]))
      .sort((a, b) => a[0][0] - b[0][0] || b[0][1] - a[0][1]);
  assert.deepEqual(flat(again), flat(clip));

  const text = songToJson(back);
  const parsed = songFromJson(text);
  assert.deepEqual(flat(parsed.clips[0]), flat(clip));
  assert.equal(parsed.clips[0].key, 14);
  assert.equal(parsed.clips[0].colour, 0xffff00ff | 0, 'the chip keeps its tint through the file');
  assert.equal(parsed.boardRows, 6);
  assert.equal(parsed.author, 'Festerd_Jester', 'and through the song file');
  assert.equal(newSong().author, '', 'a new song names nobody');
  assert.throws(() => songFromJson('{"format":"something else"}'), /not an LBP Tracker song/);

  void triplet;
});

test('points stay in order and inside the clip; a note goes with its last point', () => {
  const song = newSong();
  const clip = addClip(song, { cell: 0, row: 0 }, 129085);
  const note = addNote(song, clip, { thirds: 30, pitch: 60 });
  addPoint(clip, note, 60);
  const mid = addPoint(clip, note, 45);
  assert.deepEqual(note.points.map((p) => p.thirds), [30, 45, 60]);
  movePoint(clip, note, mid, { thirds: 200 });
  assert.equal(mid.thirds, 60, 'a point cannot pass its neighbour');
  movePoint(clip, note, mid, { thirds: -5 });
  assert.equal(mid.thirds, 30);
  movePoint(clip, note, note.points[2], { thirds: 1000, pitch: 500 });
  assert.equal(note.points[2].thirds, 32 * 3 - 1, 'the last position is the clip\'s last third');
  assert.equal(note.points[2].pitch, 127);
  moveNote(clip, note, -100, -100);
  assert.equal(note.points[0].thirds, 0);
  assert.equal(Math.min(...note.points.map((p) => p.pitch)), 0);
  assert.equal(note.points[2].thirds - note.points[0].thirds, 95 - 30, 'a shifted note keeps its shape');

  assert.equal(resizeClip(clip, 48), true);
  assert.equal(clip.steps, 48);
  moveNote(clip, note, 1000, 0);
  assert.equal(note.points[2].thirds, 48 * 3 - 1);
  assert.equal(resizeClip(clip, 32), false, 'a clip cannot shrink under its notes');
  assert.equal(clip.steps, 48);
  assert.equal(resizeClip(clip, 1000), true);
  assert.equal(clip.steps, 128, 'the ceiling is 16 bars');
  assert.equal(resizeClip(clip, 70), true);
  assert.equal(clip.steps, 64, 'lengths snap to two bars at a time');
  assert.equal(resizeClip(clip, 10), false, 'four bars is the floor, and the notes reach past it');

  removePoint(clip, note, note.points[1]);
  removePoint(clip, note, note.points[0]);
  assert.equal(clip.notes.length, 1);
  removePoint(clip, note, note.points[0]);
  assert.equal(clip.notes.length, 0, 'the note went with its last point');
});

test('the end of the song: the last chip, or further when dragged there, in whole cells', () => {
  const song = newSong();
  assert.equal(songEndSteps(song), NEW_SONG_END_STEPS, 'a new song has room laid out before its first chip');
  const clip = addClip(song, { cell: 3, row: 0 }, 129085);
  assert.equal(songEndSteps(song), 3 * 16 + 32, 'a chip past that end carries the end along');
  setSongEnd(song, 100);
  assert.equal(song.endSteps, 96, 'snapped to a cell');
  assert.equal(songEndSteps(song), 96);
  setSongEnd(song, 40);
  assert.equal(song.endSteps, 0, 'dragged back to the last chip, it is the last chip again');
  assert.equal(songEndSteps(song), 80);
  setSongEnd(song, 200);
  const back = songFromJson(songToJson(song));
  assert.equal(back.endSteps, 208, 'the end survives the file: 200 rounds to 13 cells');
  void clip;
});

test('rows: one more at the bottom; a removed row takes its chips and closes the gap', () => {
  const song = newSong();
  song.boardRows = 3;
  const a = addClip(song, { cell: 0, row: 0 }, 1);
  const b = addClip(song, { cell: 1, row: 1 }, 1);
  const c = addClip(song, { cell: 2, row: 2 }, 1);
  assert.equal(addRow(song), true);
  assert.equal(song.boardRows, 4);
  assert.equal(removeRow(song, 1), 1);
  assert.equal(song.boardRows, 3);
  assert.deepEqual(song.clips.map((x) => [x.id, x.row]), [[a.id, 0], [c.id, 1]]);
  assert.equal(removeRow(song, 3), -1, 'no such row');
  assert.equal(removeRow(song, 2), 0, 'an empty row goes too');
  assert.equal(song.boardRows, 2);
  assert.equal(removeRow(song, 0), 1);
  assert.deepEqual(song.clips.map((x) => [x.id, x.row]), [[c.id, 0]]);
  assert.equal(song.boardRows, 1);
  assert.equal(removeRow(song, 0), -1, 'the last row stays');
  void b;
});

test('a new chip wears the colour its instrument comes with, and a copy the chip has', () => {
  const song = newSong();
  // ✔ The factory colours, out of the game's own popit plans (`chips.ts`): the
  // percussion family's green, the synth family's sky blue, and the fallback
  // for an instrument the game has not got.
  assert.equal(addClip(song, { cell: 0, row: 0 }, 129031).colour, 0x40ff0100);
  assert.equal(addClip(song, { cell: 1, row: 0 }, 129085).colour, DEFAULT_CHIP_COLOUR);
  assert.equal(addClip(song, { cell: 2, row: 0 }, 999999).colour, DEFAULT_CHIP_COLOUR);
  // ⚠️ **Signed, like the field in the file.** The table spells the colours
  // unsigned because they read better that way, and a placement's own comes
  // out of `s.i32()`; comparing the two called every red, magenta, yellow and
  // white chip in the corpus "tinted" until `factoryColour` normalised.
  assert.equal(addClip(song, { cell: 4, row: 0 }, 125100).colour, 0xff0000ff | 0);
  assert.equal(factoryColour(125100) < 0, true);
  const tinted = addClip(song, { cell: 3, row: 0 }, 129031);
  tinted.colour = 0xff00ffff | 0;
  assert.equal(duplicateClip(song, tinted, { cell: 5, row: 0 }).colour, 0xff00ffff | 0);
});

test('clipStepsFor: four bars by default, then two more at a time, never past 128', () => {
  assert.equal(clipStepsFor(-1), 32);
  assert.equal(clipStepsFor(0), 32);
  assert.equal(clipStepsFor(31), 32);
  assert.equal(clipStepsFor(32), 48);
  assert.equal(clipStepsFor(47), 48);
  assert.equal(clipStepsFor(48), 64);
  assert.equal(clipStepsFor(63), 64);
  assert.equal(clipStepsFor(127), 128);
  assert.equal(clipStepsFor(500), 128);
});

// ---------------------------------------------------------------- the corpus

/**
 * Opening a level's tracks and writing them back reproduces the file's own
 * bytes on nearly every clip -- the order keys are measured at 99.43% on the
 * first and 100% on the ties, and the resting bit is uniform on all but 31 of
 * 62,106 clips. Anything under 98% means the encoder has drifted from the
 * measurement.
 */
test('the corpus survives songFromSequencer -> trackFromClip byte for byte, nearly everywhere', async (t) => {
  if (!existsSync(LEVELS)) {
    t.skip(`no ${LEVELS} — set LBP_LEVELS to a directory of levels`);
    return;
  }
  let clips = 0;
  let same = 0;
  let sameNotes = 0;
  const differing: string[] = [];
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const level = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
    for (const seq of level.sequencers) {
      const song = songFromSequencer(seq);
      assert.equal(song.clips.length, seq.tracks.length);
      seq.tracks.forEach((track: Track, i) => {
        const back = trackFromClip(song.clips[i]);
        clips += 1;
        if (Buffer.compare(Buffer.from(back.records), Buffer.from(track.records)) === 0) same += 1;
        else if (differing.length < 5) differing.push(`${entry.name}#${seq.uid} cell ${track.gridX}`);
        // Whatever the bytes did, the music must be the same: same notes at the
        // same places with the same values.
        const flat = (tr: Track) =>
          tr.notes
            .map((n) => n.points.map((p) => [p.step, p.subStep, p.pitch, p.volume, p.timbre & 0x0f].join(':')).join(' '))
            .sort()
            .join('|');
        if (flat(back) === flat(track)) sameNotes += 1;
      });
    }
  }
  console.log(`    ${clips} clips: ${same} byte-identical, ${sameNotes} note-identical; e.g. ${differing.join(', ')}`);
  assert.ok(clips > 1000, 'the corpus was read');
  assert.equal(sameNotes, clips, 'every clip plays the same notes after a round trip');
  assert.ok(same / clips >= 0.98, `${same} of ${clips} byte-identical`);
});

test('a set of a note’s points moves as one, with the unselected ones as its walls', () => {
  const song = newSong();
  const clip = addClip(song, { cell: 0, row: 0 }, 129085);
  const note = addNote(song, clip, { thirds: 0, pitch: 60 });
  for (const t of [6, 12, 18]) addPoint(clip, note, t);
  const at = () => note.points.map((p) => `${p.thirds}/${p.pitch}`).join(' ');
  assert.equal(at(), '0/60 6/60 12/60 18/60');

  // The tail alone: it may not pass the point before it, and the clip's end
  // is the wall on the other side.
  const tail = pointShiftLimits(clip, note, [2, 3]);
  assert.equal(tail.minThirds, -6, 'point 2 stops on point 1');
  assert.equal(tail.maxThirds, lastThirds(clip) - 18, 'point 3 stops at the end of the grid');

  movePoints(clip, note, [2, 3], 6, 4);
  assert.equal(at(), '0/60 6/60 18/64 24/64', 'the two moved together, the head stayed');

  // ⚠️ The bug this exists for: clamping each point against its immediate
  // neighbour pins a group, because the neighbour has not moved yet.
  movePoints(clip, note, [2, 3], -6, 0);
  assert.equal(at(), '0/60 6/60 12/64 18/64', 'and back, rather than jamming on each other');

  // A run that would pass a wall is taken as far as it can go, not dropped.
  movePoints(clip, note, [2, 3], -99, 0);
  assert.equal(at(), '0/60 6/60 6/64 12/64', 'point 2 lands on point 1 and stops');
});

test('a block of chips moves as one, stays on the board, and copies onto free cells', () => {
  const song = newSong();
  song.boardRows = 4;
  const a = addClip(song, { cell: 1, row: 1 }, 1);
  const b = addClip(song, { cell: 3, row: 2 }, 2);
  const other = addClip(song, { cell: 6, row: 1 }, 3);
  addNote(song, a, { thirds: 6, pitch: 60 });
  assert.deepEqual(clipsAnchor([a, b]), { cell: 1, row: 1 });
  assert.deepEqual(clipsAnchor([]), { cell: 0, row: 0 });
  assert.equal(clipsEndCell([a, b]), 5, 'a four-bar chip at cell 3 ends at cell 5');
  // Clamped to the board: never before cell 0, never above row 0 or below the last row.
  assert.deepEqual(clampClipShift([a, b], { cells: -5, rows: -3 }, 4), { cells: -1, rows: -1 });
  assert.deepEqual(clampClipShift([a, b], { cells: 2, rows: 5 }, 4), { cells: 2, rows: 1 });
  assert.deepEqual(
    clampClipShift([a, b], { cells: 0, rows: 0 }, 1), { cells: 0, rows: -1 },
    'taller than the board: the top row stays on it',
  );
  // The game's board is 500 cells wide: a four-bar chip, two cells, is anchored no further than 498.
  assert.deepEqual(clampClipShift([a, b], { cells: 900, rows: 0 }, 4), { cells: 495, rows: 0 });
  assert.deepEqual(moveClips(song, [a.id, b.id], { cells: -3, rows: 1 }), { cells: -1, rows: 1 });
  assert.deepEqual([a.cell, a.row, b.cell, b.row], [0, 2, 2, 3]);
  assert.deepEqual([other.cell, other.row], [6, 1], 'a chip outside the block stays');
  // The block's own chips are not in its way; another one is.
  assert.equal(clipsCollide(song, [a, b], { cells: 0, rows: 0 }, new Set([a.id, b.id])), false);
  assert.equal(clipsCollide(song, [a, b], { cells: 0, rows: 0 }), true);
  assert.deepEqual(
    freeClipShift(song, [a, b], { cells: 6, rows: -1 }), { cells: 7, rows: -1 },
    'a would land on the other chip at (6, 1): one cell further',
  );
  const copies = duplicateClips(song, [a, b], { cells: 7, rows: -1 });
  assert.deepEqual(copies.map((c) => [c.cell, c.row, c.guid]), [[7, 1, 1], [9, 2, 2]]);
  assert.equal(song.clips.length, 5);
  assert.equal(new Set(song.clips.map((c) => c.id)).size, 5, 'fresh ids');
  assert.deepEqual(copies[0].notes.map((n) => n.points), a.notes.map((n) => n.points), 'the notes come along');
  assert.notEqual(copies[0].notes[0].id, a.notes[0].id);
});
