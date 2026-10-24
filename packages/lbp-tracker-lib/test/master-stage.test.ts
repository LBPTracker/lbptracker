/**
 * The end of the chain: the game's master bus, ours, or the fold's gain alone.
 *
 * The game's half is checked against what was measured of the game: the
 * WaveHammer's own constant (*The static curve* in
 * steering/lbp-audio-engine.md, from the module running) and the cross-feed a
 * hard-panned voice has in a capture, 0.261202 (*22* in
 * steering/answered-questions.md). The game's with the AGC is checked to be
 * the game's bus and then `audio/agc.ts`, nothing else (the AGC itself is
 * `test/agc.test.ts`'s). The other two are checked against what the tracker
 * did before there was a choice, so that picking them changes nothing.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { WaveHammer } from '../src/audio/compressor.ts';
import { FOLD_CENTRE, FOLD_GAIN, PAN_WIDTH } from '../src/audio/effects.ts';
import { MasterBus, MASTER_DEFAULTS } from '../src/audio/master.ts';
import { Agc } from '../src/audio/agc.ts';
import { MasterStage } from '../src/audio/master-stage.ts';
import { RATE, renderSequencer } from '../src/render.ts';
import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/sequencer/chips.ts';
import { type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';

/** A deterministic stereo signal: an LCG under a slow swell, peaking at `peak`. */
function signal(frames: number, peak: number): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0x100000000 - 0.5;
  };
  for (let i = 0; i < frames; i += 1) {
    const swell = peak * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frames));
    left[i] = swell * 2 * next();
    right[i] = swell * 2 * next();
  }
  return [left, right];
}

const copy = ([l, r]: [Float32Array, Float32Array]): [Float32Array, Float32Array] =>
  [Float32Array.from(l), Float32Array.from(r)];

test('the fold is the one linear operator: the sum grows by its gain, the difference not at all', () => {
  assert.ok(Math.abs(1 + 2 * FOLD_CENTRE - FOLD_GAIN) < 1e-15);
  assert.ok(Math.abs(1 / (1 + 2 * FOLD_CENTRE) - PAN_WIDTH) < 1e-15);
  const input = signal(RATE, 0.9);
  const [left, right] = copy(input);
  new MasterStage(RATE, 'game').run(left, right);
  // The gain the WaveHammer applied, frame by frame, from a second instance.
  const hammer = new WaveHammer();
  for (let i = 0; i < RATE; i += 1) {
    const g = hammer.gainFor(input[0][i], input[1][i]);
    const sum = g * (input[0][i] + input[1][i]);
    const difference = g * (input[0][i] - input[1][i]);
    assert.ok(Math.abs(left[i] + right[i] - FOLD_GAIN * sum) < 1e-6, `sum at ${i}`);
    assert.ok(Math.abs(left[i] - right[i] - difference) < 1e-6, `difference at ${i}`);
  }
});

test('a voice panned hard left reaches the right at 0.2612 of itself, as the game was captured', () => {
  const left = new Float32Array(RATE).fill(0.3);
  const right = new Float32Array(RATE);
  new MasterStage(RATE, 'game').run(left, right);
  // The WaveHammer's gain is common to both, so the ratio holds on every frame.
  for (const i of [0, 1, 63, 64, 1000, RATE - 1]) {
    assert.ok(Math.abs(right[i] / left[i] - 0.261204) < 1e-6, `${right[i] / left[i]} at ${i}`);
  }
  // 0.261202 measured on two captures of the game, pan 0 and pan 1.
  assert.ok(Math.abs(right[RATE - 1] / left[RATE - 1] - 0.261202) < 5e-6);
});

test('below the knee the game\'s bus settles at the WaveHammer\'s −1.84 dB, times the fold', () => {
  // −40 dBFS, well under the knee bottom at −21: only the module's constant.
  const left = new Float32Array(RATE).fill(0.01);
  const right = new Float32Array(RATE).fill(0.01);
  const stage = new MasterStage(RATE, 'game');
  stage.run(left, right);
  // `[state+0x104]` = 0.808766 in the running module.
  assert.ok(Math.abs(left[RATE - 1] / 0.01 - 0.808766 * FOLD_GAIN) < 1e-4);
  assert.ok(Math.abs(stage.deepest - 0.808766) < 1e-4);
});

