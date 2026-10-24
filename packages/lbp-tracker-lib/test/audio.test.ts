import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  cubic,
  DEFAULT_INTERPOLATOR,
  INTERPOLATORS,
  linear,
  nearest,
  sinc8,
} from '../src/audio/interpolate.ts';
import { Mixer, type SampleBuffer } from '../src/audio/mixer.ts';
import {
  DEFAULT_SLOT,
  resolveSlot,
  type Instrument,
} from '../src/instrument.ts';
import type { SampleSlot } from '@lbptracker/cwlib/resources/rinstrument.ts';
import { PAN_WIDTH } from '../src/render.ts';
import {
  panGains,
  pitchRatio,
  samplesPerStep,
  velocityGain,
  voiceFor,
} from '../src/voice.ts';

const slot = (over: Partial<SampleSlot> = {}): SampleSlot => ({
  ...DEFAULT_SLOT,
  ...over,
});

const instrument = (over: Partial<Instrument> = {}): Instrument => ({
  slots: [slot()],
  splitNotes: [0, 127, 0, 0, 0, 0, 0, 0, 0],
  numStack: 1,
  arpeggiate: false,
  arpeggio: [],
  ...over,
});

// ---------------------------------------------------------------- interpolation

test('linear interpolation hits the midpoint of a ramp', () => {
  const data = Float32Array.from([0, 1, 2, 3]);
  assert.equal(linear(data, 0), 0);
  assert.equal(linear(data, 1.5), 1.5);
  assert.equal(linear(data, 2.25), 2.25);
});

test('every interpolator is exact on integer positions', () => {
  const data = Float32Array.from([0.5, -0.25, 0.75, -1]);
  for (const interp of [nearest, linear, cubic]) {
    for (let i = 0; i < data.length; i += 1) {
      assert.ok(
        Math.abs(interp(data, i) - data[i]) < 1e-6,
        `${interp.name} at ${i}`,
      );
    }
  }
});

test('interpolators read silence outside the buffer instead of crashing', () => {
  const data = Float32Array.from([1, 1, 1]);
  for (const interp of [nearest, linear, cubic]) {
    assert.equal(interp(data, -5), 0, `${interp.name} before the start`);
    assert.equal(interp(data, 99), 0, `${interp.name} past the end`);
  }
});

test('cubic reproduces a straight line exactly', () => {
  // Catmull-Rom is interpolating and linear-exact; if it is not, the
  // coefficients are wrong.
  const data = Float32Array.from([0, 1, 2, 3, 4, 5]);
  for (const p of [2.0, 2.25, 2.5, 2.75, 3.0]) {
    assert.ok(Math.abs(cubic(data, p) - p) < 1e-5, `cubic at ${p}`);
  }
});

test('resampling SNR: the reason linear is not the default', () => {
  // Resample a 22050 Hz source to 44100 (playbackRate 0.5) and compare against
  // the analytic sine. This is exactly what a piano sample does, and it is how
  // the first listening test's "extreme distortion" was diagnosed: linear
  // interpolation gives a 16% amplitude error at 4 kHz, where a piano attack
  // has plenty of energy.
  const SRC = 22050;
  const OUT = 44100;

  const snrAt = (freq: number, interp: typeof linear): number => {
    const src = new Float32Array(SRC);
    for (let i = 0; i < src.length; i += 1) {
      src[i] = Math.sin((2 * Math.PI * freq * i) / SRC) * 0.8;
    }
    const mixer = new Mixer(OUT, interp);
    mixer.play({
      sample: { channels: [src], sampleRate: SRC },
      playbackRate: 0.5,
      gain: 1,
      pan: 0.5,
    });
    const n = 16384;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    mixer.render(left, right);

    const g = 0.8 * 0.5; // centre pan, linear law
    let err = 0;
    let sig = 0;
    for (let i = 32; i < n - 32; i += 1) {
      const ideal = Math.sin((2 * Math.PI * freq * (i * 0.5)) / SRC) * g;
      err += (left[i] - ideal) ** 2;
      sig += ideal ** 2;
    }
    return 10 * Math.log10(sig / err);
  };

  const linear4k = snrAt(4000, linear);
  const cubic4k = snrAt(4000, cubic);
  const sinc4k = snrAt(4000, sinc8);

  assert.ok(linear4k < 25, `linear at 4 kHz should be poor, got ${linear4k.toFixed(1)} dB`);
  assert.ok(cubic4k > linear4k, 'cubic beats linear');
  assert.ok(
    sinc4k > 60,
    `sinc8 at 4 kHz should be clean, got ${sinc4k.toFixed(1)} dB`,
  );
  assert.ok(snrAt(2000, sinc8) > 60, 'sinc8 is clean at 2 kHz too');
  console.log(
    `    4 kHz SNR — linear ${linear4k.toFixed(1)} dB, ` +
      `cubic ${cubic4k.toFixed(1)} dB, sinc8 ${sinc4k.toFixed(1)} dB`,
  );
});

// The game's sampler (sub_0x3740 in fmodextinput.prx) is a two-tap lerp, so the
// faithful default is `linear` even though it measures worst above. Locking it
// down here stops it drifting back to whatever sounds nicest.
test('the default interpolator is the one the game uses', () => {
  assert.equal(DEFAULT_INTERPOLATOR, 'linear');
  assert.equal(INTERPOLATORS[DEFAULT_INTERPOLATOR], linear);
});

// ------------------------------------------------------------------ pitch math

test('a note at the slot base note plays at rate 1', () => {
  assert.equal(pitchRatio(slot({ baseNote: 48 }), 48, 120), 1);
});

test('an octave up doubles the rate, an octave down halves it', () => {
  const s = slot({ baseNote: 48 });
  assert.ok(Math.abs(pitchRatio(s, 60, 120) - 2) < 1e-9);
  assert.ok(Math.abs(pitchRatio(s, 36, 120) - 0.5) < 1e-9);
});

test('a semitone is the twelfth root of two', () => {
  const s = slot({ baseNote: 48 });
  assert.ok(Math.abs(pitchRatio(s, 49, 120) - 2 ** (1 / 12)) < 1e-12);
});

