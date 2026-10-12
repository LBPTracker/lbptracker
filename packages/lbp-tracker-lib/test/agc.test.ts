/**
 * The AGC after the game's master bus (`audio/agc.ts`): ours, so it is held to
 * what it promises rather than to anything measured of the game -- the K filter
 * BS.1770 tabulates, the target it settles at, the ceiling it never passes, and
 * a gain that silence does not move.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { AGC, Agc, kWeighting } from '../src/audio/agc.ts';

const RATE = 48000;

/** Seconds of a stereo signal through a fresh AGC; `frame(i)` gives both channels. */
function through(agc: Agc, seconds: number, frame: (i: number) => number): { left: Float32Array; right: Float32Array } {
  const n = Math.round(seconds * RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = frame(i);
    agc.process(x, x);
    left[i] = agc.left;
    right[i] = agc.right;
  }
  return { left, right };
}

/** BS.1770 loudness of frames `[from, to)`, ungated. */
function loudness(left: Float32Array, right: Float32Array, from: number, to: number): number {
  let energy = 0;
  for (const channel of [left, right]) {
    const [s, p] = kWeighting(RATE);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < to; i += 1) {
      const x = channel[i];
      const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = p.b0 * y + p.b1 * u1 + p.b2 * u2 - p.a1 * z1 - p.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      if (i >= from) energy += z * z;
    }
  }
  return -0.691 + 10 * Math.log10(energy / (to - from));
}

const sine = (amplitude: number, hz = 1000) => (i: number) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);

test('the K filter at 48 kHz is the one BS.1770 tabulates', () => {
  const [shelf, pass] = kWeighting(RATE);
  const table = [
    [shelf.b0, 1.53512485958697], [shelf.b1, -2.69169618940638], [shelf.b2, 1.19839281085285],
    [shelf.a1, -1.69065929318241], [shelf.a2, 0.73248077421585],
    [pass.b0, 1], [pass.b1, -2], [pass.b2, 1], [pass.a1, -1.99004745483398], [pass.a2, 0.99007225036621],
  ];
  for (const [ours, theirs] of table) assert.ok(Math.abs(ours - theirs) < 1e-9, `${ours} against ${theirs}`);
});

test('a steady quiet song is brought to the target, a loud one down to it', () => {
  for (const amplitude of [0.02, 0.5]) {
    const { left, right } = through(new Agc(RATE), 30, sine(amplitude));
    const last = 30 * RATE;
    const level = loudness(left, right, last - 5 * RATE, last);
    assert.ok(Math.abs(level - AGC.targetLufs) < 0.3, `${amplitude}: ${level.toFixed(2)} LUFS`);
  }
});

test('the gain stops at its ceiling, however quiet the song', () => {
  // −50 dBFS sits above the gate, and would want some +34 dB.
  const agc = new Agc(RATE);
  through(agc, 30, sine(0.0032));
  assert.ok(Math.abs(20 * Math.log10(agc.gain) - AGC.maxDb) < 0.01, `${20 * Math.log10(agc.gain)}`);
});

test('nothing leaves past the ceiling, whatever the gain has been lifted to', () => {
  // Ten quiet seconds lift the gain, then a full-scale burst arrives at once.
  const { left } = through(new Agc(RATE), 12, (i) => (i < 10 * RATE ? sine(0.01)(i) : sine(1, 220)(i)));
  const ceiling = 10 ** (AGC.ceilingDb / 20);
  let loudest = 0;
  for (const v of left) loudest = Math.max(loudest, Math.abs(v));
  assert.ok(loudest <= ceiling + 1e-6, `${loudest} against ${ceiling}`);
});

test('a song that stops leaves the gain where it was', () => {
  // The loudness falls through every level on its way to silence: under the
  // band for the hold, then under the relative gate, then under the gate.
  const agc = new Agc(RATE);
  through(agc, 10, sine(0.05));
  const before = agc.gain;
  through(agc, 20, () => 0);
  const moved = 20 * Math.log10(agc.gain / before);
  assert.ok(Math.abs(moved) < 0.05, `${moved.toFixed(3)} dB`);
});

test('a song much quieter than the last is found slowly, or at once after a silence', () => {
  // 15 LU under the level, so under the relative gate: held for 4 s, then
  // followed down over most of a minute...
  const straight = new Agc(RATE);
  through(straight, 20, sine(0.5));
  const late = through(straight, 200, sine(0.09));
  const settled = loudness(late.left, late.right, 195 * RATE, 200 * RATE);
  assert.ok(Math.abs(settled - AGC.targetLufs) < 0.5, `${settled.toFixed(2)} LUFS after 200 s`);
  // ...while after a stop, the next sound warms up as a new song.
  const paused = new Agc(RATE);
  through(paused, 20, sine(0.5));
  through(paused, AGC.rewarmS + 1, () => 0);  // the silence detector falls in half a second
  const next = through(paused, 4, sine(0.09));
  const found = loudness(next.left, next.right, 3 * RATE, 4 * RATE);
  assert.ok(Math.abs(found - AGC.targetLufs) < 1, `${found.toFixed(2)} LUFS 3 s in`);
});

test('a fresh AGC starts at +6 dB and finds a song within its warm-up', () => {
  const agc = new Agc(RATE);
  assert.ok(Math.abs(20 * Math.log10(agc.gain) - 6) < 0.01);
  // A song at about −30 LUFS wants some +14 dB; three seconds in it is close.
  const { left, right } = through(agc, 4, sine(0.03));
  const level = loudness(left, right, 3 * RATE, 4 * RATE);
  assert.ok(Math.abs(level - AGC.targetLufs) < 1.5, `${level.toFixed(2)} LUFS at 3 s`);
});
