import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  closingWalk,
  detune32,
  engineWalks,
  layerRate32,
  param32,
  ratio32,
  unit32,
} from '../src/engine-record.ts';

// Every expected value below was printed by `fmodextinput.prx` running under
// `tools/prxsynth.py` (POSV, with all five layers), with `rand()` pinned to
// 0x13333333 as the harness pins it: song 281831's opening chords and the
// `gsub` phrase of `packages/lbp-tracker-lib/dev/prx-scene.ts`, 2026-10-11.
const DRAW = 0x13333333 / 2 ** 30;

test('a layer’s detune is the module’s float32, to the bit', () => {
  // `+0x68` of mosquito (Params[0] 0.09) and synth_strings (0.04) at modulation 0.
  assert.equal(detune32(param32({ x: 0.09, y: 0.09 }, 0), unit32(DRAW)), 0.998199999332428);
  assert.equal(detune32(param32({ x: 0.04, y: 0.06 }, 0), unit32(DRAW)), 0.9991999864578247);
});

test('a held note’s float32 rate lands where the module does; a double one drifts', () => {
  // mosquito, pitch 58 on a slot rooted at 72, layer 0 after 189,952 frames:
  // the module's position is 84461.685867.
  const detune = detune32(param32({ x: 0.09, y: 0.09 }, 0), unit32(DRAW));
  const rate = layerRate32(ratio32({ fineTune: 0, root: 72, pitched: true }, 58), detune, 0, 1.885);
  let position = 0;
  for (let i = 0; i < 189952; i += 1) position += rate;
  assert.ok(Math.abs(position - 84461.685867) < 1e-5, `float32: ${position}`);
  const double = 189952 * 2 ** (-14 / 12) * (1 + 0.05 * (0.3 * 0.18 - 0.09));
  assert.ok(Math.abs(double - 84461.685867) > 5e-3, `double: ${double}`);
});

test('an unpitched slot plays at 1 whatever the slide, and a synced one at the tempo ratio', () => {
  assert.equal(ratio32({ fineTune: 0.3, root: 60, pitched: false }, 84), 1);
  assert.equal(ratio32({ fineTune: 0, root: 60, pitched: false, tempoRatio: Math.fround(120 / 149.5) }, 72),
    Math.fround(120 / 149.5));
});

const point = (step: number, subStep: number, pitch: number, velocity = 96, nibble = 0) =>
  ({ step, subStep, pitch, velocity, nibble });

test('the walk writes the values and slides the module printed', () => {
  // `Vision`'s clip 64: 75 at step 29 gliding to 51 at 30, which ends the note.
  const glide = engineWalks([point(29, 0, 75), point(30, 0, 51)], 30);
  assert.deepEqual(glide.map((w) => [w.pitch, w.pitchSlide]), [[75, -24], [51, 0], [51, 0]]);
  // Three records inside step 6: the span is float32 thirds, so the slide the
  // module printed is 35.99998, not 36.
  const bunched = engineWalks([point(6, 0, 48, 100), point(6, 1, 60, 60, 15), point(6, 2, 52, 120, 8), point(8, 0, 48)], 7);
  assert.ok(Math.abs(bunched[0].pitchSlide - 35.99998) < 5e-6, `${bunched[0].pitchSlide}`);
  // One record a walk: 60 at walk 7 (no catch-up, its step is not behind the
  // walk), 52 caught up to 48 at walk 8, the end at 9, closed at 10.
  assert.deepEqual(bunched.map((w) => w.pitch).slice(1), [60, 48, 48, 48]);
  assert.equal(bunched.length, 5);
});

test('the gate closes at the walk after the cursor reaches the end record', () => {
  assert.equal(closingWalk([5]), 6);
  assert.equal(closingWalk([1, 4, 7]), 8);
  assert.equal(closingWalk([1, 2, 3, 5]), 6);
  // The module: cursor on the end record at walk 9, gate closed at walk 10.
  assert.equal(closingWalk([6, 6, 6, 8]), 10);
  assert.equal(closingWalk([6, 6, 8]), 9);
});