test('the fold\'s gain alone is what the tracker played before there was a choice', () => {
  const input = signal(4800, 0.9);
  const [left, right] = copy(input);
  const stage = new MasterStage(RATE, 'none');
  stage.run(left, right);
  for (let i = 0; i < left.length; i += 1) {
    assert.equal(left[i], Math.fround(input[0][i] * FOLD_GAIN));
    assert.equal(right[i], Math.fround(input[1][i] * FOLD_GAIN));
  }
  assert.equal(stage.deepest, 1, 'no WaveHammer ran');
});

test('ours is the fold\'s gain and then the glue and the limiter, as before', () => {
  const input = signal(4800, 0.9);
  const [left, right] = copy(input);
  new MasterStage(RATE, MASTER_DEFAULTS).run(left, right);
  const bus = new MasterBus(RATE, MASTER_DEFAULTS);
  for (let i = 0; i < left.length; i += 1) {
    const out = bus.process(input[0][i] * FOLD_GAIN, input[1][i] * FOLD_GAIN);
    assert.equal(left[i], Math.fround(out.left));
    assert.equal(right[i], Math.fround(out.right));
  }
});

test('a mono output takes each gain once, not once per channel', () => {
  // ⚠️ The live page's fast path once multiplied "both" channels of one array.
  for (const choice of ['game', 'agc', 'none', MASTER_DEFAULTS] as const) {
    const [input] = signal(4800, 0.9);
    const mono = Float32Array.from(input);
    const left = Float32Array.from(input);
    const right = Float32Array.from(input);
    new MasterStage(RATE, choice).run(mono, mono);
    new MasterStage(RATE, choice).run(left, right);
    assert.deepEqual(mono, left, `${typeof choice === 'string' ? choice : 'ours'}`);
  }
});

test('choosing the same bus again keeps its state, so a tempo change does not reset it', () => {
  const input = signal(RATE, 0.9);
  const [whole0, whole1] = copy(input);
  new MasterStage(RATE, 'game').run(whole0, whole1);
  const [split0, split1] = copy(input);
  const stage = new MasterStage(RATE, 'game');
  stage.run(split0, split1, 0, RATE / 2);
  stage.set('game');
  stage.run(split0, split1, RATE / 2, RATE);
  assert.deepEqual(split0, whole0);
  assert.deepEqual(split1, whole1);
});

/** One voice, hard left, no echo and no reverb, and a loader with its one sample. */
async function hardLeft() {
  const { groupNotes } = await import('@lbptracker/cwlib/sequencer/notes.ts');
  const { DEFAULT_SLOT } = await import('../src/instrument.ts');
  const rec = (step: number, end: boolean) => ({
    step, pitch: 60, volume: 96, timbre: 0, modulation: 0, subStep: 0 as const, end,
  });
  const { notes } = groupNotes([rec(0, false), rec(6, true)]);
  // One voice, hard left, no echo and no reverb: whatever reaches the right
  // channel came through the fold.
  const seq: Sequencer = {
    uid: 1, name: 'pan', author: '', tempo: 120, swing: 0,
    echoFeedback: 0, echoTime: 1, echoMix: 0, reverb: 5,
    loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [{
      guid: 1, name: 't', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0, level: 1, pan: 0,
      echoSend: 0, reverbSend: 0, key: 0, scale: 0, notes,
      records: new Uint8Array(0), trailingRecords: 0,
    }],
    lengthSteps: 8,
  };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  // The filter open, the envelope held at full sustain, the level at one.
  for (const i of [3, 13, 24]) params[i] = { x: 1, y: 1 };
  const loader = async () => ({
    inst: {
      slots: [DEFAULT_SLOT], sampleGuids: [1], splitNotes: [87, 0, 0, 0, 0, 0, 0, 0, 0],
      numStack: 1, params, arpeggio: [], arpeggiate: false,
    },
    slots: [{
      wav: { channels: [new Float32Array(4800).fill(0.5)], sampleRate: RATE, loop: { start: 0, end: 4800 } },
      base: 60,
    }],
  });
  return { seq, loader };
}