// fineTune is in SEMITONES: fmodextinput.prx adds it into the same sum as the
// note and the root note before the one division by 12. The corpus agrees --
// the game's own non-zero values run -0.17..+0.56, which is a sane fine-tune
// range in semitones and a silent one in cents.
test('fineTune of 1 equals one semitone', () => {
  const tuned = pitchRatio(slot({ baseNote: 48, fineTune: 1 }), 48, 120);
  const semitone = pitchRatio(slot({ baseNote: 48 }), 49, 120);
  assert.ok(Math.abs(tuned - semitone) < 1e-12);
});

test('a real fineTune from the corpus is a fraction of a semitone', () => {
  // baiyon_city_guildford's largest offset, 0.5625 semitones = 56 cents.
  const ratio = pitchRatio(slot({ baseNote: 48, fineTune: 0.5625 }), 48, 120);
  assert.ok(Math.abs(ratio - 2 ** (0.5625 / 12)) < 1e-12);
  assert.ok(ratio > 1.03 && ratio < 1.04, `got ${ratio}`);
});

test('an unpitched slot ignores the note entirely', () => {
  const drum = slot({ baseNote: 48, pitched: false });
  assert.equal(pitchRatio(drum, 24, 120), 1);
  assert.equal(pitchRatio(drum, 96, 120), 1);
});

test('fitBpm scales the rate by tempo over the sample tempo', () => {
  const loop = slot({ baseNote: 48, pitched: false, fitBpm: true, baseBpm: 120 });
  assert.ok(Math.abs(pitchRatio(loop, 48, 180) - 1.5) < 1e-9);
});

test('playbackRate ignores the file\'s own rate, as the loader does', () => {
  // The eboot's loader (v0xb3e520) never reads the `fmt ` rate: a frame is a
  // frame at the engine's 48 kHz. A 22050 Hz file at its base note on a
  // 44100 Hz device therefore advances 48000/44100 frames per output frame --
  // the device correction and nothing for the file, which plays 2.18x fast
  // exactly as it would in the game.
  const v = voiceFor({
    note: 48,
    volume: 127,
    instrument: instrument(),
    level: 1,
    pan: 0.5,
    sampleRate: 22050,
    outputRate: 44100,
    tempo: 120,
  });
  assert.ok(Math.abs(v.playbackRate - 48000 / 44100) < 1e-12);
  assert.equal(v.slot, 0);
  assert.ok(Math.abs(v.gain - 1) < 1e-12);
});

test('gain multiplies note volume by the instrument level', () => {
  assert.equal(velocityGain(127), 1);
  assert.equal(velocityGain(0), 0);
  const v = voiceFor({
    note: 48,
    volume: 96, // the record default, 0x60
    instrument: instrument(),
    level: 0.5,
    pan: 0.5,
    sampleRate: 44100,
    outputRate: 44100,
    tempo: 120,
  });
  assert.ok(Math.abs(v.gain - (96 / 127) * 0.5) < 1e-12);
});

// ⚠️ This test asserted EQUAL-POWER for most of the project's life, and the
// engine turned out to be linear (0x2d39-0x2dda: left = 1 - p, right = p).
// Linear is the worse-sounding law -- amplitude sums to 1 instead of power, so
// a sound dips about 3 dB crossing the centre -- which is exactly why it has to
// be asserted rather than left to taste.
test('pan is linear, 0..1, and NOT equal-power', () => {
  const centre = panGains(0.5);
  assert.equal(centre.left, 0.5);
  assert.equal(centre.right, 0.5);
  assert.ok(
    Math.abs(centre.left ** 2 + centre.right ** 2 - 1) > 0.4,
    'the centre is well below constant power -- that is the point',
  );
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const g = panGains(p);
    assert.ok(Math.abs(g.left + g.right - 1) < 1e-12, `amplitudes sum to 1 at ${p}`);
  }
  assert.equal(panGains(0).left, 1, 'pan 0 is hard left');
  assert.equal(panGains(1).right, 1, 'pan 1 is hard right');
  assert.equal(panGains(-3).left, 1, 'and it clamps');
  assert.equal(panGains(9).right, 1);
});

// The plugin's law above is hard-panning, and the game's output is not: what
// reaches a stereo listener is narrowed to PAN_WIDTH. These are the numbers
// least-squares measured off two recordings of the game, one instrument at pan
// 0 and one at pan 1 -- and 0.261204 was PREDICTED from two interior placements
// before those recordings existed, which is why it is pinned to six figures.
test('the width the game actually delivers matches the recordings', () => {
  const narrowed = (p: number) => panGains(0.5 + (p - 0.5) * PAN_WIDTH);
  // quieter over louder, which is what the least squares measured
  const quietOverLoud = (p: number) => {
    const g = narrowed(p);
    return Math.min(g.left, g.right) / Math.max(g.left, g.right);
  };
  assert.ok(Math.abs(quietOverLoud(1) - 0.261202) < 5e-5, `pan 1: ${quietOverLoud(1)}`);
  assert.ok(Math.abs(quietOverLoud(0) - 0.261202) < 5e-5, `pan 0: ${quietOverLoud(0)}`);
  // The interior placement the whole thing started from: the game put 0.5586 of
  // the energy on the right where this renderer used to put 0.6000.
  assert.ok(Math.abs(narrowed(0.6).right - 0.5586) < 5e-5, `pan 0.6: ${narrowed(0.6).right}`);
  // A constant-power law over a reduced angle is the one candidate that is not
  // affine; it predicts 0.198 at pan 1, and the recordings refute it.
  assert.ok(Math.abs(quietOverLoud(1) - 0.198) > 0.05, 'constant power stays refuted');
  // The three algebraic forms of the one law agree -- which is why none of them
  // could be told apart until a pan was measured at an extreme.
  const c = 1 / (2 * Math.SQRT2); // the mono copy added to both channels
  const b = 1 / (1 + 2 * Math.SQRT2); // the same thing as a cross-bleed
  assert.ok(Math.abs(PAN_WIDTH - (2 - Math.SQRT2)) < 1e-15);
  assert.ok(Math.abs((1 - PAN_WIDTH) / (1 + PAN_WIDTH) - c / (1 + c)) < 1e-12);
  assert.ok(Math.abs(b - c / (1 + c)) < 1e-12);
});

