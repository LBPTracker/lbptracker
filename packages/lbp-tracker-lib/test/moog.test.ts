import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { LadderCoefficients } from '../src/audio/moog.ts';
import {
  FILTER_BYPASS_CUTOFF,
  FILTER_PARAMS,
  MoogLadder,
  MoogLadder32,
  filterAt,
  filterAtInto,
  filterEnds32,
  ladderCoefficients,
  ladderCoefficients32Into,
  ladderCoefficientsInto,
  rampStep32,
} from '../src/audio/moog.ts';

const SR = 48000;

/** Steady-state peak of a unit sine through the ladder, as a gain. */
function gainAt(hz: number, freq: number, res: number, amplitude = 0.5): number {
  const coefficients = ladderCoefficients(freq, res);
  const filter = new MoogLadder();
  const n = Math.round(SR * 0.3);
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const out = filter.process(amplitude * Math.sin((2 * Math.PI * hz * i) / SR), coefficients);
    if (i > n * 0.7) peak = Math.max(peak, Math.abs(out));
  }
  return peak / amplitude;
}

// ------------------------------------------------------------- coefficients

test('the coefficients are the reference formula, by hand', () => {
  // freq 0.5: q = 0.5, p = 0.5 + 0.8*0.5*0.5 = 0.7, f = 2p - 1 = 0.4,
  // and the resonance compensation is 1 + 0.5*0.5*(1 - 0.5 + 5.6*0.25) = 1.475.
  const c = ladderCoefficients(0.5, 1);
  assert.ok(Math.abs(c.p - 0.7) < 1e-9, `p = ${c.p}`);
  assert.ok(Math.abs(c.f - 0.4) < 1e-9, `f = ${c.f}`);
  assert.ok(Math.abs(c.q - 1.475) < 1e-9, `q = ${c.q}`);
  // Resonance scales that term linearly and nothing else.
  assert.equal(ladderCoefficients(0.5, 0).q, 0);
  assert.ok(Math.abs(ladderCoefficients(0.5, 0.5).q - 0.7375) < 1e-9);
  assert.equal(ladderCoefficients(0.5, 0).p, ladderCoefficients(0.5, 1).p);
});

// ------------------------------------------------------------------ response

test('it low-passes, and lower cutoffs cut more', () => {
  const low = gainAt(100, 0.1, 0);
  const high = gainAt(6400, 0.1, 0);
  assert.ok(high < low / 10, `6.4 kHz ${high.toFixed(3)} vs 100 Hz ${low.toFixed(3)}`);
  // Opening the cutoff must let more through at a fixed frequency.
  assert.ok(gainAt(3200, 0.3, 0) > gainAt(3200, 0.1, 0));
  assert.ok(gainAt(3200, 0.7, 0) > gainAt(3200, 0.3, 0));
});

test('resonance lifts the corner above the passband', () => {
  // At cutoff 0.3 the corner sits up near 6 kHz. With resonance the passband
  // drops and the corner rises past unity -- if this ever stops holding, the
  // resonance term has been transcribed wrong.
  const passband = gainAt(200, 0.3, 0.9);
  const corner = gainAt(6400, 0.3, 0.9);
  assert.ok(corner > 1, `the corner should peak above unity, got ${corner.toFixed(3)}`);
  assert.ok(
    corner > passband * 3,
    `corner ${corner.toFixed(3)} vs passband ${passband.toFixed(3)}`,
  );
  // And with no resonance there is no such peak.
  assert.ok(gainAt(6400, 0.3, 0) < gainAt(200, 0.3, 0));
});

test('it stays finite and bounded at settings that would blow up a linear ladder', () => {
  for (const [freq, res] of [
    [0.9, 1],
    [1, 1],
    [0.5, 1],
    [0, 1],
  ]) {
    const coefficients = ladderCoefficients(freq, res);
    const filter = new MoogLadder();
    let peak = 0;
    for (let i = 0; i < SR * 2; i += 1) {
      const out = filter.process(Math.sin(i * 0.7) * 0.95, coefficients);
      assert.ok(Number.isFinite(out), `freq ${freq} res ${res} went non-finite at ${i}`);
      peak = Math.max(peak, Math.abs(out));
    }
    assert.ok(peak < 4, `freq ${freq} res ${res} peaked at ${peak.toFixed(2)}`);
  }
});

