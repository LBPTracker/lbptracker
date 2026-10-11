import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  PRESET_SLOT,
  REVERB_EARLY_SETS,
  REVERB_PAIR_RATIOS,
  REVERB_PRESETS,
  REVERB_NAMES,
  REVERB_REMAP,
  REVERB_SETTINGS,
  REVERB_TAP_SETS,
  Reverb,
  millibelToLinear,
  reverbPreset,
  reverbSummary,
} from '../src/audio/effects.ts';

const RATE = 48000;

/** A mono impulse into the send bus, the way the renderer feeds it. */
function impulseResponse(preset: readonly number[], frames: number): Float32Array {
  const reverb = new Reverb(RATE, preset);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = i === 0 ? 1 : 0;
    const r = reverb.process(v, v);
    out[i * 2] = r.left;
    out[i * 2 + 1] = r.right;
  }
  return out;
}

test('the tables are the ones read out of the eboot', () => {
  assert.equal(REVERB_PRESETS.length, 12, '12 presets at v0x1062620');
  for (const p of REVERB_PRESETS) assert.equal(p.length, 11, 'eleven slots each');
  assert.deepEqual([...REVERB_REMAP], [3, 6, 8, 5, 11, 2, 0, 0]);
  assert.equal(REVERB_TAP_SETS.length, 19, '19 tap sets at v0xe1d5d0');
  for (const set of REVERB_TAP_SETS) {
    assert.ok(set.length >= 8 && set.length <= 10, `${set.length} taps`);
    for (const ms of set) assert.ok(ms > 0 && ms < 100, `${ms} ms is not a plausible tap`);
  }
  assert.equal(REVERB_EARLY_SETS.length, 7);
  for (const set of REVERB_EARLY_SETS) assert.equal(set.length, 9);
  assert.deepEqual([...REVERB_PAIR_RATIOS], [0.93, 1.06]);
  // Slot 0 is pinned at -800 by the constructor and never written from the table.
  for (const p of REVERB_PRESETS) assert.equal(p[PRESET_SLOT.dryLevel], -800);
});

test('millibels convert the way v0x3fcd50 does, floor included', () => {
  assert.equal(millibelToLinear(0), 1);
  assert.ok(Math.abs(millibelToLinear(-200) - 10 ** -1) < 1e-9, '-200 mB is -20 dB');
  assert.ok(Math.abs(millibelToLinear(-100) - 10 ** -0.5) < 1e-9);
  // Below -80 dB the engine returns a hard zero rather than something tiny.
  assert.equal(millibelToLinear(-800), 0, 'the -8000 floor is on v*10, so -800 hits it');
  assert.equal(millibelToLinear(-1000), 0);
});

test('the DSP is a pure send effect: the dry level is a hard zero', () => {
  // slot 0 = -800 on every preset, and the floor makes that exactly 0. So the
  // reverb never passes its input through, which is why the renderer adds its
  // own dry mix and this class only returns wet.
  for (let setting = 0; setting <= 5; setting += 1) {
    const reverb = new Reverb(RATE, reverbPreset(setting));
    assert.equal(reverb.dryLevel, 0, `setting ${setting}`);
  }
});

test('slot 1 is the late level and slot 2 the early level, and only slot 2 is divided by 100', () => {
  // v0x3fcdd5/v0x3fce0f/v0x3fce49 write slots 0, 1, 2 into [param+0x4c],
  // [param+0x48] and [param+0x50]; the block processor uses +0x4c on the input
  // (dry), +0x48 on the delayed comb sum (late) and +0x50 on the early taps.
  //
  // ⚠️ This file had slots 1 and 2 the other way round for a long time, and the
  // divide by 100 -- which is real, `vdivss` against a literal -- was tried on
  // the late level, where it silences the tail.
  for (let setting = 0; setting <= 5; setting += 1) {
    const preset = reverbPreset(setting);
    const reverb = new Reverb(RATE, preset);
    assert.equal(reverb.lateLevel, millibelToLinear(preset[PRESET_SLOT.lateLevel]));
    assert.equal(reverb.earlyLevel, millibelToLinear(preset[PRESET_SLOT.earlyLevel]) / 100);
  }
});

