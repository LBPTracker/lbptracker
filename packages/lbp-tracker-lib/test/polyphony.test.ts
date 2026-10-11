import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  VOICES_UNLIMITED,
  VOICE_POOL_SIZE,
  allocateVoices,
  LiveVoicePool,
  scoreAt,
  walkVelocities,
  type PooledNote,
} from '../src/polyphony.ts';

const note = (start: number, end: number, score = 0.5): PooledNote => ({ start, end, score });

test('the pool is the engine’s 32 records', () => {
  assert.equal(VOICE_POOL_SIZE, 32);
});

test('notes that fit the pool are untouched', () => {
  const notes = Array.from({ length: 32 }, () => note(0, 100));
  const out = allocateVoices(notes);
  assert.ok(out.every((r) => r.end === 100), 'nothing is stolen while a record is free');
});

test('the 33rd note steals the quietest, not the oldest', () => {
  // Thirty-two held notes, one of them markedly quieter than the rest.
  const notes = Array.from({ length: 32 }, (_, i) => note(0, 100, i === 7 ? 0.1 : 0.9));
  notes.push(note(50, 150, 0.9));
  const out = allocateVoices(notes);
  assert.equal(out[7].end, 50, 'the quiet one is cut at the moment of the theft');
  assert.equal(out[0].end, 100, 'the oldest survives -- this is not round-robin');
  assert.equal(out[32].end, 150);
});

test('a freed record is preferred over any theft', () => {
  const notes = Array.from({ length: 32 }, (_, i) => note(0, i === 3 ? 10 : 100, 0.9));
  notes.push(note(20, 120, 0.9));
  const out = allocateVoices(notes);
  assert.ok(out.every((r, i) => (i === 3 ? r.end === 10 : r.end >= 100)), 'nothing was stolen');
});

test('a pool where every voice scores 1.0 or more loses voice zero', () => {
  // ⚠️ Faithful to 0x1640: the running best starts at 1.0 and the best index at
  // 0, so scores at or above 1.0 never beat it and the search falls through to
  // index 0. Tidying this to "steal the true minimum" would diverge.
  const notes = Array.from({ length: 32 }, (_, i) => note(0, 100, 1 + i));
  notes.push(note(50, 150, 1));
  const out = allocateVoices(notes);
  assert.equal(out[0].end, 50, 'voice 0 goes, even though voice 31 is louder');
  assert.equal(out[31].end, 100);
});

test('the cap can be turned off, which is a UI setting', () => {
  const notes = Array.from({ length: 64 }, () => note(0, 100));
  const capped = allocateVoices(notes);
  assert.ok(capped.some((r) => r.end < 100), 'capped, some are stolen');
  const free = allocateVoices(notes, VOICES_UNLIMITED);
  assert.ok(free.every((r) => r.end === 100), 'uncapped, none are');
});

// ⚠️ THE EQUIVALENCE THE LIVE PLAYER RESTS ON. `allocateVoices` decides the
// voice pool's stealing for a whole song at once; `LiveVoicePool` decides it one
// note at a time so the pool can be changed while a song plays. The moment these
// two disagree, the live player and the renderer are different instruments.
//
// A seeded generator rather than a handful of cases: the interesting failures
// are ties on `start`, ties on `score`, and notes that end exactly where the
// next begins, and those are found by volume rather than by imagination.
test('the incremental pool decides exactly what the offline one decides', () => {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (const poolSize of [1, 2, 4, 32, VOICES_UNLIMITED]) {
    for (let round = 0; round < 40; round += 1) {
      const notes: PooledNote[] = [];
      const count = 5 + Math.floor(rand() * 120);
      for (let i = 0; i < count; i += 1) {
        // Coarse starts and lengths, so ties and exact abutments are common.
        const start = Math.floor(rand() * 24);
        const end = start + Math.floor(rand() * 8);
        // Scores off a short ladder, so ties on score happen constantly --
        // and on most notes a few walks off the same ladder, so a held note's
        // score moves under the notes that arrive while it plays.
        const walked = Array.from({ length: Math.floor(rand() * 4) }, () => Math.floor(rand() * 4) / 4);
        notes.push({
          start,
          end,
          score: Math.floor(rand() * 4) / 4,
          ...(walked.length > 0 ? { walks: { from: start + 1, scores: walked } } : {}),
        });
      }

      const offline = allocateVoices(notes, poolSize);

      // The order `allocateVoices` sorts into, which is the order a scheduler
      // posts in: by start, ties by the order they were added.
      const order = notes
        .map((n, index) => ({ n, index }))
        .sort((a, b) => a.n.start - b.n.start || a.index - b.index);
      const pool = new LiveVoicePool(poolSize);
      const ends = new Map<number, number>();
      for (const { n, index } of order) {
        const { end, stole } = pool.add(index, n);
        ends.set(index, end);
        if (stole) ends.set(stole.index, stole.at);
      }

      for (const row of offline) {
        assert.equal(
          ends.get(row.index),
          row.end,
          `pool ${poolSize}, round ${round}, note ${row.index}`,
        );
      }
    }
  }
});