// A keyboard note does not know when it ends when it starts, so the mixer needs
// a handle. `release` closes the gate the way a key coming up does -- it must
// start the release, not truncate the sound, and it must leave untagged voices
// completely alone.
test('release closes the gate on a tagged voice and leaves the others', () => {
  const tone = new Float32Array(48000).fill(0.5);
  const sample = { channels: [tone], sampleRate: 48000, loop: { start: 0, end: 47999 } };
  const mixer = new Mixer(48000);
  const common = { sample, playbackRate: 1, gain: 1, pan: 0.5 } as const;
  mixer.play({ ...common, tag: 7 });
  mixer.play({ ...common });                       // untagged: must survive

  const left = new Float32Array(256);
  const right = new Float32Array(256);
  mixer.render(left, right);
  const before = left[128];
  assert.ok(before > 0, 'both voices are sounding');

  mixer.release(7);
  mixer.render(left, right);
  const after = left[128];
  assert.ok(after > 0, 'the untagged voice still sounds after the other is released');
  assert.ok(after < before, `releasing one voice lowers the mix: ${before} -> ${after}`);

  // A tag nothing carries must be a no-op rather than a silent stop-all.
  mixer.release(999);
  mixer.render(left, right);
  assert.ok(Math.abs(left[128] - after) < 1e-9, 'an unknown tag changes nothing');
});

// ⚠️ THE PROPERTY THE WHOLE PROJECT RESTS ON. The offline render calls
// `Mixer.render` once for a whole song; an AudioWorklet calls it every 128
// frames. If those disagree, the WAV and the live player are different
// instruments and every measurement taken through one does not apply to the
// other.
//
// ⚠️ **The loop below must end on the sample's LAST frame, and that is the
// whole test.** `Voice.finished` used to end any voice whose position reached
// the sample length, looping or not, and the engine's sampler parks a looping
// voice on `loop.end` for one frame before wrapping. When `loop.end` is the
// sample length -- the common case -- that one frame is a window in which the
// voice is thrown away, and a caller asking for 128 frames at a time lands in
// it constantly while a caller asking for a whole song at once never does.
// `Rotary` lost 112 of its first 300 voices to it and came out 4.6 dB down.
// An earlier version of this test used `end: tone.length - 1` and passed
// against the bug.
test('the mixer renders the same audio whatever the block size', () => {
  const tone = new Float32Array(4800);
  for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  const sample = { channels: [tone], sampleRate: 48000, loop: { start: 0, end: tone.length } };
  const spec = {
    sample,
    playbackRate: 1,
    gain: 0.8,
    pan: 0.5,
    endFrame: 6000,
    release: 480,
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15 },
    // The pieces a real instrument brings that a bare tone does not.
    filter: {
      settings: { cutoff: 0.4, resonance: 0.5, keyTrack: 1, envAmount: 0.5 },
      envelope: { attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.2 },
    },
    lfos: [
      { rate: 0.3, depth: 0.4, spread: 0 },
      { rate: 0.2, depth: 0.3, spread: 0 },
      { rate: 0.1, depth: 0.5, spread: 0 },
    ],
    drive: 0.4,
    random: () => 0.25,
  } as const;

  const run = (block: number): Float32Array => {
    const mixer = new Mixer(48000);
    // Many voices, staggered: one voice on its own was block-independent, and
    // what a song has that a single note does not is a pool of them starting
    // and finishing at different moments.
    for (let v = 0; v < 60; v += 1) {
      mixer.play({
        ...spec,
        startFrame: 1000 + v * 137,
        endFrame: 1000 + v * 137 + 3000 + v * 11,
        playbackRate: 1 + v * 0.01,
      });
    }
    const left = new Float32Array(24000);
    const right = new Float32Array(24000);
    for (let at = 0; at < left.length; at += block) {
      const size = Math.min(block, left.length - at);
      mixer.render(left.subarray(at, at + size), right.subarray(at, at + size));
    }
    return left;
  };

  const whole = run(24000);
  for (const block of [128, 512, 4096]) {
    const chunked = run(block);
    let err = 0;
    let sig = 0;
    for (let i = 0; i < whole.length; i += 1) {
      err += (whole[i] - chunked[i]) ** 2;
      sig += whole[i] ** 2;
    }
    const db = 10 * Math.log10(err / Math.max(sig, 1e-30));
    assert.ok(db < -100, `block ${block} differs from one call by ${db.toFixed(1)} dB`);
  }
});

// ❗ A one-step `triangle_wave` note clicked at both ends. Its attack and its
// release are 12 and 38 frames, both shorter than a block, and the engine ramps
// each across the whole chunk that follows the event -- a note starts and a
// gate closes only at a chunk's top (`0x1cc6`, `0x1f65`). On the mixer's own
// block grid the ramp ran to the next boundary instead, so how long a note took
// to fade depended on where in a block it happened to end: 24 frames for one,
// 232 for the next.
test('a stage shorter than a block is ramped across the block after its event, wherever that falls', () => {
  const flat: SampleBuffer = {
    channels: [new Float32Array(4800).fill(0.5)],
    sampleRate: 48000,
    loop: { start: 0, end: 4800 },
  };
  // `triangle_wave` at modulation 0: a stage lasts `param² × 4` seconds.
  const envelope = { attack: 0.008 ** 2 * 4, decay: 0, sustain: 1, release: 0.014 ** 2 * 4 };
  // The first call of each pair advances by a 250th of the segment (`0x201f`).
  const head = 256 / 48000 / 250;
  for (const start of [0, 100, 250]) {
    for (const length of [1000, 1100, 1250]) {
      const mixer = new Mixer(48000);
      mixer.play({
        sample: flat, playbackRate: 1, gain: 1, pan: 0,
        startFrame: start, endFrame: start + length, envelope,
      });
      const left = new Float32Array(4096);
      const right = new Float32Array(4096);
      mixer.render(left, right);
      const where = `start ${start}, length ${length}`;
      const attackS = head / envelope.attack;
      assert.ok(
        Math.abs(left[start + 128] - 0.5 * (attackS + (1 - attackS) * 0.5)) < 1e-4,
        `${where}: half way up at the onset block's middle, ${left[start + 128]}`,
      );
      assert.equal(left[start + 256], 0.5, `${where}: full from the second block`);
      const gate = start + length;
      const releaseS = 1 - head / envelope.release;
      assert.ok(
        Math.abs(left[gate + 128] - 0.5 * releaseS * 0.5) < 1e-4,
        `${where}: half way down a block after the gate, ${left[gate + 128]}`,
      );
      assert.ok(left[gate + 255] > 0, `${where}: still sounding on the block's last frame`);
      assert.ok(left.subarray(gate + 256).every((v) => v === 0), `${where}: silent after it`);
    }
  }
});

