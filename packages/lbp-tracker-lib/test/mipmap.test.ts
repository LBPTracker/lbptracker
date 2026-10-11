import { strict as assert } from 'node:assert';
import test from 'node:test';

import { linear } from '../src/audio/interpolate.ts';
import {
  MIP_THRESHOLDS,
  buildMipChain,
  decimateBy2,
  mipLevelFor,
  readMipped,
} from '../src/audio/mipmap.ts';

// ------------------------------------------------------------------ selection

test('the mip thresholds are the engine’s, 2.0 and 4.0', () => {
  assert.deepEqual([...MIP_THRESHOLDS], [2, 4]);
  assert.equal(mipLevelFor(1), 0);
  assert.equal(mipLevelFor(1.999), 0);
  assert.equal(mipLevelFor(2), 1, 'the bound is >=, not >');
  assert.equal(mipLevelFor(3.999), 1);
  assert.equal(mipLevelFor(4), 2);
  assert.equal(mipLevelFor(64), 2, 'there is no level 3 to fall through to');
});

test('a chain halves twice and stops', () => {
  const chain = buildMipChain(new Float32Array(1024));
  assert.deepEqual(chain.map((c) => c.length), [1024, 512, 256]);
});

test('a sample too short to halve reuses the level above it', () => {
  const chain = buildMipChain(Float32Array.from([1, 2]));
  assert.equal(chain.length, 3);
  for (const level of chain) assert.equal(level.length, 2);
});

// ------------------------------------------------------------ position mapping

// A ramp makes the fraction arithmetic checkable exactly. Averaging pairs of a
// ramp gives the ramp shifted by half a frame per level, so a correct read at
// level L must land on `p + (2^L - 1)/2` for EVERY p, integer or not. Getting
// `(frac + (i mod d)) / d` wrong breaks this immediately.
test('reading a mip carries the fraction, exactly', () => {
  const n = 256;
  const ramp = new Float32Array(n);
  for (let i = 0; i < n; i += 1) ramp[i] = i;
  const chain = buildMipChain(ramp);

  for (let p = 0; p < 200; p += 1) {
    assert.ok(
      Math.abs(readMipped(chain, p, 0) - p) < 1e-4,
      `level 0 at ${p}`,
    );
    assert.ok(
      Math.abs(readMipped(chain, p, 1) - (p + 0.5)) < 1e-3,
      `level 1 at ${p}: got ${readMipped(chain, p, 1)}`,
    );
    assert.ok(
      Math.abs(readMipped(chain, p, 2) - (p + 1.5)) < 1e-3,
      `level 2 at ${p}: got ${readMipped(chain, p, 2)}`,
    );
  }
  // And between frames too, which is where a mis-scaled fraction would hide.
  assert.ok(Math.abs(readMipped(chain, 40.25, 2) - 41.75) < 1e-3);
  assert.ok(Math.abs(readMipped(chain, 40.75, 1) - 41.25) < 1e-3);
});

test('level 0 with no loop is exactly the linear interpolator', () => {
  const data = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.3));
  const chain = buildMipChain(data);
  for (let p = 0; p < 60; p += 0.37) {
    assert.ok(
      Math.abs(readMipped(chain, p, 0) - linear(data, p)) < 1e-6,
      `at ${p}`,
    );
  }
});

// ----------------------------------------------------------- the engine's loop

// These two assertions ARE the difference between our reference path and the
// game's, so they are written as exact index arithmetic rather than by ear.
test('the wrap triggers past loop.end, not at it', () => {
  const data = Float32Array.from({ length: 64 }, (_, i) => i);
  const chain = buildMipChain(data);
  const loop = { start: 10, end: 20 };

  // loop.end itself is read straight out of the buffer -- one frame beyond the
  // half-open region, which is the frame the unwrapped second tap needs.
  assert.equal(readMipped(chain, 20, 0, loop), 20);
  // The frame after it maps to start + 1, not to start.
  assert.equal(readMipped(chain, 21, 0, loop), 11);
  // A full span later it does land on start.
  assert.equal(readMipped(chain, 30, 0, loop), 10);
  assert.equal(readMipped(chain, 31, 0, loop), 11);
});