test('a render ends in the game\'s master bus unless asked otherwise', async () => {
  const { seq, loader } = await hardLeft();
  const options = { secondsArg: 1 };
  const plain = await renderSequencer(seq, loader, options);
  const game = await renderSequencer(seq, loader, { ...options, master: 'game' });
  const none = await renderSequencer(seq, loader, { ...options, master: 'none' });
  assert.deepEqual(plain.left, game.left);
  assert.deepEqual(plain.right, game.right);
  assert.ok(game.compressorGain < 1, 'the WaveHammer ran');
  assert.equal(none.compressorGain, 1);
  // Without the fold's narrowing nothing reaches the right at all...
  const loud = none.left.findIndex((v) => Math.abs(v) > 0.01);
  assert.ok(loud >= 0, 'the note sounds');
  assert.equal(Math.max(...none.right.map(Math.abs)), 0);
  // ...and with it, the captured cross-feed, on every frame.
  for (let i = loud; i < loud + 4800; i += 97) {
    assert.ok(Math.abs(game.right[i] / game.left[i] - 0.261204) < 1e-5, `frame ${i}`);
  }
});

/**
 * Frames through the game's bus alone, then through a fresh AGC: what `'agc'`
 * must be, to float32 rounding -- the stage hands the AGC the fold's sum in
 * double, and this one rounds it into the array first.
 */
function largestDifference(a: Float32Array, b: Float32Array): number {
  let most = 0;
  for (let i = 0; i < a.length; i += 1) most = Math.max(most, Math.abs(a[i] - b[i]));
  return most;
}

function gameThenAgc(input: [Float32Array, Float32Array]): [Float32Array, Float32Array] {
  const [left, right] = copy(input);
  new MasterStage(RATE, 'game').run(left, right);
  const agc = new Agc(RATE);
  for (let i = 0; i < left.length; i += 1) {
    agc.process(left[i], right[i]);
    left[i] = agc.left;
    right[i] = agc.right;
  }
  return [left, right];
}

test("the game's with the AGC is the game's bus and then the AGC, nothing else", () => {
  const input = signal(RATE, 0.9);
  const [left, right] = copy(input);
  const stage = new MasterStage(RATE, 'agc');
  stage.run(left, right, 0, RATE / 3);
  stage.run(left, right, RATE / 3, RATE);
  const [l, r] = gameThenAgc(input);
  assert.ok(largestDifference(left, l) < 1e-6 && largestDifference(right, r) < 1e-6);
  // A loud signal: the AGC ran, and took its starting +6 dB back down.
  assert.ok(stage.agcGain !== null && stage.agcGain < 1.9, `${stage.agcGain}`);
  assert.equal(new MasterStage(RATE, 'game').agcGain, null);
});

test("the game's and the game's with the AGC are one kind: a switch keeps the WaveHammer and the AGC", () => {
  const input = signal(RATE, 0.9);
  const [whole0, whole1] = copy(input);
  new MasterStage(RATE, 'agc').run(whole0, whole1);
  const [split0, split1] = copy(input);
  const stage = new MasterStage(RATE, 'agc');
  stage.run(split0, split1, 0, RATE / 2);
  stage.set('agc');
  stage.run(split0, split1, RATE / 2, RATE);
  assert.deepEqual(split0, whole0);
  assert.deepEqual(split1, whole1);
  // Away to the game's alone and back: the AGC resumes where it was.
  const before = stage.agcGain;
  stage.set('game');
  assert.equal(stage.agcGain, null);
  stage.set('agc');
  assert.equal(stage.agcGain, before);
});

test("a render with the AGC is the game's render through the AGC", async () => {
  const { seq, loader } = await hardLeft();
  const options = { secondsArg: 1 };
  const game = await renderSequencer(seq, loader, { ...options, master: 'game' });
  const agc = await renderSequencer(seq, loader, { ...options, master: 'agc' });
  const [left, right] = (() => {
    const l = Float32Array.from(game.left);
    const r = Float32Array.from(game.right);
    const a = new Agc(RATE);
    for (let i = 0; i < l.length; i += 1) {
      a.process(l[i], r[i]);
      l[i] = a.left;
      r[i] = a.right;
    }
    return [l, r];
  })();
  assert.ok(largestDifference(agc.left, left) < 1e-6 && largestDifference(agc.right, right) < 1e-6);
  assert.equal(agc.compressorGain, game.compressorGain);
});