// ❗ Ours, not the engine's (question 61): with `declick` the release lasts at
// least 20 ms, so `triangle_wave`'s 0.8 ms is no longer stretched over just one
// block, and the ladder's tail fades instead of stopping when the record would
// be freed. Without it the voice is the engine's, which the test above pins.
test('declick holds a short release to 20 ms and fades what a shut ladder holds', () => {
  const flat: SampleBuffer = {
    channels: [new Float32Array(4800).fill(0.5)],
    sampleRate: 48000,
    loop: { start: 0, end: 4800 },
  };
  const run = (declick: boolean, filtered: boolean) => {
    const mixer = new Mixer(48000);
    mixer.play({
      sample: flat, playbackRate: 1, gain: 1, pan: 0,
      endFrame: 2048,
      envelope: { attack: 0, decay: 0, sustain: 1, release: 0.014 ** 2 * 4 },
      // `e_perc_1` at full modulation, in miniature: envelope B shuts the
      // cutoff within a millisecond of the gate and the ladder freezes on
      // whatever it held.
      filter: filtered
        ? {
            settings: { cutoff: 0.3, resonance: 0, keyTrack: 0, envAmount: 0.99 },
            envelope: { attack: 0, decay: 0, sustain: 1, release: 0.001 },
          }
        : undefined,
      declick,
    });
    const left = new Float32Array(8192);
    mixer.render(left, new Float32Array(8192));
    return left;
  };
  const lastSound = (x: Float32Array) => {
    let i = x.length - 1;
    while (i > 0 && x[i] === 0) i -= 1;
    return i;
  };
  // The release alone: a block without declick, 20 ms -- 960 frames -- with it.
  assert.equal(lastSound(run(false, false)), 2048 + 255);
  const held = lastSound(run(true, false)) - 2048;
  assert.ok(held >= 960 && held < 960 + 256, `the release lasts ${held} frames`);
  // The shut ladder: the engine drops what it holds in one frame ...
  const bare = run(false, true);
  const end = lastSound(bare);
  assert.ok(Math.abs(bare[end]) > 0.01, `the engine's last frame holds ${bare[end]}`);
  // ... and declick takes it down over 20 ms: nothing after the gate moves
  // faster than the ladder's own fall (0.0024 a frame here, against the
  // engine's 0.127 in one), and the voice still ends.
  const soft = run(true, true);
  let worst = 0;
  for (let i = 2049; i < soft.length; i += 1) worst = Math.max(worst, Math.abs(soft[i] - soft[i - 1]));
  assert.ok(worst < 0.005, `the largest step after the gate is ${worst}`);
  const over = lastSound(soft);
  assert.ok(over < 2048 + 960 + 256 + 960, `the tail ends at ${over}`);
});

test('samplesPerStep converts tempo to frames', () => {
  // 120 BPM, 4 steps per beat, 48 kHz -> half a second per beat, 6000 per step.
  assert.equal(samplesPerStep(48000, 120, 4), 6000);
  assert.throws(() => samplesPerStep(48000, 0), RangeError);
});

// --------------------------------------------------------------------- splits

test('a one-slot instrument sends every note to slot 0', () => {
  // The game's own shape for these: bounds 87, then zeros.
  const inst = instrument({ splitNotes: [87, 0, 0, 0, 0, 0, 0, 0, 0] });
  for (const note of [0, 40, 60, 127]) {
    assert.equal(resolveSlot(inst, note, 1), 0);
  }
});

test('a bound belongs to the zone above it — the real piano', () => {
  // The game's piano.rinst: bounds 87, 66, 54, 40, 30 over bases 84, 72, 60,
  // 48, 36. Slot i owns splitNotes[i+1] <= note < splitNotes[i].
  const inst = instrument({
    slots: [slot({ baseNote: 84 }), slot({ baseNote: 72 }), slot({ baseNote: 60 }),
            slot({ baseNote: 48 }), slot({ baseNote: 36 })],
    splitNotes: [87, 66, 54, 40, 30, 0, 0, 0, 0],
  });
  const at = (n: number) => resolveSlot(inst, n, 5);

  assert.equal(at(127), 0, 'above every bound stays in the first zone');
  assert.equal(at(66), 0, 'a bound belongs to the zone above it');
  assert.equal(at(65), 1);
  assert.equal(at(54), 1);
  assert.equal(at(53), 2);
  assert.equal(at(40), 2);
  assert.equal(at(39), 3);
  assert.equal(at(30), 3);
  assert.equal(at(29), 4);
  assert.equal(at(0), 4, 'below every bound stays in the last zone');
});

test('key splits: bass_guitar reads the same way', () => {
  // bounds 87, 42, 31, 20 over bases 48, 36, 28, 28.
  const inst = instrument({
    slots: [slot({ baseNote: 48 }), slot({ baseNote: 36 }),
            slot({ baseNote: 28 }), slot({ baseNote: 28 })],
    splitNotes: [87, 42, 31, 20, 0, 0, 0, 0, 0],
  });
  const at = (n: number) => resolveSlot(inst, n, 4);
  assert.equal(at(48), 0, "the top slot's own base note lands in it");
  assert.equal(at(42), 0);
  assert.equal(at(41), 1);
  assert.equal(at(36), 1, "and so does the second slot's");
  assert.equal(at(31), 1);
  assert.equal(at(30), 2);
  assert.equal(at(28), 2, 'and the third');
  assert.equal(at(20), 2);
  assert.equal(at(19), 3);
});