const drive = (amplitude: number, freq: number, res = 0): number => {
  const coefficients = ladderCoefficients(freq, res);
  const filter = new MoogLadder();
  let peak = 0;
  for (let i = 0; i < 8000; i += 1) {
    const out = filter.process(amplitude * Math.sin(i * 0.05), coefficients);
    if (!Number.isFinite(out)) return NaN;
    if (i > 4000) peak = Math.max(peak, Math.abs(out));
  }
  return peak;
};

test('the cubic saturation is there — gain falls as the input grows', () => {
  // Dropping `b4 - b4^3/6` makes the ratio flat, so this is a real check on the
  // saturation rather than on the filter.
  const quiet = drive(0.1, 0.8) / 0.1;
  const loud = drive(1.0, 0.8) / 1.0;
  assert.ok(quiet > 0.99, `a quiet signal passes at unity, got ${quiet.toFixed(4)}`);
  assert.ok(loud < 0.9, `a full-scale one is compressed, got ${loud.toFixed(4)}`);
});

test('⚠️ the ladder diverges above roughly ±1.4 — that is the engine’s too', () => {
  // The reference this reproduces documents its input as [-1, +1], and beyond
  // it the cube overpowers the state and the filter runs away to NaN. **Do not
  // "fix" it**: the engine carries the same cube, and its voices are int16/32768
  // so they never leave the domain. This test exists so the boundary is a known
  // property rather than a surprise the day something feeds it a hot signal.
  for (const freq of [0.2, 0.5, 0.8, 1]) {
    assert.ok(Number.isFinite(drive(1, freq)), `full scale must survive at cutoff ${freq}`);
  }
  assert.ok(Number.isFinite(drive(1.3, 0.8)), 'and there is headroom past it');
  assert.ok(Number.isNaN(drive(2, 0.8)), 'but it does run away eventually');
});

test('a reset ladder repeats itself exactly', () => {
  const coefficients = ladderCoefficients(0.3, 0.5);
  const filter = new MoogLadder();
  const first = Array.from({ length: 64 }, (_, i) => filter.process(Math.sin(i * 0.3), coefficients));
  filter.reset();
  const second = Array.from({ length: 64 }, (_, i) => filter.process(Math.sin(i * 0.3), coefficients));
  assert.deepEqual(first, second);
});

// ------------------------------------------------------------- the modulation

test('filterAt squares the cutoff, and clamps', () => {
  const base = { cutoff: 0.5, resonance: 0.4, keyTrack: 0, envAmount: 0 };
  const { freq, res } = filterAt(base, 1, 1);
  assert.equal(freq, 0.25, 'the cutoff parameter is squared');
  assert.equal(res, 0.4);
  // An open filter with key tracking on a high note must clamp, not overflow.
  assert.equal(filterAt({ ...base, cutoff: 1, keyTrack: 1 }, 1, 8).freq, 1);
  assert.equal(filterAt({ ...base, cutoff: 0.5, envAmount: 1 }, -5, 1).freq, 0);
});

test('key tracking follows the playback rate, and only when asked', () => {
  const base = { cutoff: 0.5, resonance: 0, keyTrack: 1, envAmount: 0 };
  // rate 2 (an octave up) doubles the cutoff: 0.25 * (1 + (2-1)*1) = 0.5.
  assert.equal(filterAt(base, 1, 2).freq, 0.5);
  assert.equal(filterAt({ ...base, keyTrack: 0 }, 1, 2).freq, 0.25, 'off means off');
  assert.equal(filterAt({ ...base, keyTrack: 0.5 }, 1, 3).freq, 0.5, 'and it scales');
});