test('every ReverbSetting the corpus uses selects a real preset', () => {
  // The corpus only ever writes 1..5.
  for (let setting = 0; setting <= 7; setting += 1) {
    const p = reverbPreset(setting);
    assert.equal(p.length, 11);
    assert.ok(REVERB_TAP_SETS[p[PRESET_SLOT.tapSet]], `setting ${setting} tap set`);
    assert.ok(REVERB_EARLY_SETS[p[PRESET_SLOT.earlySet]], `setting ${setting} early set`);
  }
});

test('the two channels differ, and they differ because of the comb pairs', () => {
  // The right accumulator is a copy of the left taken after the mono combs and
  // before the pairs (0x1a41). Left then gets taps[0] and 0.93*taps[0], right
  // taps[1] and 1.06*taps[1]. That copy is the entire stereo width of the late
  // field, so if L and R came back identical the pairs would not be running.
  for (let setting = 1; setting <= 5; setting += 1) {
    const ir = impulseResponse(reverbPreset(setting), RATE);
    let diff = 0;
    let total = 0;
    for (let i = 0; i < RATE; i += 1) {
      diff += (ir[i * 2] - ir[i * 2 + 1]) ** 2;
      total += ir[i * 2] ** 2 + ir[i * 2 + 1] ** 2;
    }
    assert.ok(total > 0, `setting ${setting} is silent`);
    assert.ok(diff / total > 1e-4, `setting ${setting} came back effectively mono`);
  }
});

test('the reverb is stable and decays, at every setting', () => {
  // ⚠️ This caught a real blow-up once: reading the early rows' middle three
  // floats as decibels gave a gain of 100,000 and an impulse peak of 15,864.
  //
  // The tail is measured **relative to the reverb's own peak**, never against an
  // absolute threshold: an absolute one only tests how loud the wet bus happens
  // to be, and every change to the levels moves that.
  for (let setting = 1; setting <= 5; setting += 1) {
    const preset = [...reverbPreset(setting)];
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const window = 2400;
    const frames = Math.round(RATE * (rt60 * 3 + 1));
    // ⚠️ The early reflections are muted here, and that is not a convenience.
    // They are three fixed taps with no decay at all, and on some presets they
    // are the louder half: preset 11 (`ReverbSetting` 4) has an early gain of
    // 100 against a late level of -28 dB, so its early taps set the peak and a
    // T60 measured from that peak reports 0.32 of nominal while the tail itself
    // is fine. What this test is checking is the comb law, so the comb bank is
    // what it has to look at.
    preset[PRESET_SLOT.earlyLevel] = -800;
    const ir = impulseResponse(preset, frames);

    const envelope: number[] = [];
    let block = 0;
    for (let i = 0; i < frames; i += 1) {
      assert.ok(
        Number.isFinite(ir[i * 2]) && Number.isFinite(ir[i * 2 + 1]),
        `setting ${setting} went non-finite at ${i}`,
      );
      block = Math.max(block, Math.abs(ir[i * 2]), Math.abs(ir[i * 2 + 1]));
      if (i % window === window - 1) {
        envelope.push(block);
        block = 0;
      }
    }

    const peak = Math.max(...envelope);
    assert.ok(peak > 0, `setting ${setting} is silent`);

    let last = 0;
    for (let k = 0; k < envelope.length; k += 1) {
      if (envelope[k] > peak / 1000) last = k + 1;
    }
    const t60 = (last * window) / RATE;
    assert.ok(
      t60 < frames / RATE,
      `setting ${setting} still rings at ${(frames / RATE).toFixed(1)}s, past three ` +
        `times its ${rt60.toFixed(1)}s RT60 -- the feedback is at or above unity`,
    );

    // The combs' gains are `10^(-0.003*ms/rt60)`, so a comb of length `ms`
    // decays 60 dB in exactly `rt60`. Measuring that back is what says the gain
    // law and the recursion are both right.
    const ratio = t60 / rt60;
    assert.ok(
      ratio > 0.6 && ratio < 1.6,
      `setting ${setting} decayed in ${t60.toFixed(2)}s against a nominal ` +
        `${rt60.toFixed(1)}s RT60 (ratio ${ratio.toFixed(2)})`,
    );
  }
});