test('notes starting together are taken in rank order, then input order', () => {
  // On the engine's clock the walk spawns a step's notes from the last clip to
  // the first (`0x0300`), so the render ranks them by negated track index.
  const notes: PooledNote[] = Array.from({ length: 31 }, () => note(0, 100, 0.9));
  notes.push({ start: 10, end: 100, score: 0.2, rank: 0 });
  notes.push({ start: 10, end: 100, score: 0.2, rank: -1 });
  const out = allocateVoices(notes);
  // The rank -1 note goes first and takes the last free record; the rank 0
  // note then steals the quietest, which is that one.
  assert.equal(out[32].end, 10, 'stolen by the note ranked after it');
  assert.equal(out[31].end, 100);
});

// ---------------------------------------------------------------- the walk

/** A record as `walkVelocities` reads it: a position in thirds and a velocity. */
const point = (step: number, third: number, velocity: number) => ({ thirds: 3 * step + third, gain: velocity / 127 });
const near = (actual: readonly number[], expected: readonly number[]) => {
  assert.equal(actual.length, expected.length, `${actual} against ${expected}`);
  actual.forEach((a, i) => assert.ok(Math.abs(a - expected[i]) < 1e-12, `walk ${i}: ${a} against ${expected[i]}`));
};

test('the walk reads the volume ramp at each whole step and stops at the gate', () => {
  // 127 to 0 over four steps from step 10: the walks at 11..14 read the ramp,
  // and the walk at 15 closes the gate (`0x3a4b`) still writing the end's 0.
  near(walkVelocities([point(10, 0, 127), point(14, 0, 0)]), [0.75, 0.5, 0.25, 0, 0]);
  // A one-record note: the walk after the claim closes it.
  near(walkVelocities([point(3, 0, 64)]), [64 / 127]);
});

test('a sub-step record is taken at its whole step’s walk, at its own velocity', () => {
  // 127 at 10, 63.5 at 12⅓, held to 14. At the walk of 12 the record at 12⅓ is
  // already current (`0x3c14`: the playhead is not below its STEP), so +0x0c is
  // its own velocity, not the ramp's 1 - 2/7 · 0.5 between the two.
  const out = walkVelocities([point(10, 0, 127), point(12, 1, 63.5), point(14, 0, 63.5)]);
  assert.ok(Math.abs(out[0] - (1 - 0.5 / (7 / 3))) < 1e-12, 'walk 11 is on the ramp');
  assert.ok(Math.abs(out[1] - 0.5) < 1e-12, 'walk 12 is the sub-step record’s own velocity');
});

test('the cursor moves one record per walk, so three records in a step trail by a walk', () => {
  // Records at 10, 10⅓, 10⅔ and 13. At the walk of 11 the cursor has moved only
  // to 10⅓ (`0x3a66`), whose slide runs to 10⅔ -- already past, so no catch-up
  // (`0x3ea9`) -- and +0x0c is 10⅓'s own 0.5; a sampled ramp would read 1/7.
  near(
    walkVelocities([point(10, 0, 127), point(10, 1, 63.5), point(10, 2, 0), point(13, 0, 127)]),
    [0.5, 4 / 7, 1, 1],
  );
});

test('a held note scores its claim until its first walk, and its last walk after its gate', () => {
  const held: PooledNote = { start: 4, end: 20, score: 0.9, walks: { from: 5, scores: [0.6, 0.3, 0.1] } };
  assert.equal(scoreAt(held, 4), 0.9, 'a note arriving with it meets the claim');
  assert.equal(scoreAt(held, 4 + 2 / 3), 0.9);
  // ❗ The walk at 5 runs before the step's notes are spawned (`0x0eef`, then `0x0f1c`).
  assert.equal(scoreAt(held, 5), 0.6);
  assert.equal(scoreAt(held, 5 - 1e-9), 0.6, 'an ulp under the walk is the walk');
  assert.equal(scoreAt(held, 6 + 1 / 3), 0.3);
  assert.equal(scoreAt(held, 15), 0.1, 'frozen once the gate has closed (`0x395f` → `0x3f06`)');
  assert.equal(scoreAt({ start: 0, end: 9, score: 0.4 }, 7), 0.4, 'no walks, the claim holds');
});

test('a note whose volume falls is stolen as it falls, not at the score it opened with', () => {
  // The shape of C4K3 S0NG at 25.85 s (*29* in steering/open-questions.md):
  // the pool is full of notes at 0.15, one `mime_artist` note claimed at
  // 0.3396 has faded to 0.0266 by the walk, and a note arrives. Scored at its
  // claim the fading note is the dearest thing held and a 0.15 goes instead.
  const notes: PooledNote[] = Array.from({ length: 31 }, () => ({ start: 206, end: 230, score: 0.15 }));
  notes.push({ start: 220, end: 224.5, score: 0.3396, walks: { from: 221, scores: [0.2, 0.1, 0.0266, 0.0266] } });
  notes.push({ start: 224, end: 228, score: 0.375 });
  const out = allocateVoices(notes);
  assert.equal(out[31].end, 224, 'the fading note goes');
  assert.ok(out.slice(0, 31).every((r) => r.end === 230), 'every held note at 0.15 survives');
  const claimed = allocateVoices(notes.map(({ walks: _, ...n }) => n));
  assert.equal(claimed[0].end, 224, 'without its walks the pool steals a 0.15 note');

  const pool = new LiveVoicePool();
  notes.forEach((n, i) => {
    const { stole } = pool.add(i, n);
    if (i === 32) assert.deepEqual(stole, { index: 31, at: 224 });
  });
});