test('the envelope only moves the filter when the amount is set', () => {
  const base = { cutoff: 0.6, resonance: 0.4, keyTrack: 0, envAmount: 0 };
  // ⚠️ This is the redundancy the corpus shows: 27 of the 28 instruments with
  // amount 0 also leave envelope B inert, because either one neutralises the
  // pair. Both routes must give an unmodulated filter.
  for (const level of [0, 0.5, 1]) {
    assert.equal(filterAt(base, level, 1).freq, 0.36, `amount 0 at level ${level}`);
  }
  const modulated = { ...base, envAmount: 1 };
  assert.equal(filterAt(modulated, 1, 1).freq, 0.36, 'a level of 1 is the neutral point');
  assert.ok(filterAt(modulated, 0.5, 1).freq < 0.36, 'and below it the filter closes');
});

test('the param indices are the ones the renderer reads', () => {
  assert.deepEqual({ ...FILTER_PARAMS }, {
    cutoff: 3,
    resonance: 4,
    keyTrack: 5,
    envAmount: 6,
  });
});

// ------------------------------------------------- the two paths, kept apart

test('the resonance follows the filter envelope, not the key tracking', () => {
  // ⚠️ This test asserted the opposite for one commit. The two terms in
  // fmodextinput.prx are the same shape -- `1 + (X - 1) * p` -- so they cannot
  // be told apart from the arithmetic. What separates them is X: [rbp-0xa90]
  // is set to 1.0 at 0x1de5 and multiplied by a frequency ratio at 0x1e0a, so
  // it is the pitch; [rbp-0xb70] holds the return of the envelope evaluator
  // called at 0x21ed with Params[7..10], so it is envelope B. The value
  // multiplied into the resonance at 0x2a50 is the envelope one.
  const settings = { cutoff: 0.6, resonance: 0.9, keyTrack: 0.6, envAmount: 0.63 };
  const rate = 2 ** ((25 - 48) / 12);

  // The key tracking moves the cutoff...
  const low = filterAt(settings, 1, rate);
  const high = filterAt(settings, 1, 1);
  assert.ok(low.freq < high.freq, 'a lower note tracks the cutoff down');

  // ...and leaves the resonance alone.
  assert.equal(low.res, high.res, 'the pitch must not touch the resonance');

  // The envelope moves both.
  const open = filterAt(settings, 1, rate);
  const shut = filterAt(settings, 0, rate);
  assert.ok(open.freq > shut.freq, 'envelope B opens the cutoff');
  assert.ok(open.res > shut.res, 'envelope B opens the resonance too');
  const envFactor = 1 + settings.envAmount * (0 - 1);
  assert.ok(Math.abs(shut.res - settings.resonance * envFactor) < 1e-12);
});

test('a note far above the base note drives the cutoff to its ceiling', () => {
  // keytrack multiplies rather than offsets, so a high note can push
  // cutoff² * keytrack past 1. The clamp is ours -- the ladder diverges above
  // it -- and this pins the behaviour rather than leaving it to chance.
  const settings = { cutoff: 0.89, resonance: 0.9, keyTrack: 1, envAmount: 0 };
  assert.equal(filterAt(settings, 1, 4).freq, 1);
  assert.ok(filterAt(settings, 1, 4).res <= 1, 'resonance is clamped too');
});

test('a wide-open lowpass is skipped, and this ladder is not transparent', () => {
  // The bypass matters only because the ladder is NOT a no-op at freq = 1: it
  // passes a unit impulse at 0.833 and keeps ringing. If it were transparent
  // there, skipping it would be a pure optimisation instead of a fidelity fix.
  const coefficients = ladderCoefficients(1, 0);
  const ladder = new MoogLadder();
  let peak = 0;
  let late = 0;
  for (let i = 0; i < 48000; i += 1) {
    const y = Math.abs(ladder.process(i === 0 ? 1 : 0, coefficients));
    if (y > peak) peak = y;
    if (i > 24000 && y > late) late = y;
  }
  assert.ok(peak < 0.9, `a unit impulse comes out at ${peak.toFixed(3)}, not 1`);
  assert.ok(late > 1e-3, 'and it is still ringing after half a second');
  // The threshold itself, from the comparison at 0x2ea9: the module's 0.99f
  // (`v0x4620`), which sits a hair above 0.99.
  assert.equal(FILTER_BYPASS_CUTOFF, Math.fround(0.99));
  assert.ok(FILTER_BYPASS_CUTOFF > 0.99);
});