test('a longer decay parameter gives a longer tail', () => {
  const tail = (decay: number) => {
    const preset = [...reverbPreset(5)];
    preset[PRESET_SLOT.decay] = decay;
    const ir = impulseResponse(preset, RATE * 6);
    let peak = 0;
    for (let i = 0; i < ir.length; i += 1) peak = Math.max(peak, Math.abs(ir[i]));
    let last = 0;
    for (let i = 0; i < RATE * 6; i += 1) {
      if (Math.abs(ir[i * 2]) > peak / 1000 || Math.abs(ir[i * 2 + 1]) > peak / 1000) last = i;
    }
    return last / RATE;
  };
  const short = tail(6);
  const long = tail(50);
  assert.ok(long > short * 2, `decay 6 gave ${short.toFixed(2)}s, decay 50 gave ${long.toFixed(2)}s`);
});

test('the output delay is slot 6 in milliseconds, and it delays the late field', () => {
  // The comb sum goes through a delay line of `slot6` ms before `lateLevel` is
  // applied (0x1d2a-0x1d90). With the early reflections muted, nothing may come
  // out before the shortest comb has run once *plus* that delay.
  const preset = [...reverbPreset(3)];
  preset[PRESET_SLOT.earlyLevel] = -800; // a hard zero, so only the late path is left
  const taps = REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]];
  const shortest = Math.min(...taps.slice(0, REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]].length));
  for (const ms of [0, 40]) {
    const withDelay = [...preset];
    withDelay[PRESET_SLOT.outputDelayMs] = ms;
    const ir = impulseResponse(withDelay, RATE);
    let first = -1;
    for (let i = 0; i < RATE && first < 0; i += 1) {
      if (Math.abs(ir[i * 2]) > 1e-9 || Math.abs(ir[i * 2 + 1]) > 1e-9) first = i;
    }
    const expected = Math.round(((shortest + ms) / 1000) * RATE);
    assert.ok(first > 0, `delay ${ms} ms produced nothing`);
    assert.ok(
      Math.abs(first - expected) <= 4,
      `delay ${ms} ms: first output at ${first}, expected about ${expected}`,
    );
  }
});

test('the echo delay is EchoTime in beats, because the ring counts floats', async () => {
  const { Echo, clipToUnit } = await import('../src/audio/effects.ts');
  // fmodextinput.prx 0x0f6a-0x0fdb builds the length and advances the cursor:
  //
  //   steps  = floor(EchoTime * 8 + 0.5)
  //   len    = clamp((steps * (int)(720000/tempo)) & ~0xf, 16, 192000)
  //   cursor = (cursor + 2*n) % len
  //
  // The cursor is a FLOAT index into an interleaved-stereo ring, and 0x0680
  // reads and writes at the same cursor, so the delay is `len / 2` frames.
  //
  // ⚠️ The upper clamp is 192000, which is the ring's float count exactly
  // (768,000 bytes). If `len` were a frame count the bound would be 96000. That
  // number is the whole proof of the halving, and three earlier readings of this
  // field -- seconds, beats, then eight steps per unit -- all missed it.
  const fps = 4000; // 180 BPM at 48 kHz
  const beat = 48000 * (60 / 180);
  for (const field of [1, 1.5, 2, 4]) {
    const echo = new Echo(48000, field, fps, 0.5, 0.5);
    const steps = Math.trunc(field * 8 + 0.5);
    assert.equal(echo.frames, ((steps * fps) & ~0xf) >> 1, `EchoTime ${field}`);
    assert.ok(
      Math.abs(echo.frames - field * beat) < 1,
      `EchoTime ${field} should be ${field} beats, got ${(echo.frames / beat).toFixed(3)}`,
    );
  }
  // The cap is the ring itself: 192,000 floats = 96,000 frames = 2.0 s.
  const capped = new Echo(48000, 4, 720000 / 60, 0.5, 0.5);
  assert.equal(capped.frames, 96000);
  assert.equal(capped.seconds, 2);
  // vmaxss against 0 then vminss against 0.95, at 0x0793-0x079b.
  assert.equal(new Echo(48000, 1, fps, 5, 0.5).feedback, 0.95);
  assert.equal(new Echo(48000, 1, fps, -1, 0.5).feedback, 0);
  // The output stage's hard clip, 0x0889-0x0891.
  assert.equal(clipToUnit(2), 1);
  assert.equal(clipToUnit(-2), -1);
  assert.equal(clipToUnit(0.5), 0.5);
});

