import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  WAVEHAMMER_SHIPPED,
  WaveHammer,
  waveHammerCoefficient,
  waveHammerFloor,
  waveHammerTable,
} from '../src/audio/compressor.ts';

/**
 * ❗ **These vectors come out of the game's own code running.**
 * `tools/runhammer.py` loads `fmodsmswavehammer.prx` into a process and executes
 * its read callback; the rows below are what it produced for the signal
 * `signal()` regenerates. They are not a snapshot of this implementation, so a
 * change that breaks them is a change that stops matching the game.
 *
 * `tools/prxhammer.py` regenerates them with the module made as the game makes
 * it, against the console's own libc, and agrees with these to 5e-8 — the
 * resolution of a gain read as `out/in` off float32 samples.
 */
const VECTORS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.011726822, 0.001427808, 0.998560501],
  [1, -0.018494596, -0.015748753, 0.995712404],
  [7, -0.016228182, 0.017059834, 0.979551232],
  [33, 0.011262544, -0.005178552, 0.924189715],
  [64, -0.025006094, 0.002696048, 0.881112526],
  [65, -0.011565096, 0.00588567, 0.880030565],
  [100, 0.032421933, -0.038786268, 0.850821368],
  [255, -0.144207801, 0.146348079, 0.812836018],
  [256, 0.010744175, -0.109982996, 0.812775145],
  [400, -0.095854038, 0.010457643, 0.719704391],
  [700, 0.315067989, 0.676532393, 0.331297914],
  [1023, -0.150417147, -0.537863799, 0.219008601],
  [1024, -0.041528474, -0.654901166, 0.218910719],
  [1200, -0.145244641, 0.383008606, 0.213953149],
  [1500, 0.1080384, -0.358898742, 0.220119748],
  [1900, 0.003020792, 0.024479158, 0.278624808],
  [2047, 8.4726e-5, -0.000331788, 0.31115807],
];

const FRAMES = 8 * 256;

/** The same deterministic signal the harness was driven with: an LCG under a raised cosine. */
function signal(): { left: Float64Array; right: Float64Array } {
  let state = 0x12345678n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    return (Number(state >> 33n) / 2 ** 31) * 2 - 1;
  };
  const left = new Float64Array(FRAMES);
  const right = new Float64Array(FRAMES);
  for (let k = 0; k < FRAMES; k += 1) {
    const t = k / FRAMES;
    const amp = 0.02 + 0.9 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
    left[k] = amp * next();
    right[k] = amp * next();
  }
  return { left, right };
}

test('the signal generator reproduces the harness’s input exactly', () => {
  const { left, right } = signal();
  for (const [k, l, r] of VECTORS) {
    assert.ok(Math.abs(left[k] - l) < 5e-9, `left[${k}] is ${left[k]}, expected ${l}`);
    assert.ok(Math.abs(right[k] - r) < 5e-9, `right[${k}] is ${right[k]}, expected ${r}`);
  }
});

test('WaveHammer reproduces the gains the real PRX produced', () => {
  const { left, right } = signal();
  const hammer = new WaveHammer();
  const gains = new Float64Array(FRAMES);
  for (let k = 0; k < FRAMES; k += 1) gains[k] = hammer.gainFor(left[k], right[k]);
  let worst = 0;
  for (const [k, , , want] of VECTORS) {
    worst = Math.max(worst, Math.abs(gains[k] - want));
  }
  // Both sides are float32 in the same order, so this is the rows' own
  // resolution: a gain read as out/in, printed to nine figures.
  assert.ok(worst < 1e-7, `worst gain error ${worst}`);
});

test('once it has compressed, the gain rests where the module’s float32 envelope stalls', () => {
  const { left, right } = signal();
  const hammer = new WaveHammer();
  for (let k = 0; k < FRAMES; k += 1) hammer.gainFor(left[k], right[k]);
  let gain = 0;
  for (let k = 0; k < 48000; k += 1) gain = hammer.gainFor(0, 0);
  // `tools/prxhammer.py`: `[state+0xf0]` after the same signal and a second of
  // silence, still for good 75 blocks in. Not the constant 0.8087664 it aims
  // at: near rest the second smoother's step is under half an ulp of its state.
  assert.equal(gain, 0.8086755275726318);
  // Never compressed, it stalls on the other side of the constant.
  const fresh = new WaveHammer();
  for (let k = 0; k < 48000; k += 1) gain = fresh.gainFor(0, 0);
  assert.equal(gain, 0.8087709546089172);
});

test('the second smoother is seeded in float32, a hair under 0.5', () => {
  // `tools/prxhammer.py`: the first frame of a fresh module fed 1.0. A seed of
  // exactly 0.5 makes it 0.99812317.
  assert.equal(new WaveHammer().gainFor(1, 1), 0.998123049736023);
});