// The live page shows two numbers for the same music, and they differ by a lot:
// the sampler voices actually rendering, and the notes those came out of. A
// stacked instrument plays up to five layers out of ONE of the engine's 32
// records, so a meter that showed only voices read as the cap being ignored.
// `tag` is what groups them, and `packages/lbp-tracker-web/src/live.ts` tags by note for exactly this.
test('counts separates sampler voices from the notes they came out of', () => {
  const tone = new Float32Array(48000).fill(0.5);
  const sample = { channels: [tone], sampleRate: 48000, loop: { start: 0, end: 47999 } };
  const mixer = new Mixer(48000);
  const common = { sample, playbackRate: 1, gain: 1, pan: 0.5 } as const;
  mixer.play({ ...common, tag: 4 });   // three layers of
  mixer.play({ ...common, tag: 4 });   // one note, out of
  mixer.play({ ...common, tag: 4 });   // one record
  mixer.play({ ...common, tag: 5 });   // a second note
  mixer.play({ ...common });           // an untagged voice counts as its own
  // Not started yet: in `total`, but nothing is sounding out of it.
  mixer.play({ ...common, tag: 6, startFrame: 4800 });

  const before = mixer.counts();
  assert.deepEqual(before, { total: 6, sounding: 5, notes: 3 });

  // Once the delayed voice starts it is a fourth note and a sixth voice.
  const left = new Float32Array(9600);
  const right = new Float32Array(9600);
  mixer.render(left, right);
  assert.deepEqual(mixer.counts(), { total: 6, sounding: 6, notes: 4 });
});

// --------------------------------------------------------------------- mixing

function ramp(n: number): SampleBuffer {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i += 1) data[i] = i / n;
  return { channels: [data], sampleRate: 44100 };
}

test('rate 1 reproduces the sample exactly', () => {
  const mixer = new Mixer(44100);
  const sample = ramp(16);
  mixer.play({ sample, playbackRate: 1, gain: 1, pan: 0 });
  const left = new Float32Array(16);
  const right = new Float32Array(16);
  mixer.render(left, right);
  for (let i = 0; i < 16; i += 1) {
    assert.ok(Math.abs(left[i] - sample.channels[0][i]) < 1e-6, `frame ${i}`);
  }
});