test('the six the sequencer offers: the names, the order and the presets', () => {
  assert.deepEqual([...REVERB_NAMES], 
    ['Small Room', 'Room', 'Bright Plate', 'Hall', 'Big Hall', 'Cathedral'],
    'the order AddReverbs__ appends them in');
  assert.deepEqual(REVERB_SETTINGS.map((s) => reverbSummary(s).preset), [3, 6, 8, 5, 11, 2],
    'through the remap, which is where the names attach');
  // The two checks that do not come from the names.
  const byName = (n: string) => reverbSummary(REVERB_NAMES.indexOf(n));
  assert.equal(byName('Bright Plate').dampingHz, null,
    'the plate is the one preset with damping off, which is what makes it bright');
  const decays = REVERB_SETTINGS.map((s) => reverbSummary(s).decaySeconds);
  assert.equal(Math.min(...decays), byName('Small Room').decaySeconds, 'the small room is the shortest');
  assert.equal(Math.max(...decays), byName('Big Hall').decaySeconds,
    'and the longest is the big hall, NOT the cathedral -- see answered question 41');
  assert.ok(byName('Cathedral').preDelayMs > byName('Big Hall').preDelayMs,
    'the cathedral is the largest space by pre-delay, which is why it is not the longest tail');
});

test('the shorter early taps arrive late by what the 256-frame ring adds', () => {
  // The early line is a ring of `M` frames (the longest tap) in a buffer
  // rounded up to 1 KB, 256 frames, written block by block: the longest tap is
  // read `M` behind, the other two `d + (ring - M)` -- measured against
  // `fmodsmsreverb.prx` running under `tools/prxrun.py`.
  for (let setting = 1; setting <= 5; setting += 1) {
    const preset = [...reverbPreset(setting)];
    preset[PRESET_SLOT.lateLevel] = -10000;
    const early = REVERB_EARLY_SETS[preset[PRESET_SLOT.earlySet]];
    const nominal = [0.051, 0.151, 0.078].map((o, i) => Math.trunc((early[i] + o) * (RATE / 1000)));
    const longest = Math.max(...nominal);
    const ring = Math.ceil(longest / 256) * 256;
    const expected = nominal.map((d) => (d === longest ? d : d + ring - longest)).sort((a, b) => a - b);
    const ir = impulseResponse(preset, ring + 512);
    const arrivals: number[] = [];
    for (let i = 0; i < ring + 512; i += 1) {
      if (ir[i * 2] !== 0 || ir[i * 2 + 1] !== 0) arrivals.push(i);
    }
    assert.deepEqual(arrivals, [...new Set(expected)], `setting ${setting}`);
  }
});