test('a position before the loop is not wrapped into it', () => {
  const data = Float32Array.from({ length: 64 }, (_, i) => i);
  const chain = buildMipChain(data);
  const loop = { start: 10, end: 20 };
  assert.equal(readMipped(chain, 0, 0, loop), 0, 'the attack plays as recorded');
  assert.equal(readMipped(chain, 5, 0, loop), 5);
});

test('reading past the sample is silence, not a wrap or a crash', () => {
  const chain = buildMipChain(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(readMipped(chain, 8, 0), 0);
  assert.equal(readMipped(chain, 1000, 2), 0);
  assert.equal(readMipped(chain, -1, 0), 0);
});

// ------------------------------------------------------- what it actually buys

test('mipping beats plain linear at both thresholds', () => {
  const SR = 48000;
  const n = 48000;
  // A low partial we want to hear plus a high one that will alias when the
  // sample is read in steps. Without mipping the high partial folds straight
  // into the output; the whole point of the pre-decimated copies is that it
  // never gets the chance.
  const src = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    src[i] =
      0.5 * Math.sin((2 * Math.PI * 500 * i) / SR) +
      0.5 * Math.sin((2 * Math.PI * 9000 * i) / SR);
  }
  const chain = buildMipChain(src);

  const snr = (rate: number, read: (p: number) => number) => {
    let err = 0;
    let sig = 0;
    let pos = 0;
    for (let i = 0; i < 8000; i += 1) {
      const ideal = 0.5 * Math.sin((2 * Math.PI * 500 * pos) / SR);
      err += (read(pos) - ideal) ** 2;
      sig += ideal ** 2;
      pos += rate;
    }
    return 10 * Math.log10(sig / err);
  };

  for (const rate of [2, 4]) {
    const level = mipLevelFor(rate);
    const plain = snr(rate, (p) => linear(src, p));
    const mipped = snr(rate, (p) => readMipped(chain, p, level));
    console.log(
      `    rate ${rate} — plain ${plain.toFixed(1)} dB, ` +
        `mipped ${mipped.toFixed(1)} dB (level ${level})`,
    );
    assert.ok(mipped > plain + 1, `rate ${rate}: mipping should help`);
  }

  // ⚠️ The margins are deliberately loose. `decimateBy2` averages pairs, which
  // is a guess (open question 5b) and a weak filter -- one stage is only -1.6 dB
  // at 9 kHz. A real half-band filter would push these numbers up a lot, and
  // that is the point of keeping the measurement here: when 5b closes, this
  // test says whether the new filter is actually better.
});

test('the halved copy is the engine’s int16 pair average', () => {
  // fmodextinput.prx 0x13ae-0x13fd: sum the pair as int16, halve toward zero,
  // store back as int16. The float `(a + b) * 0.5` differs on odd sums.
  const q = (n: number) => n / 32768;
  const src = new Float32Array([q(3), q(4), q(-3), q(-4), q(1), q(2)]);
  const out = decimateBy2(src);
  assert.equal(out.length, 3);
  assert.equal(out[0], q(3), '(3 + 4) / 2 truncates to 3, not 3.5');
  assert.equal(out[1], q(-3), 'and (-3 + -4) / 2 to -3, toward zero rather than down');
  assert.equal(out[2], q(1), '(1 + 2) / 2 -> 1');
  // Every output sits on the int16 grid, which is the point.
  for (const v of out) assert.equal(v * 32768, Math.round(v * 32768));
});

test('a loop ending on the last frame reads silence once, at its first wrap', () => {
  // `0x3780` wraps the integer index only when it passes `start + len`, then
  // returns 0 for an index at or past the slot's frame count (`+0x78`): a loop
  // that ends on the last frame meets that one frame exactly once, on the
  // first pass, and never again -- the position is never rewound.
  const frames = 100;
  const data = new Float32Array(frames + 16).fill(0.5);
  const chain = buildMipChain(data);
  const loop = { start: 10, end: 100, frames };
  assert.equal(readMipped(chain, 99.5, 0, loop), 0.5);
  assert.equal(readMipped(chain, 100, 0, loop), 0, 'index 100 is the frame count: silence');
  assert.equal(readMipped(chain, 100 + 90, 0, loop), 0.5, 'past start + len it wraps and sounds');
  assert.equal(readMipped(chain, 100, 0, { start: 10, end: 100 }), 0.5, 'no frame count, no gap');
});