test('piano bypasses at and above its base note, and tracks below it', () => {
  // keys/piano.rinst is cutoff 1.0 at both ends of its range with no envelope
  // amount and full key tracking, so `freq` is just the playback rate. At and
  // above the base note it is pinned at the clamp and the filter is skipped;
  // below it the cutoff genuinely follows the pitch down, and the ladder runs
  // as a plain 4-pole lowpass because the resonance is zero.
  const settings = { cutoff: 1, resonance: 0, keyTrack: 1, envAmount: 0 };
  for (const rate of [1, 2, 4]) {
    for (const env of [0, 0.5, 1]) {
      assert.ok(
        filterAt(settings, env, rate).freq > FILTER_BYPASS_CUTOFF,
        `rate ${rate} should bypass`,
      );
    }
  }
  const low = filterAt(settings, 1, 0.25);
  assert.equal(low.freq, 0.25, 'an octave and a half down tracks the cutoff down with it');
  assert.equal(low.res, 0, 'and with no resonance it is a plain lowpass');
  assert.ok(low.freq < FILTER_BYPASS_CUTOFF, 'so the ladder does run there');
});

test('the allocation-free variants compute exactly the same numbers', () => {
  // The hot loop uses `*Into` to avoid an object per frame per voice. If these
  // ever diverge from the allocating originals the optimisation stops being
  // free, and a rendered file would change without anyone meaning it to.
  const settings = { cutoff: 0.7, resonance: 0.4, keyTrack: 0.6, envAmount: 0.3 };
  const scratch = { freq: 0, res: 0 };
  const coeff = { p: 0, f: 0, q: 0 };
  for (const env of [0, 0.25, 0.5, 1]) {
    for (const rate of [0.25, 0.5, 1, 2, 4]) {
      const a = filterAt(settings, env, rate);
      const b = filterAtInto(settings, env, rate, scratch);
      assert.equal(a.freq, b.freq);
      assert.equal(a.res, b.res);
      const c = ladderCoefficients(a.freq, a.res);
      const d = ladderCoefficientsInto(a.freq, a.res, coeff);
      assert.deepEqual({ p: c.p, f: c.f, q: c.q }, { p: d.p, f: d.f, q: d.q });
    }
  }
});

/**
 * ⚠️ A glide moves the cutoff too, and the fixed-coefficient shortcut must not
 * swallow that.
 *
 * `filterAt` scales the cutoff by the voice's playback rate through `keyTrack`,
 * so a voice whose rate moves has a moving cutoff even with no filter envelope.
 * The shortcut for `envAmount === 0` solved the ladder once per voice, which
 * pinned the cutoff at the note's opening pitch — and a filter that does not
 * follow the pitch is a riser that does not rise. `Northern Lights` opens on
 * `noise`, `keyTrack` 1.000, glided +27 semitones: measured by zero-crossing
 * rate the sweep rose 1.83x where the pitch rose 4.76x, and 3.47x after.
 */
test('a glided voice sweeps its filter, even with no filter envelope', async () => {
  const { Mixer } = await import('../src/audio/mixer.ts');
  const rate = 48000;
  const n = rate;
  // Broadband input, so what comes out is what the ladder passes.
  const noise = new Float32Array(rate);
  let seed = 12345;
  for (let i = 0; i < noise.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed / 0x40000000) - 1;
  }
  const crossings = (buf: Float32Array, from: number, to: number) => {
    let zc = 0;
    for (let i = from + 1; i < to; i += 1) if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) zc += 1;
    return zc;
  };

  const play = (pitch: number) => {
    const mixer = new Mixer(rate);
    mixer.play({
      sample: { channels: [noise], sampleRate: rate, loop: { start: 0, end: rate } },
      playbackRate: 1,
      gain: 1,
      pan: 0.5,
      endFrame: n,
      // envAmount 0 is exactly the case the shortcut takes.
      filter: {
        settings: { cutoff: 0.3, resonance: 0.2, keyTrack: 1, envAmount: 0 },
        envelope: { attack: 0, decay: 0, sustain: 1, release: 0 },
      },
      automation: [
        { frame: 0, pitch: 0, gain: 1 },
        { frame: n, pitch, gain: 1 },
      ],
    });
    const left = new Float32Array(n);
    mixer.render(left, new Float32Array(n));
    return left;
  };

  const glided = play(24);
  const flat = play(0);
  const early = crossings(glided, 0, rate / 8);
  const late = crossings(glided, (7 * rate) / 8, rate);
  assert.ok(late > early * 1.5, `the sweep opened: ${early} -> ${late}`);
  // And a voice that does not glide is unchanged, which is what the shortcut is
  // still there for.
  const flatEarly = crossings(flat, 0, rate / 8);
  const flatLate = crossings(flat, (7 * rate) / 8, rate);
  assert.ok(Math.abs(flatLate / flatEarly - 1) < 0.15, `flat stayed flat: ${flatEarly} -> ${flatLate}`);
});