test('a preset applied to a reverb that has run keeps its lengths, as the module does', () => {
  // `tools/prxrevswitch.py` runs `fmodsmsreverb.prx` made by the eboot's own
  // create, setting A applied before the first block, then setting B applied
  // after 2048 frames the way `applyReverbPreset` applies it, and prints the
  // stereo RMS of each 1024-frame window of what it writes back. Each scene
  // pins a part of `reconfigure`, and fails by two to three orders of
  // magnitude past the tolerance without it: 5 -> 3 the lengths kept
  // (Cathedral's under Hall's gains); 2 -> 1 the comb Bright Plate's nine taps
  // never built; 0 -> 0, a burst running through the switch, the input
  // one-pole's and the notch's state zeroed by the switch.
  const MODULE: Record<string, number[]> = {
    '5-3': [
      0, 0, 0.0075498, 0.022996, 0.028886, 0.015444, 0.035652, 0.041579, 0.022088, 0.020383,
      0.024554, 0.017439, 0.012975, 0.010683, 0.0092722, 0.0065133, 0.0057482, 0.0046648,
      0.0046215, 0.003996, 0.0030221, 0.0025279, 0.0025431, 0.0019004, 0.0014412, 0.0013391,
      0.0011405, 0.0010126, 0.00078913, 0.00083522, 0.00068849, 0.00063096, 0.00044375,
      0.00045626, 0.00052565, 0.00037612,
    ],
    '2-1': [
      0, 0.019792, 0.1133, 0.13637, 0.084784, 0.064592, 0.060313, 0.050016, 0.035018, 0.028397,
      0.022434, 0.016892, 0.015483, 0.011161, 0.010791, 0.0080974, 0.0070739, 0.0063018,
      0.0042706, 0.004767, 0.0033186, 0.0029889, 0.0026236, 0.0021498, 0.0018713, 0.0014395,
      0.0014394, 0.0011327, 0.00088752, 0.00084767, 0.00066109, 0.00055831, 0.00054522,
      0.00040906, 0.00035766, 0.00030165,
    ],
    '0-0': [
      0.004444, 0.02586, 0.051964, 0.028406, 0.014998, 0.033926, 0.027424, 0.011238, 0.0067873,
      0.0044298, 0.0037056, 0.0027536, 0.0021349, 0.0017037, 0.0012321, 0.0009402, 0.00064557,
      0.00061732, 0.0004141, 0.00035427, 0.00024819, 0.00020896, 0.00012965, 9.2257e-5, 9.656e-5,
      7.6307e-5, 5.6451e-5, 4.256e-5, 2.8308e-5, 2.2701e-5, 1.6664e-5, 1.4327e-5, 1.041e-5,
      1.1317e-5, 7.0636e-6, 5.4165e-6,
    ],
  };
  const SWITCH = 2048;
  const WINDOW = 1024;
  const frames = WINDOW * 36;
  // The tool's signal: impulses, and LCG noise in float32, left then right. The
  // first block is silent, as the game leaves it for every song it starts.
  const input = new Float32Array(frames * 2);
  let seed = 12345;
  const impulse = (at: number) => {
    input[2 * at] = 0.5;
    input[2 * at + 1] = 0.25;
  };
  const burst = (at: number, n: number) => {
    for (let i = 2 * at; i < 2 * (at + n); i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      input[i] = (seed / 4294967296 - 0.5) * 0.6;
    }
  };
  impulse(256);
  burst(1000, 300);
  burst(SWITCH - 400, 800);
  impulse(SWITCH + 512);
  burst(SWITCH + 3000, 500);

  for (const [scene, module] of Object.entries(MODULE)) {
    const [a, b] = scene.split('-').map(Number);
    const reverb = new Reverb(RATE, reverbPreset(a));
    const energy = new Array<number>(module.length).fill(0);
    for (let i = 0; i < frames; i += 1) {
      if (i === SWITCH) reverb.reconfigure(reverbPreset(b));
      const out = reverb.process(input[2 * i], input[2 * i + 1]);
      energy[Math.floor(i / WINDOW)] += out.left ** 2 + out.right ** 2;
    }
    const loudest = Math.max(...module);
    energy.forEach((e, w) => {
      const rms = Math.sqrt(e / WINDOW);
      assert.ok(
        Math.abs(rms - module[w]) <= 1e-4 * (loudest + module[w]),
        `${scene}, window ${w}: ${rms} against the module's ${module[w]}`,
      );
    });
  }
});

test('reconfiguring before the first frame is a clean configure, as the module first builds there', () => {
  const ir = (reverb: Reverb) => {
    const out: number[] = [];
    for (let i = 0; i < 48000; i += 1) out.push(reverb.process(i === 300 ? 1 : 0, i === 300 ? 1 : 0).left);
    return out;
  };
  const switched = new Reverb(RATE, reverbPreset(5));
  switched.reconfigure(reverbPreset(3));
  assert.deepEqual(ir(switched), ir(new Reverb(RATE, reverbPreset(3))));
});
