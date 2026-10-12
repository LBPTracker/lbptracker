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

test('a voice posted on a context frame starts there, whichever block the message lands in', () => {
  // The player names the frame (`play.at`); the worklet counts the delay from
  // its own `currentFrame`. Counted from the message's arrival, bursts landed a
  // render quantum apart from one another.
  const first = (arrival: number) => {
    const processor = new MixerProcessor();
    scope.currentFrame = 0;
    send(processor, {
      type: 'load',
      sample: { id: 's', channels: [new Float32Array(4800).fill(0.5)], sampleRate: RATE },
    });
    send(processor, { ...effects(3, 6000), reverbOn: false });
    const out = new Float32Array(16 * BLOCK);
    for (let b = 0; b < 16; b += 1) {
      scope.currentFrame = b * BLOCK;
      if (b === arrival) {
        send(processor, {
          type: 'play', sampleId: 's', at: 10 * BLOCK + 40,
          voice: { playbackRate: 1, gain: 1, pan: 0.5, startFrame: 0, endFrame: 1000 },
        });
      }
      const left = new Float32Array(BLOCK);
      const right = new Float32Array(BLOCK);
      processor.process([], [[left, right]]);
      out.set(left, b * BLOCK);
    }
    return out.findIndex((v) => v !== 0);
  };
  assert.equal(first(2), 10 * BLOCK + 40);
  assert.equal(first(7), 10 * BLOCK + 40, 'a later message, the same frame');
  delete scope.currentFrame;
});

test("the AGC's gain rides on the voice report, and only while the AGC is the bus", () => {
  const reported = (master: string) => {
    const processor = new MixerProcessor();
    const posted: { type: string; agc?: number | null }[] = [];
    (processor.port as unknown as { postMessage(m: unknown): void }).postMessage = (m) => {
      posted.push(m as { type: string; agc?: number | null });
    };
    send(processor, { ...effects(3, 6000), reverbOn: false, master });
    run(processor, 40);
    return posted.filter((m) => m.type === 'voices').map((m) => m.agc);
  };
  const agc = reported('agc');
  assert.ok(agc.length > 0);
  // Silence holds it where it starts, +6 dB.
  for (const gain of agc) assert.ok(gain !== null && gain !== undefined && Math.abs(20 * Math.log10(gain) - 6) < 0.01);
  assert.deepEqual(reported('game'), reported('game').map(() => null));
});