/**
 * The drive, `Params[26]` — a soft clip on the sampler's output.
 *
 * `fmodextinput.prx` `0x1ee0`-`0x1f33` builds `k = 2d/(1 − d)` with `d` clamped
 * to 0.95, and `0x2cab`-`0x2cf1` applies `(1 + k)x / (1 + k|x|)` to whatever the
 * sampler returned. Nine of the game's 68 instruments set it, and for
 * `e_guitar_power` (0.731) and `e_guitar_distorted` (0.570..0.700) it is the
 * whole patch.
 */
test('the drive is a soft clip, and zero is an exact bypass', async () => {
  const { driveCoefficient, Mixer } = await import('../src/audio/mixer.ts');

  assert.equal(driveCoefficient(0), 0, 'no drive, no coefficient');
  assert.equal(driveCoefficient(0.5), 2, '2*0.5/(1-0.5)');
  // ⚠️ The 0.95 clamp is what keeps 1 - d off zero; without it a drive of 1
  // divides by zero and the voice becomes NaN for the rest of the render.
  assert.equal(driveCoefficient(1), driveCoefficient(0.95));
  assert.ok(Number.isFinite(driveCoefficient(1)));
  assert.equal(driveCoefficient(-5), 0, 'and the low end is clamped too');

  const rate = 48000;
  const ramp = new Float32Array(rate);
  for (let i = 0; i < ramp.length; i += 1) ramp[i] = (i / ramp.length) * 2 - 1;
  const render = (drive: number) => {
    const mixer = new Mixer(rate);
    mixer.play({
      sample: { channels: [ramp], sampleRate: rate, loop: { start: 0, end: rate } },
      playbackRate: 1,
      gain: 1,
      pan: 0,
      endFrame: rate,
      drive,
    });
    const left = new Float32Array(rate);
    mixer.render(left, new Float32Array(rate));
    return left;
  };

  // ⚠️ Zero must be bit-identical, not merely close: 59 of the game's 68
  // instruments leave Params[26] at zero, so anything else here would change
  // every render in the corpus.
  const clean = render(0);
  const bypass = render(0);
  assert.deepEqual([...clean], [...bypass]);

  const driven = render(0.5); // k = 2
  // f(x) = 3x / (1 + 2|x|). At x = 0.5 that is 1.5/2 = 0.75 -- louder, and
  // compressed towards the rail rather than clipped at it.
  // The ramp runs -1..+1 over `rate` samples, so x maps to an index -- clamped,
  // because x = +1 is one past the last sample.
  const at = (buf: Float32Array, x: number) =>
    buf[Math.min(rate - 1, Math.round(((x + 1) / 2) * rate))];
  assert.ok(Math.abs(at(driven, 0.5) - 0.75) < 0.01, `got ${at(driven, 0.5)}`);
  assert.ok(Math.abs(at(driven, -0.5) + 0.75) < 0.01, 'and it is odd-symmetric');
  // f(1) = (1+k)/(1+k) = 1 exactly: the rails are fixed points, so a soft clip
  // never exceeds full scale however hard it is driven.
  assert.ok(Math.abs(at(driven, 1) - at(clean, 1)) < 0.01, 'the rail is a fixed point');
  assert.ok(at(driven, 1) <= 1.0001, 'and it never goes past it');
  assert.ok(Math.abs(at(driven, 0)) < 1e-6, 'and so is zero');
  // Small signals get the full (1 + k) gain, which is where the loudness comes
  // from -- and why the two guitars carry the lowest output levels in the game.
  assert.ok(at(driven, 0.01) > at(clean, 0.01) * 2.8, 'quiet parts are lifted');
});