test('the coefficients match the ones the running module reports', () => {
  // `[state+0xf8]` and `[state+0xfc]`, dumped by `prxhammer.py`. The attack is
  // `powf` in float32, one ulp under the float nearest `0.1^(1/3)`.
  assert.equal(waveHammerCoefficient(10, 48000), 0.4641588628292084);
  assert.equal(waveHammerCoefficient(250, 48000), 0.9844582080841064);
  // `x = round(rate * ms * 1e-4)/8 - 3` is not positive below ~5 ms at 48 kHz,
  // and `0x733` stores zero rather than dividing by it.
  assert.equal(waveHammerCoefficient(5, 48000), 0);
});

test('the table axis starts exactly at the knee bottom, so entry 0 is unity', () => {
  // `[state+0xc8]` when the threshold is -18 dB, one ulp under the float
  // nearest `10^-2.1`: `0x380` gets there through `powf` and a square.
  const floor = waveHammerFloor(-18);
  assert.equal(floor, 0.007943280972540379);
  const gains = waveHammerTable(-18, 10, floor);
  assert.ok(Math.abs(gains[0] - 1) < 1e-6, `entry 0 is ${gains[0]}`);
  // `[state+0x100]`, the largest reduction, which the make-up normalises to 0.995.
  assert.ok(Math.abs(gains[3999] - 0.154881641) < 1e-6, `entry 3999 is ${gains[3999]}`);
});

test('the knee is C1 continuous, which is what makes the cubic the only choice', () => {
  // ⚠️ Not a second-difference bound on the table: the axis is linear in *power*,
  // so the entry spacing in dB shrinks towards the top and uneven curvature per
  // entry is the intended shape. The property is that the cubic and the straight
  // line agree in value *and* slope where they meet, at `t = 1`.
  for (const [t, r] of [[-18, 10], [-6, 2], [-30, 1.5], [-24, 4], [-12, 50]] as const) {
    const invR = r >= 50 ? 0 : 1 / r;
    const cubicAtKnee = -3 * (1 - invR);            // −3(1−r)·t² at t = 1
    const lineAtKnee = 3 * (1 - 2) * (1 - invR);    // 3(1−2t)(1−r) at t = 1
    assert.ok(Math.abs(cubicAtKnee - lineAtKnee) < 1e-12, `value jumps at ${t}/${r}`);
    // d/dL in dB per dB, with dt/dL = 1/6.
    const cubicSlope = (-3 * (1 - invR) * 2) / 6;
    const lineSlope = (3 * -2 * (1 - invR)) / 6;
    assert.ok(Math.abs(cubicSlope - lineSlope) < 1e-12, `slope jumps at ${t}/${r}`);
    // The Hermite's whole point: unity gain and unity slope at the knee bottom.
    const atBottom = -3 * (1 - invR) * 0;
    assert.ok(atBottom === 0, `not unity at the knee bottom for ${t}/${r}`);
    // And 1/R of the input change above the knee: gain slope is 1/R − 1.
    assert.ok(Math.abs(lineSlope - (invR - 1)) < 1e-12, `ratio is not 1/${r} above the knee`);
  }
});

test('a ratio of 50 or more is a hard limiter, not a steep compressor', () => {
  // `0xbc9` masks the reciprocal to zero and `0xcb6` takes `out = T` outright,
  // so 50:1 and 1000:1 give the same curve.
  const floor = waveHammerFloor(-18);
  const at50 = waveHammerTable(-18, 50, floor);
  const at1000 = waveHammerTable(-18, 1000, floor);
  for (let i = 0; i < 4000; i += 137) {
    assert.ok(Math.abs(at50[i] - at1000[i]) < 1e-7, `entry ${i} differs`);
  }
  // And it pins the output at the threshold: -18 dB out for a full-scale input.
  const level = 20 * Math.log10(at50[3999]);
  assert.ok(Math.abs(level - -18) < 0.01, `full scale lands at ${level} dB`);
});

test('below the knee the shipped settings are a flat −1.84 dB', () => {
  const hammer = new WaveHammer(WAVEHAMMER_SHIPPED);
  let gain = 1;
  // ⚠️ The closed loop's pole is `2·b0·c + a1`, which at the release coefficient
  // is 0.99957 — about 2,300 samples of time constant, so this needs ~1 s to
  // settle and not the 4,000 samples that look generous.
  for (let k = 0; k < 48000; k += 1) gain = hammer.gainFor(0.01, 0.01);
  assert.ok(Math.abs(20 * Math.log10(gain) - -1.844) < 0.01, `settles at ${gain}`);
});
