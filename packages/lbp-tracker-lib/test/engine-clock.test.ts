import { strict as assert } from 'node:assert';
import test from 'node:test';

import { engineClock } from '../src/engine-clock.ts';

// The frames below are the module's own: `fmodextinput.prx` run through
// `tools/prxrun.py` on song 15843's track 468 (tempo 180, notes on even steps,
// one step long), its output's first non-zero sample one frame after each.

test('a note on a step starts at the top of the chunk after the one that crossed it', () => {
  const clock = engineClock(180, 0, 60000);
  assert.deepEqual(
    [0, 2, 4, 6, 8, 10].map((s) => clock.onsetFrame(s)),
    [256, 8192, 16128, 24064, 32000, 40192],
  );
});

test('the song’s first step waits for the restart’s chunk', () => {
  assert.equal(engineClock(120, 0, 10000).onsetFrame(0), 256);
});

test('a gate is first read closed at the walk of its step', () => {
  const clock = engineClock(180, 0, 60000);
  // Release ends measured at 4608 and 12544: these plus the sine's 347-frame
  // release, rounded up to the chunk.
  assert.equal(clock.gateFrame(1), 4096);
  assert.equal(clock.gateFrame(3), 12032);
});

test('where a step is a whole number of blocks the clock is the tracker’s', () => {
  // 175.78125 bpm is 4096 frames a step: every step after the first lands on
  // its own frame, which is why the synthetic scenes never showed the grid.
  const clock = engineClock(175.78125, 0, 100000);
  for (const step of [1, 3, 4, 6, 9]) assert.equal(clock.onsetFrame(step), step * 4096);
});

test('a sub-step note starts at the top of the chunk its position falls in', () => {
  const clock = engineClock(130, 0, 100000);
  const position = 7 + 1 / 3;
  const onset = clock.onsetFrame(position);
  const exact = clock.frameAt(position);
  assert.ok(onset <= exact, 'up to a chunk early');
  assert.ok(exact - onset < 256);
});

test('a split is a chunk start off the block grid, and a walk can land on one', () => {
  const clock = engineClock(130, 0, 2000000);
  assert.ok(clock.splits.length > 0);
  assert.ok(clock.splits.every((at) => at % 256 !== 0));
  // Song 15853 (130 bpm): step 142's walk is at 786,658, inside a block.
  assert.equal(clock.walkFrame(142), 786658);
  assert.ok(clock.splits.includes(786658));
});

test('a record freed in the chunk that crosses a step is free at that step’s walk', () => {
  const clock = engineClock(130, 0, 2000000);
  // Step 142 is passed at 786,488.45 and walked at 786,658, the end of the
  // chunk holding it: a record freed after that chunk is free at the walk,
  // even from a frame past the step's own.
  assert.ok(clock.frameAt(142) < 786600);
  assert.equal(clock.freedBy(786600), 142);
  assert.equal(clock.freedBy(786657), 142);
  // The next chunk starts at the walk, so it frees for step 143's.
  assert.equal(clock.freedBy(786658), 143);
});

test('the playhead passes a position inside the chunk it falls in', () => {
  const clock = engineClock(130, 0, 2000000);
  // Step 142 is passed at 786,488.45 and walked at the end of that chunk.
  assert.ok(Math.abs(clock.frameAt(142) - 786488.45) < 0.05);
  assert.ok(clock.frameAt(142) < clock.walkFrame(142));
});