// --------------------------------------------- the module's float32, on its clock

const f32 = Math.fround;

/**
 * The coefficients transcribed a second time from `0x3124`-`0x317c`, so an
 * operation moved, merged or computed in double in `ladderCoefficients32Into`
 * fails here rather than in a differential test an hour later.
 */
function coefficientsByHand(freq: number, res: number): LadderCoefficients {
  const fr = f32(freq);
  const t = f32(1 - fr);
  const p = f32(fr + f32(f32(fr * f32(0.8)) * t));
  return {
    p,
    f: f32(f32(p + p) + -1),
    q: f32(f32(res) * f32(f32(f32(t * 0.5) * f32(f32(1 - t) + f32(f32(t * t) * f32(5.6)))) + 1)),
  };
}

/** `0x31c6`-`0x327d`, again: the ladder with a given saturation constant. */
function ladderByHand(saturation: number) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  return (input: number, { p, f: fb, q }: LadderCoefficients): number => {
    const x = f32(f32(input) - f32(q * b4));
    const n1 = f32(f32(p * f32(b0 + x)) - f32(fb * b1));
    const n2 = f32(f32(p * f32(b1 + n1)) - f32(fb * b2));
    const n3 = f32(f32(p * f32(b2 + n2)) - f32(fb * b3));
    const n4 = f32(f32(p * f32(b3 + n3)) - f32(fb * b4));
    const y = f32(n4 - f32(f32(n4 * f32(n4 * n4)) * saturation));
    [b0, b1, b2, b3, b4] = [x, n1, n2, n3, y];
    return y;
  };
}

/** A float32 draw in 0..1 from a fixed LCG, so the sweeps repeat. */
function draws(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return f32(s / 0x80000000);
  };
}

test('the float32 coefficients round every operation, in the module’s order', () => {
  const draw = draws(7);
  const out = { p: 0, f: 0, q: 0 };
  let roundedOnce = 0;
  for (let i = 0; i < 2000; i += 1) {
    const freq = draw();
    const res = draw();
    const c = ladderCoefficients32Into(freq, res, out);
    assert.deepEqual({ ...c }, coefficientsByHand(freq, res), `freq ${freq} res ${res}`);
    for (const v of [c.p, c.f, c.q]) assert.equal(f32(v), v, 'every coefficient is a float32');
    // The double formula agrees to float32's precision...
    const d = ladderCoefficients(freq, res);
    assert.ok(Math.abs(c.q - d.q) < 1e-6 * Math.max(1, d.q), `q ${c.q} against ${d.q}`);
    // ...and is not what rounding it once at the end gives.
    if (f32(d.q) !== c.q || f32(d.p) !== c.p) roundedOnce += 1;
  }
  assert.ok(roundedOnce > 100, `the per-operation rounding shows on ${roundedOnce} of 2000`);
});