test('rate 2 takes every other frame', () => {
  const mixer = new Mixer(44100);
  const sample = ramp(16);
  mixer.play({ sample, playbackRate: 2, gain: 1, pan: 0 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(Math.abs(left[i] - sample.channels[0][i * 2]) < 1e-6, `frame ${i}`);
  }
});

test('rate 0.5 lands on the midpoints under linear interpolation', () => {
  // Explicitly linear: the default is band-limited and deliberately does not
  // land on the arithmetic midpoint.
  const mixer = new Mixer(44100, linear);
  const sample = ramp(8);
  mixer.play({ sample, playbackRate: 0.5, gain: 1, pan: 0 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  const src = sample.channels[0];
  assert.ok(Math.abs(left[1] - (src[0] + src[1]) / 2) < 1e-6);
  assert.ok(Math.abs(left[3] - (src[1] + src[2]) / 2) < 1e-6);
});

test('startFrame delays a voice sample-accurately', () => {
  const mixer = new Mixer(44100);
  mixer.play({ sample: ramp(8), playbackRate: 1, gain: 1, pan: 0, startFrame: 4 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  for (let i = 0; i < 4; i += 1) assert.equal(left[i], 0, `silent before ${i}`);
  assert.ok(left[5] > 0, 'sounding after the start frame');
});

test('a finished voice is dropped after its block and leaves silence', () => {
  const mixer = new Mixer(44100);
  mixer.play({ sample: ramp(4), playbackRate: 1, gain: 1, pan: 0.5 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  for (let i = 4; i < 8; i += 1) assert.equal(left[i], 0, `silence at ${i}`);
  // `0x3035` frees the record once its chunk is out, not at the sample's end.
  assert.equal(mixer.voiceCount, 1, 'held to the end of its block');
  const rest = new Float32Array(256 - 8);
  mixer.render(rest, new Float32Array(rest.length));
  assert.ok(rest.every((v) => v === 0), 'in silence');
  assert.equal(mixer.voiceCount, 0, 'voice retired');

  mixer.render(left, right);
  assert.ok(left.every((v) => v === 0), 'buffers are cleared each block');
});

test('voices sum, and panning splits them between the channels', () => {
  const mixer = new Mixer(44100);
  const flat: SampleBuffer = {
    channels: [Float32Array.from([1, 1, 1, 1])],
    sampleRate: 44100,
  };
  mixer.play({ sample: flat, playbackRate: 1, gain: 0.5, pan: 0 }); // hard left
  mixer.play({ sample: flat, playbackRate: 1, gain: 0.5, pan: 1 }); // hard right
  const left = new Float32Array(4);
  const right = new Float32Array(4);
  mixer.render(left, right);
  assert.ok(Math.abs(left[0] - 0.5) < 1e-6, 'left carries the left voice only');
  assert.ok(Math.abs(right[0] - 0.5) < 1e-6, 'right carries the right voice only');
});

test('a looping sample keeps sounding past its end', () => {
  const mixer = new Mixer(44100);
  const sample: SampleBuffer = {
    channels: [Float32Array.from([1, 1, 1, 1])],
    sampleRate: 44100,
    loop: { start: 0, end: 4 },
  };
  mixer.play({ sample, playbackRate: 1, gain: 1, pan: 0, endFrame: 16 });
  const left = new Float32Array(16);
  const right = new Float32Array(16);
  mixer.render(left, right);
  for (let i = 0; i < 16; i += 1) {
    assert.ok(Math.abs(left[i] - 1) < 1e-6, `frame ${i} still sounding`);
  }
});

test('rendering is deterministic across runs', () => {
  const render = () => {
    const mixer = new Mixer(44100);
    mixer.play({ sample: ramp(64), playbackRate: 1.37, gain: 0.8, pan: 0.25 });
    const left = new Float32Array(48);
    const right = new Float32Array(48);
    mixer.render(left, right);
    return [...left, ...right];
  };
  assert.deepEqual(render(), render());
});

test('looping is continuous at the wrap — the high-note transient', () => {
  // A sine whose loop region holds an exact number of cycles: the looped signal
  // is then a pure tone, and any discontinuity at the wrap is ours. The frames
  // after loop.end are SILENT, which is what an interpolator reading past the
  // loop pulls in.
  //
  // ⚠️ The playback rate must be FRACTIONAL. At rate 1.0 every position lands
  // on an integer, no interpolation crosses the boundary, and the test passes
  // whether or not the bug is present -- which is how the first version of it
  // was written, and it was vacuous.
  const rate = 48000;
  const freq = 500;
  const loopStart = 480;
  const loopEnd = loopStart + 96 * 20;
  const data = new Float32Array(loopEnd + 64);
  for (let i = 0; i < loopEnd; i += 1) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.8;
  }

  const sample = {
    channels: [data],
    sampleRate: rate,
    loop: { start: loopStart, end: loopEnd },
  };

  const playbackRate = 0.5442; // what a 48 kHz sample an octave down actually gets
  const outHz = freq * playbackRate;
  const allowed = 0.8 * 0.5 * 2 * Math.sin((Math.PI * outHz) / rate);

  const worstStep = (interp: typeof linear): number => {
    const mixer = new Mixer(rate, interp);
    mixer.play({ sample, playbackRate, gain: 1, pan: 0.5, endFrame: 20000 });
    const left = new Float32Array(20000);
    const right = new Float32Array(20000);
    mixer.render(left, right);
    let worst = 0;
    for (let i = 900; i < 19000; i += 1) {
      worst = Math.max(worst, Math.abs(left[i] - left[i - 1]));
    }
    return worst;
  };

  for (const [name, interp] of [['cubic', cubic], ['sinc8', sinc8]] as const) {
    const worst = worstStep(interp);
    assert.ok(
      worst < allowed * 1.1,
      `${name}: worst step ${worst.toFixed(4)} against ${allowed.toFixed(4)} for a ` +
        `continuous sine — the loop wrap is discontinuous`,
    );

    // And the same interpolator ignoring the loop must FAIL that bar, or this
    // test proves nothing.
    const blind: typeof linear = (d, p) => interp(d, p);
    assert.ok(
      worstStep(blind) > allowed * 1.1,
      `${name}: ignoring the loop should have been caught, so this assertion is vacuous`,
    );
  }

  // Still sounding well past the end of the sample data.
  const mixer = new Mixer(rate, sinc8);
  mixer.play({ sample, playbackRate, gain: 1, pan: 0.5, endFrame: 20000 });
  const left = new Float32Array(20000);
  const right = new Float32Array(20000);
  mixer.render(left, right);
  let tail = 0;
  for (let i = 19000; i < 19500; i += 1) tail = Math.max(tail, Math.abs(left[i]));
  assert.ok(tail > 0.3, 'the loop should still be sounding past the sample end');
});

test('the attack is not wrapped into the loop', () => {
  // Before reaching loop.start the taps behind the cursor are the attack and
  // must be read as they stand.
  const data = new Float32Array(200);
  for (let i = 0; i < 100; i += 1) data[i] = 1;       // attack: DC 1
  for (let i = 100; i < 200; i += 1) data[i] = -1;    // loop region: DC -1
  const mixer = new Mixer(48000, cubic);
  mixer.play({
    sample: { channels: [data], sampleRate: 48000, loop: { start: 100, end: 200 } },
    playbackRate: 1, gain: 1, pan: 0,
    endFrame: 400,
  });
  const left = new Float32Array(400);
  const right = new Float32Array(400);
  mixer.render(left, right);
  assert.ok(Math.abs(left[50] - 1) < 1e-6, 'the attack plays as recorded');
  assert.ok(Math.abs(left[150] + 1) < 1e-6, 'the loop region plays as recorded');
  assert.ok(Math.abs(left[350] + 1) < 1e-6, 'and keeps looping');
});

test('the optional decay is off by default and exact when set', () => {
  const flat = { channels: [new Float32Array(48000).fill(1)], sampleRate: 48000 };

  // Off by default: a voice must not fade on its own.
  const plain = new Mixer(48000);
  plain.play({ sample: flat, playbackRate: 1, gain: 1, pan: 0, endFrame: 48000 });
  const l0 = new Float32Array(48000);
  const r0 = new Float32Array(48000);
  plain.render(l0, r0);
  assert.ok(Math.abs(l0[0] - l0[47000]) < 1e-6, 'no decay unless asked for');

  // 20 dB/s must be exactly 20 dB down after one second.
  const decaying = new Mixer(48000);
  decaying.play({
    sample: flat, playbackRate: 1, gain: 1, pan: 0,
    endFrame: 48000, decayDbPerSecond: 20,
  });
  const l1 = new Float32Array(48000);
  const r1 = new Float32Array(48000);
  decaying.render(l1, r1);
  const dropDb = 20 * Math.log10(l1[47999] / l1[0]);
  assert.ok(Math.abs(dropDb + 20) < 0.1, `expected -20 dB after a second, got ${dropDb.toFixed(2)}`);
});

// ----------------------------------------------------------- live expression

/**
 * `Mixer.expression` is MPE's three dimensions arriving while a note sounds.
 *
 * Each test pins the live control against the equivalent *baked* voice -- a
 * higher `playbackRate`, a lower `gain`, a different cutoff -- because that is
 * the claim worth making: expressing a voice must land in exactly the same
 * arithmetic the spec would have, not merely somewhere nearby.
 */
const FLAT_ENV = { attack: 0, decay: 0, sustain: 1, release: 0 };

function rendered(mixer: Mixer, frames: number): Float32Array {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  mixer.render(left, right);
  return left;
}

test('a live bend of +12 semitones is exactly a doubled rate', () => {
  const sample = ramp(256);
  const bent = new Mixer(44100);
  bent.play({ sample, playbackRate: 1, gain: 1, pan: 0.5, tag: 7 });
  bent.expression(7, 12);
  // A tag nobody is carrying must be a no-op, not a throw and not a broadcast.
  bent.expression(999, -24);

  const fast = new Mixer(44100);
  fast.play({ sample, playbackRate: 2, gain: 1, pan: 0.5 });

  const a = rendered(bent, 32);
  const b = rendered(fast, 32);
  for (let i = 0; i < 32; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `frame ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('live pressure is exactly a lower gain', () => {
  const sample = ramp(256);
  const pressed = new Mixer(44100);
  pressed.play({ sample, playbackRate: 1, gain: 1, pan: 0.5, tag: 1 });
  pressed.expression(1, undefined, 0.25);

  const quiet = new Mixer(44100);
  quiet.play({ sample, playbackRate: 1, gain: 0.25, pan: 0.5 });

  const a = rendered(pressed, 32);
  const b = rendered(quiet, 32);
  for (let i = 0; i < 32; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `frame ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('an omitted dimension keeps the value it had', () => {
  // ⚠️ The whole reason the fields are optional: a controller sends bend,
  // pressure and slide as separate messages, so the second must not reset what
  // the first set. This failed to matter until it did -- a bend followed by a
  // pressure would have snapped the note back to its written pitch.
  const sample = ramp(256);
  const both = new Mixer(44100);
  both.play({ sample, playbackRate: 1, gain: 1, pan: 0.5, tag: 4 });
  both.expression(4, 12);
  both.expression(4, undefined, 0.5);

  const baked = new Mixer(44100);
  baked.play({ sample, playbackRate: 2, gain: 0.5, pan: 0.5 });

  const a = rendered(both, 32);
  const b = rendered(baked, 32);
  for (let i = 0; i < 32; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `frame ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('live timbre offsets the cutoff, and clamps into range', () => {
  const sample = ramp(512);
  const settings = { cutoff: 0.3, resonance: 0.2, keyTrack: 0, envAmount: 0 };
  const play = (mixer: Mixer, cutoff: number, tag?: number) =>
    mixer.play({
      sample, playbackRate: 1, gain: 1, pan: 0.5, tag,
      filter: { settings: { ...settings, cutoff }, envelope: FLAT_ENV },
    });

  // ⚠️ The expressed voice takes the per-frame ladder path and the baked one the
  // solved-once path, which is exactly what makes this worth asserting: with
  // `envAmount` 0 and a still rate the two must agree to the last bit.
  const slid = new Mixer(44100);
  play(slid, settings.cutoff, 9);
  slid.expression(9, undefined, undefined, 0.4);
  const baked = new Mixer(44100);
  play(baked, 0.7);

  const a = rendered(slid, 64);
  const b = rendered(baked, 64);
  for (let i = 0; i < 64; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `frame ${i}: ${a[i]} vs ${b[i]}`);
  }

  // Past the top the offset clamps rather than running the ladder off its range.
  const over = new Mixer(44100);
  play(over, 0.9, 11);
  over.expression(11, undefined, undefined, 5);
  const wide = new Mixer(44100);
  play(wide, 1);
  const c = rendered(over, 64);
  const d = rendered(wide, 64);
  for (let i = 0; i < 64; i += 1) {
    assert.ok(Math.abs(c[i] - d[i]) < 1e-9, `clamped frame ${i}`);
  }
});

// ------------------------------------------------------------------ the morph

/**
 * The note's modulation is not a per-voice constant.
 *
 * ⚠️ It picks a point inside every one of the 27 `Params` ranges, and
 * `fmodextinput.prx` RAMPS it between a note's control points exactly as it
 * ramps volume and pitch: `sub_0x3930` writes its slide rate at `0x3e8a` and
 * `sub_0x1c60` advances it at `0x1f4a` and re-derives the parameters. This
 * project held it flat for the whole voice, which was wrong on 34,449 corpus
 * notes -- and on 30,170 of them it moved some parameter by 0.35 or more.
 */
test('a moving modulation moves what it feeds', async () => {
  const { OUTPUT_PARAMS } = await import('../src/params.ts');
  const flat = { channels: [new Float32Array(2000).fill(1)], sampleRate: 48000 };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  // The output level runs 0.25 at modulation 0 to 1.0 at modulation 1, so a
  // note that sweeps the modulation should end four times as loud as it starts.
  params[OUTPUT_PARAMS.level] = { x: 0.25, y: 1 };

  const mixer = new Mixer(48000);
  mixer.play({
    sample: flat, playbackRate: 1, pan: 0.5,
    // The gain the spec was built with, i.e. at the opening modulation. Low
    // enough that four times it stays under the record's ±1 clip (`0x2e00`).
    gain: 0.25,
    morph: {
      params,
      // 0.5 in the placement means "leave the instrument's own send alone", and
      // the engine stores it as `2*send - 1`, so a neutral offset is 0.
      echoOffset: 0,
      opening: 0.25,
      points: [{ frame: 0, value: 0 }, { frame: 512, value: 1 }],
    },
  });
  const left = new Float32Array(640);
  const right = new Float32Array(640);
  mixer.render(left, right);

  // `panGains(0.5)` is the linear law's half and half, so the level shows up
  // halved. ❗ **Derived at both ends of each 256-frame block and ramped
  // between**: the engine's own DSP block (`0x0170` calls the block function
  // with `mov esi, 0x100`), evaluated at its start and its end modulation and
  // stepped per sample (`0x2d78`). So frame 255 is one step short of what
  // frame 256 opens on, not what frame 0 was given -- that was this test's
  // earlier reading, and it was a staircase the engine does not have.
  const k = 0.25 * 0.5;
  assert.ok(Math.abs(left[0] - k) < 1e-6, `opening: ${left[0]}`);
  assert.ok(
    Math.abs(left[255] - k * (1 + 1.5 * (255 / 256))) < 1e-6,
    `ramped to the block's end: ${left[255]}`,
  );
  assert.ok(Math.abs(left[256] - k * 2.5) < 1e-6, `half way: ${left[256]}`);
  assert.ok(Math.abs(left[512] - k * 4) < 1e-6, `arrived: ${left[512]}`);
  assert.ok(Math.abs(left[639] - k * 4) < 1e-6, `and holds: ${left[639]}`);
});

test('a modulation that does not move changes nothing at all', async () => {
  const { OUTPUT_PARAMS } = await import('../src/params.ts');
  // ⚠️ This is the invariant that lets the change ship: 96.4% of corpus notes
  // hold their modulation, and they must render byte for byte as before. Proved
  // on the corpus too -- 25 s of `Indestructible`, 6,126 notes and none of them
  // moving, gives the same md5 with and without this code.
  const flat = { channels: [new Float32Array(2000).fill(1)], sampleRate: 48000 };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[OUTPUT_PARAMS.level] = { x: 0.25, y: 1 };

  const without = new Mixer(48000);
  without.play({ sample: flat, playbackRate: 1, pan: 0.5, gain: 1 });
  const withFlat = new Mixer(48000);
  withFlat.play({
    sample: flat, playbackRate: 1, pan: 0.5, gain: 1,
    morph: { params, echoOffset: 0, opening: 0.25, points: [{ frame: 0, value: 0 }, { frame: 512, value: 0 }] },
  });

  const a = new Float32Array(640);
  const b = new Float32Array(640);
  const c = new Float32Array(640);
  const d = new Float32Array(640);
  without.render(a, b);
  withFlat.render(c, d);
  for (let i = 0; i < 640; i += 1) {
    assert.equal(c[i], a[i], `frame ${i}`);
    assert.equal(d[i], b[i], `frame ${i}`);
  }
});

test('a moving modulation moves the echo send too', async () => {
  const { OUTPUT_PARAMS } = await import('../src/params.ts');
  // ⚠️ The echo is the only send the modulation reaches:
  // `clamp01(bipolar(Params[25], 2*placementSend - 1))`. The reverb is the
  // placement's field alone. Both readings are in `packages/lbp-tracker-lib/src/render.ts`.
  //
  // This is also the one that could not be done until the voice reported what
  // it wrote: the buses belong to the mixer, and it summed each voice's whole
  // span at one send.
  const flat = { channels: [new Float32Array(2000).fill(1)], sampleRate: 48000 };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[OUTPUT_PARAMS.send] = { x: 0, y: 1 };
  // ❗ The level has to be held up, or the voice is silent and every assertion
  // below compares one zero against another. The first version of this test did
  // exactly that and passed.
  params[OUTPUT_PARAMS.level] = { x: 1, y: 1 };

  const mixer = new Mixer(48000);
  mixer.play({
    sample: flat, playbackRate: 1, pan: 0.5, gain: 1,
    // The opening value, which is what the send is at modulation 0.
    echoSend: 0,
    morph: {
      params,
      echoOffset: 0,
      opening: 1,
      points: [{ frame: 0, value: 0 }, { frame: 512, value: 1 }],
    },
  });
  const left = new Float32Array(640);
  const right = new Float32Array(640);
  const echo: [Float32Array, Float32Array] = [new Float32Array(640), new Float32Array(640)];
  mixer.render(left, right, { echo });

  // The dry signal is flat, so the bus is the send itself -- but only if there
  // IS a dry signal, which is what the first assertion is for.
  assert.ok(left[256] > 0.4, `the voice sounds: ${left[256]}`);
  assert.ok(Math.abs(echo[0][0]) < 1e-6, `silent at the start: ${echo[0][0]}`);
  // ❗ The send is a staircase on the engine's 256-frame block, so it is still
  // at its opening value at frame 255 and steps at 256.
  assert.ok(
    Math.abs(echo[0][255]) < 1e-6,
    `still at the opening send at the block's end: ${echo[0][255]}`,
  );
  assert.ok(
    Math.abs(echo[0][256] - left[256] * 0.5) < 1e-6,
    `half way: ${echo[0][256]} against ${left[256]}`,
  );
  assert.ok(
    Math.abs(echo[0][512] - left[512]) < 1e-6,
    `all of it by the end: ${echo[0][512]} against ${left[512]}`,
  );
});

test('a voice whose send only rises later still reaches the bus', async () => {
  const { OUTPUT_PARAMS } = await import('../src/params.ts');
  // ⚠️ `needsSends` used to be decided from the opening values, so a voice
  // starting at send 0 was rendered straight into the dry mix and could never
  // reach a bus however far its modulation took it. `Voice.maySend` looks along
  // the whole ramp instead.
  const flat = { channels: [new Float32Array(2000).fill(1)], sampleRate: 48000 };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[OUTPUT_PARAMS.send] = { x: 0, y: 1 };
  params[OUTPUT_PARAMS.level] = { x: 1, y: 1 };
  const mixer = new Mixer(48000);
  mixer.play({
    sample: flat, playbackRate: 1, pan: 0.5, gain: 1, echoSend: 0,
    morph: { params, echoOffset: 0, opening: 1, points: [{ frame: 0, value: 0 }, { frame: 256, value: 1 }] },
  });
  const echo: [Float32Array, Float32Array] = [new Float32Array(512), new Float32Array(512)];
  mixer.render(new Float32Array(512), new Float32Array(512), { echo });
  assert.ok(echo[0][400] > 0.4, `the bus fills once the send arrives: ${echo[0][400]}`);
});

// `0x20e0` frees a record after the chunk whose envelope END value is not
// positive, in whatever stage -- so a struck instrument (sustain 0) gives its
// record back once its decay has run, with the gate still open, and its
// ladder stops with it rather than ringing on.
test('an envelope that decays to nothing frees the record with the gate open', () => {
  const tone = new Float32Array(48000).fill(0.5);
  const sample = { channels: [tone], sampleRate: 48000, loop: { start: 0, end: 47999 } };
  const mixer = new Mixer(48000);
  // Decay 0.01 s from full to 0: 480 frames, inside the second 256-frame block.
  mixer.play({
    sample, playbackRate: 1, gain: 1, pan: 0.5, endFrame: 48000,
    envelope: { attack: 0, decay: 0.01, sustain: 0, release: 0.5 },
  });
  const left = new Float32Array(256);
  const right = new Float32Array(256);
  mixer.render(left, right);
  assert.equal(mixer.voiceCount, 1);
  mixer.render(left, right);
  mixer.render(left, right);
  assert.equal(mixer.voiceCount, 0, 'gone after the chunk the decay ended in, gate or no gate');
});
