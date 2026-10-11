import { strict as assert } from 'node:assert';
import test from 'node:test';

import { FOLD_GAIN, Reverb, reverbPreset } from '../src/audio/effects.ts';

const RATE = 48000;
const BLOCK = 128;

// The three names the AudioWorkletGlobalScope gives the module, stubbed before
// it is imported: `registerProcessor` runs at load.
const scope = globalThis as unknown as Record<string, unknown>;
scope.sampleRate = RATE;
scope.registerProcessor = () => {};
scope.AudioWorkletProcessor = class {
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage() {} };
};
const { MixerProcessor } = await import('../src/audio/mixer-worklet.ts');

type Processor = InstanceType<typeof MixerProcessor>;

function effects(reverbSetting: number, framesPerStep: number) {
  return {
    type: 'effects',
    echoTime: 1,
    framesPerStep,
    feedback: 0,
    mix: 0,
    reverbSetting,
    echoOn: false,
    reverbOn: true,
    clip: true,
    master: 'none',
  };
}

function send(processor: Processor, message: unknown): void {
  (processor.port as unknown as { onmessage(event: { data: unknown }): void }).onmessage({ data: message });
}

function reverbOf(processor: Processor): Reverb {
  return (processor as unknown as { reverb: Reverb }).reverb;
}

/** `blocks` render quanta of the processor's left channel, with no voices. */
function run(processor: Processor, blocks: number): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b += 1) {
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    processor.process([], [[left, right]]);
    out.set(left, b * BLOCK);
  }
  return out;
}

test('the same reverb setting re-sent keeps the tail, re-applied as the game does', () => {
  const processor = new MixerProcessor();
  send(processor, effects(3, 6000));
  const reverb = reverbOf(processor);
  // An impulse straight into the kept instance, and the same into a reference.
  reverb.process(1, 1);
  const reference = new Reverb(RATE, reverbPreset(3));
  reference.process(1, 1);

  const before = run(processor, 16);
  // A tempo change: the message `Player.setSettings` sends.
  send(processor, effects(3, 5000));
  assert.equal(reverbOf(processor), reverb, 'the same instance');
  const after = run(processor, 32);

  const expected = new Float32Array(before.length + after.length);
  for (let i = 0; i < expected.length; i += 1) {
    if (i === before.length) reference.reconfigure(reverbPreset(3));
    expected[i] = reference.process(0, 0).left * FOLD_GAIN;
  }
  let peak = 0;
  for (let i = 0; i < after.length; i += 1) {
    peak = Math.max(peak, Math.abs(after[i]));
    assert.ok(Math.abs(after[i] - expected[before.length + i]) < 1e-6, `frame ${before.length + i}`);
  }
  assert.ok(peak > 1e-3, `a tail after the re-send, peak ${peak}`);
});

test('a changed reverb setting is re-applied to the same reverb, as the game does', () => {
  // The game keeps the chain and re-applies the new preset's coefficients over
  // the lengths it was built with; only switching the reverb on builds anew.
  const processor = new MixerProcessor();
  send(processor, effects(3, 6000));
  const first = reverbOf(processor);
  first.process(1, 1);
  const reference = new Reverb(RATE, reverbPreset(3));
  reference.process(1, 1);
  run(processor, 8);
  for (let i = 0; i < 8 * BLOCK; i += 1) reference.process(0, 0);
  send(processor, effects(5, 6000));
  assert.equal(reverbOf(processor), first, 'the same instance');
  reference.reconfigure(reverbPreset(5));
  const after = run(processor, 32);
  for (let i = 0; i < after.length; i += 1) {
    const expected = reference.process(0, 0).left * FOLD_GAIN;
    assert.ok(Math.abs(after[i] - expected) < 1e-6, `frame ${i}`);
  }
  send(processor, { ...effects(5, 6000), reverbOn: false });
  assert.equal(reverbOf(processor), null);
  send(processor, effects(5, 6000));
  assert.notEqual(reverbOf(processor), first, 'switched back on: a new reverb');
});