test('the float32 ladder is the module’s sequence, its cube by 0.166667f', () => {
  // `woodpecker`'s full-modulation note: resonance 0.84 at a closed cutoff,
  // driven by a loud square so the cube is working.
  const c = ladderCoefficients32Into(0.03, 0.84, { p: 0, f: 0, q: 0 });
  const ladder = new MoogLadder32();
  const byHand = ladderByHand(f32(0.166667));
  const sixth = ladderByHand(f32(1 / 6));
  const double = new MoogLadder();
  const dc = ladderCoefficients(0.03, 0.84);
  let sixthApart = 0;
  let doubleApart = 0;
  let gap = 0;
  for (let i = 0; i < 9600; i += 1) {
    const input = Math.floor(i / 160) % 2 === 0 ? 0.9 : -0.9;
    const y = ladder.process(input, c);
    assert.equal(y, byHand(input, c), `sample ${i}`);
    assert.equal(f32(y), y, 'the output is a float32');
    if (sixth(input, c) !== y) sixthApart += 1;
    const d = double.process(input, dc);
    if (d !== y) doubleApart += 1;
    gap = Math.max(gap, Math.abs(d - y));
  }
  // `0x3e2aaac1` is 22 ulps above a sixth, and a loud resonant ladder shows it.
  assert.ok(sixthApart > 1000, `1/6 departs on ${sixthApart} samples`);
  // The double ladder is the same filter and not the same numbers: apart on
  // almost every sample, by -127 dB of the peak here on fixed coefficients.
  assert.ok(doubleApart > 9000, `the double ladder departs on ${doubleApart} samples`);
  assert.ok(gap < 1e-5, `by at most ${gap}`);
  ladder.reset();
  const again = ladderByHand(f32(0.166667));
  for (let i = 0; i < 64; i += 1) assert.equal(ladder.process(0.5, c), again(0.5, c), 'a reset ladder starts over');
});

test('the two ends are formed in float32, with the envelope factor as the module writes it', () => {
  const draw = draws(11);
  const params: { x: number; y: number }[] = Array.from({ length: 27 }, () => ({ x: draw(), y: draw() }));
  const out = { freqS: 0, freqE: 0, resS: 0, resE: 0 };
  let factorShows = 0;
  for (let i = 0; i < 500; i += 1) {
    const [modS, modE, envBS, envBE] = [draw(), draw(), draw(), draw()];
    const ratio = f32(0.25 + 4 * draw());
    filterEnds32(params, modS, modE, envBS, envBE, ratio, false, out);
    const at = (mod: number) => ({
      cutoff: params[3].x + mod * (params[3].y - params[3].x),
      resonance: params[4].x + mod * (params[4].y - params[4].x),
      keyTrack: params[5].x + mod * (params[5].y - params[5].x),
      envAmount: params[6].x + mod * (params[6].y - params[6].x),
    });
    const s = filterAt(at(modS), envBS, ratio);
    const e = filterAt(at(modE), envBE, ratio);
    for (const [ours, double] of [[out.freqS, s.freq], [out.freqE, e.freq], [out.resS, s.res], [out.resE, e.res]]) {
      assert.equal(f32(ours), ours, 'a float32');
      assert.ok(Math.abs(ours - double) < 1e-6, `${ours} against the double ${double}`);
    }
    // `(1 - a) + e·a` (`0x29e0`-`0x29e8`), not `1 + a·(e - 1)`: the resonance
    // is that factor times one more float, so the two forms show on it.
    const a = f32(params[6].x + f32(modS * f32(params[6].y - params[6].x)));
    const r = f32(params[4].x + f32(modS * f32(params[4].y - params[4].x)));
    const other = f32(r * f32(1 + f32(a * f32(envBS - 1))));
    if (other !== out.resS && other <= 1) factorShows += 1;
  }
  assert.ok(factorShows > 10, `the factor's form shows on ${factorShows} of 500`);
  // The render's `noKeyTrack` takes the key tracking out, whatever `Params[5]` says.
  const flat = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  flat[3] = { x: 0.5, y: 0.5 };
  flat[5] = { x: 1, y: 1 };
  assert.equal(filterEnds32(flat, 0, 0, 1, 1, 2, false, out).freqS, 0.5, 'an octave up doubles 0.25');
  assert.equal(filterEnds32(flat, 0, 0, 1, 1, 2, true, out).freqS, 0.25, 'and noKeyTrack holds it');
});

test('a ramp steps by a float32 reciprocal, not a division', () => {
  // `0x33eb`-`0x3411`: `1.0f / N`, then the difference times it.
  const draw = draws(3);
  let apart = 0;
  for (let n = 1; n <= 256; n += 1) {
    const [a, b] = [draw(), draw()];
    const step = rampStep32(a, b, n);
    assert.equal(step, f32(f32(b - a) * f32(1 / n)));
    if (step !== f32((b - a) / n)) apart += 1;
  }
  assert.ok(apart > 10, `a division would differ on ${apart} of 256`);
});
