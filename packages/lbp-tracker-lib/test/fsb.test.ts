import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findSample, readBank, sampleData } from '../src/fsb.ts';
import { decodeIma, toFloatChannels } from '../src/ima.ts';
import { readWav, writeWav } from '../src/wav.ts';

/**
 * The bank is the user's own copy of a copyrighted game asset and is never
 * committed -- see steering/game-assets.md. Point LBP_FSB at it to run these;
 * without it they skip.
 */
const BANK =
  process.env.LBP_FSB ??
  'D:\\PS4Games\\CUSA00063\\gamedata\\audio\\sfxbank_compressed.fsb';

const PYTHON =
  process.env.LBP_PYTHON ??
  'C:\\Users\\sgdc3\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';

async function loadBank() {
  return readBank(new Uint8Array(await readFile(BANK)));
}

test('reports a helpful error on something that is not a bank', async () => {
  const { readBank: read, FsbFormatError } = await import('../src/fsb.ts');
  const notABank = new Uint8Array(0x40);
  notABank.set([0x4c, 0x56, 0x4c, 0x62]); // "LVLb"
  assert.throws(() => read(notABank), FsbFormatError);
});

test('bank header and sample table match what steering records', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();

  assert.equal(bank.sampleCount, 1048, 'sfxbank_compressed.fsb holds 1048 samples');
  assert.equal(bank.version, 0x00040000, 'every LBP3 bank is version 0x40000');
  assert.equal(bank.mode, 0x20, 'every LBP3 bank has file mode 0x20');
  assert.equal(bank.samples.length, bank.sampleCount, 'walked every header');

  // Data offsets are cumulative; the last one plus its length must land on or
  // before the end of the file, which is an independent check that every
  // header's size field was read correctly.
  const last = bank.samples[bank.samples.length - 1];
  assert.ok(
    last.dataOffset + last.lengthBytes <= bank.bytes.length,
    'sample data fits inside the bank',
  );

  const codecs = new Set(bank.samples.map((s) => s.codec));
  assert.ok(codecs.has('ima_adpcm'), 'the instrument material is IMA ADPCM');
  assert.ok(!codecs.has('unknown'), 'no sample uses a codec we do not recognise');
});

test('the IMA block geometry holds for every ADPCM sample in the bank', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  // 36 bytes per channel per 64 samples, with the tail padded to a 32-byte
  // boundary. This is the measurement game-assets.md rests on; assert it across
  // the whole bank rather than the three samples that were checked by hand.
  let checked = 0;
  for (const s of bank.samples) {
    if (s.codec !== 'ima_adpcm') continue;
    const blocks = Math.ceil(s.lengthSamples / 64);
    const expected = blocks * 36 * s.channels;
    const padded = Math.ceil(expected / 32) * 32;
    assert.ok(
      s.lengthBytes === padded || s.lengthBytes === expected,
      `${s.name}: ${s.lengthBytes} bytes, expected ${expected} (padded ${padded})`,
    );
    checked += 1;
  }
  // Every sample in this particular bank is ADPCM. (The 3601 figure in
  // game-assets.md is across all 236 banks, not this one.)
  assert.equal(checked, bank.sampleCount, 'every sample in this bank is ADPCM');
  assert.equal(checked, 1048);
});

test('findSample prefers a prefix over a substring: piano_C4 is not epiano_C4', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  // The real bug this guards: "epiano_C4.wav" contains "piano_C4", and comes
  // first in bank order, so a substring search loads the wrong instrument.
  for (const octave of [2, 3, 4, 5, 6]) {
    const found = findSample(bank, `piano_C${octave}`);
    assert.ok(found, `piano_C${octave} exists`);
    assert.equal(
      found.name,
      `piano_C${octave}.wav`,
      `piano_C${octave} must not resolve to ${found.name}`,
    );
  }
  // And the electric piano is still reachable under its own name.
  const epiano = findSample(bank, 'epiano_C4');
  assert.equal(epiano?.name, 'epiano_C4.wav');
});

test('the five piano samples form a coherent multisample', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  const found = [2, 3, 4, 5, 6].map((o) => findSample(bank, `piano_C${o}`)!);
  for (const s of found) {
    assert.equal(s.channels, 1, `${s.name} is mono`);
    assert.equal(s.codec, 'ima_adpcm', `${s.name} is ADPCM`);
  }
  console.log(
    `    ${found.map((s) => `${s.name} ${s.freq}Hz ${s.lengthSamples}f`).join(', ')}`,
  );
});

test('piano_C3 decodes to the frames, rate and level steering records', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  const bank = await loadBank();
  const sample = findSample(bank, 'piano_C3');
  assert.ok(sample, 'piano_C3 is in the bank');
  assert.equal(sample.codec, 'ima_adpcm');
  assert.equal(sample.freq, 22050);
  assert.equal(sample.channels, 1);

  const pcm = decodeIma(sampleData(bank, sample), sample.channels, sample.lengthSamples);
  assert.equal(pcm.length, 66112, 'frame count matches the Python reference');

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSquares += v * v;
    if (v >= 32767 || v <= -32768) clipped += 1;
  }
  const rms = Math.sqrt(sumSquares / pcm.length);
  assert.equal(clipped, 0, 'a wrong decoder clips; a right one does not');
  assert.equal(peak, 28588, 'peak matches the Python reference');
  assert.ok(Math.abs(rms - 2770) < 1, `rms ${rms.toFixed(1)}, expected ~2770`);

  const [channel] = toFloatChannels(pcm, 1);
  assert.equal(channel.length, 66112);
  assert.ok(Math.max(...channel.subarray(0, 1000)) <= 1);
});

test('GOLDEN: the TypeScript decoder is byte-identical to tools/fsb.py', async (t) => {
  if (!existsSync(BANK)) {
    t.skip(`no bank at ${BANK} (set LBP_FSB)`);
    return;
  }
  if (!existsSync(PYTHON)) {
    t.skip(`no python at ${PYTHON} (set LBP_PYTHON)`);
    return;
  }

  const bank = await loadBank();
  const dir = mkdtempSync(path.join(tmpdir(), 'lbpt-golden-'));
  try {
    for (const name of ['piano_C3', 'triangle_synth_C4', 'eDrums_kick_01']) {
      const sample = findSample(bank, name);
      if (!sample || sample.codec !== 'ima_adpcm') continue;

      const out = path.join(dir, `${name}.wav`);
      execFileSync(PYTHON, ['tools/fsb.py', 'wav', BANK, sample.name, out], {
        stdio: 'pipe',
      });
      const expected = new Uint8Array(readFileSync(out));

      const pcm = decodeIma(
        sampleData(bank, sample),
        sample.channels,
        sample.lengthSamples,
      );
      const actual = writeWav(pcm, sample.channels, sample.freq);

      assert.equal(actual.length, expected.length, `${name}: wav length`);
      let firstDiff = -1;
      for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) {
          firstDiff = i;
          break;
        }
      }
      assert.equal(
        firstDiff,
        -1,
        `${name}: first differing byte at ${firstDiff}` +
          (firstDiff >= 0
            ? ` (ts ${actual[firstDiff]}, py ${expected[firstDiff]})`
            : ''),
      );
      console.log(`    ${sample.name}: ${expected.length} bytes identical`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWav parses the smpl chunk that carries the sustain loop', () => {
  // A minimal RIFF with fmt, data and smpl: one forward loop over frames 2..5.
  const frames = 8;
  const buf = new ArrayBuffer(12 + 8 + 16 + 8 + frames * 2 + 8 + 36 + 24);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) u8[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 48000, true); dv.setUint32(28, 96000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, frames * 2, true);
  const smpl = 44 + frames * 2;
  ascii(smpl, 'smpl'); dv.setUint32(smpl + 4, 36 + 24, true);
  dv.setUint32(smpl + 8 + 12, 60, true);   // MIDI unity note
  dv.setUint32(smpl + 8 + 28, 1, true);    // one loop
  dv.setUint32(smpl + 8 + 36 + 4, 0, true);   // type: forward
  dv.setUint32(smpl + 8 + 36 + 8, 2, true);   // start
  dv.setUint32(smpl + 8 + 36 + 12, 5, true);  // end, inclusive

  const wav = readWav(u8);
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.unityNote, 60);
  assert.deepEqual(wav.loop, { type: 0, start: 2, end: 5 });
});

test('a loop that runs past the data is discarded rather than trusted', () => {
  const frames = 4;
  const buf = new ArrayBuffer(12 + 8 + 16 + 8 + frames * 2 + 8 + 36 + 24);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) u8[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 48000, true); dv.setUint32(28, 96000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, frames * 2, true);
  const smpl = 44 + frames * 2;
  ascii(smpl, 'smpl'); dv.setUint32(smpl + 4, 36 + 24, true);
  dv.setUint32(smpl + 8 + 28, 1, true);
  dv.setUint32(smpl + 8 + 36 + 8, 2, true);
  dv.setUint32(smpl + 8 + 36 + 12, 99, true);  // past the end
  assert.equal(readWav(u8).loop, undefined);
});

test('every pitched sequencer sample carries a sustain loop', async (t) => {
  const dir = process.env.LBP_SMP ?? 'fixtures/smp';
  if (!existsSync(dir)) {
    t.skip(`no ${dir} (extract with tools/ExtractGuid.java)`);
    return;
  }
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.smp'));
  if (files.length === 0) {
    t.skip(`no .smp files in ${dir}`);
    return;
  }
  let looped = 0;
  for (const name of files) {
    const wav = readWav(new Uint8Array(readFileSync(path.join(dir, name))));
    if (wav.loop) looped += 1;
  }
  // Not every sample loops -- a drum hit should not -- but the pitched
  // multisamples do, and that is what makes note length independent of pitch.
  console.log(`    ${looped}/${files.length} samples carry a loop`);
  assert.ok(looped > files.length * 0.3, 'a substantial share of samples loop');

  for (const name of ['piano_c2.smp', 'piano_c3.smp', 'piano_c4.smp', 'piano_c5.smp', 'piano_c6.smp']) {
    if (!existsSync(path.join(dir, name))) continue;
    const wav = readWav(new Uint8Array(readFileSync(path.join(dir, name))));
    assert.ok(wav.loop, `${name} must loop, or its notes ring for the wrong time`);
    assert.ok(wav.loop.start < wav.loop.end, `${name} loop is ordered`);
    assert.ok(wav.loop.end < wav.channels[0].length, `${name} loop is inside the data`);
  }
});

test('loopRegion is the loader\'s: start as written, the inclusive end made exclusive', async () => {
  const { loopRegion } = await import('../src/wav.ts');
  // v0xb3e74c-v0xb3e76d: +0x7c = dwStart, +0x80 = min(dwEnd + 1, frames) - start.
  assert.deepEqual(loopRegion({ start: 100, end: 200, type: 0 }, 500), { start: 100, end: 201 });
  // Clamped rather than out of range at either edge.
  assert.deepEqual(loopRegion({ start: 0, end: 99, type: 0 }, 100), { start: 0, end: 100 });
  assert.deepEqual(loopRegion({ start: 120, end: 200, type: 0 }, 100), { start: 99, end: 100 });
});

test('patchLoop puts the loop\'s first 16 frames after its end, so the wrap reads them', async () => {
  const { patchLoop, LOOP_PATCH_FRAMES } = await import('../src/wav.ts');
  const { buildMipChain, readMipped } = await import('../src/audio/mipmap.ts');
  // A ramp whose loop is [10, 30): frame 30 in the file is 30, and after the
  // patch it is frame 10's value.
  const data = Float32Array.from({ length: 40 }, (_, i) => i / 100);
  const loop = { start: 10, end: 30 };
  const patched = patchLoop(data, loop);
  // The loader's buffer always has 16 frames past the loop's end; here the
  // file is 40 frames and the patch reaches 46, so the copy grows it.
  assert.equal(patched.length, 46, 'grown to hold the patch');
  for (let i = 0; i < LOOP_PATCH_FRAMES; i += 1) {
    assert.equal(patched[30 + i], data[10 + i], `frame ${30 + i} holds frame ${10 + i}`);
  }
  assert.equal(patched[9], data[9], 'nothing before the end is touched');
  // A loop ending on the file's last frame grows the buffer by the patch.
  const tail = patchLoop(data, { start: 10, end: 40 });
  assert.equal(tail.length, 40 + LOOP_PATCH_FRAMES);
  assert.equal(tail[40], data[10]);

  // Through the engine's sampler: position 29.5 interpolates towards frame 30,
  // which is now the loop's first frame -- the same value position 9.5 + 20
  // cycles would give on an endless ramp of the loop, i.e. seamless.
  const chain = buildMipChain(patched);
  const atWrap = readMipped(chain, 29.5, 0, loop);
  assert.ok(Math.abs(atWrap - (data[29] + data[10]) / 2) < 1e-9, `wrap reads ${atWrap}`);
  // And one frame on, index 31 wraps to 11: the period is exactly 20 frames.
  assert.ok(Math.abs(readMipped(chain, 31, 0, loop) - data[11]) < 1e-9);
});

// Ours, read with `declick`: the harp's loops made to repeat one shape and to be
// entered gradually (`LOOP_SMOOTHING`), the attack left as recorded.
test('smoothLoop repeats one period and fades the recording into it', async () => {
  const { smoothLoop, engineSample, LOOP_SMOOTHING } = await import('../src/wav.ts');
  // A sine of period 10 whose loop [100, 140) holds four periods, each a little
  // louder than the last, after a 40-frame stretch of other material.
  const frames = 140;
  const data = Float32Array.from({ length: frames }, (_, i) =>
    i < 60 ? 0.3 : Math.sin((2 * Math.PI * i) / 10) * (i < 100 ? 0.5 : 0.4 + 0.02 * Math.floor((i - 100) / 10)));
  const loop = { start: 100, end: 140 };
  const out = smoothLoop(data, loop, 4);
  // Inside the loop every period is the average of the four.
  for (let j = 0; j < 10; j += 1) {
    const mean = Math.sin((2 * Math.PI * j) / 10) * 0.43;
    for (let m = 0; m < 4; m += 1) {
      assert.ok(Math.abs(out[100 + 10 * m + j] - mean) < 1e-6, `period ${m}, frame ${j}`);
    }
  }
  // Before it, two loop lengths crossfade from the recording into the loop:
  // the first frame still the recording, the last almost all loop.
  assert.equal(out[19], data[19], 'nothing before the crossfade moves');
  assert.ok(Math.abs(out[20] - data[20]) < 1e-6, 'the crossfade starts on the recording');
  assert.ok(Math.abs(out[99] - Math.sin((2 * Math.PI * 99) / 10) * 0.43) < 0.01, 'and ends on the loop');
  // `engineSample` builds it only for a listed sample, patched as the loader patches.
  const wav = { channels: [data], sampleRate: 48000, bitsPerSample: 16, loop: { start: 100, end: 139, type: 0 } };
  assert.equal(engineSample(wav).smoothed, undefined);
  assert.equal(engineSample(wav, 1).smoothed, undefined);
  const [guid] = LOOP_SMOOTHING.keys();
  const listed = engineSample(wav, guid);
  assert.ok(listed.smoothed !== undefined);
  assert.deepEqual(listed.channels[0], engineSample(wav).channels[0], 'the engine\'s own sample is untouched');
  assert.equal(listed.smoothed[0][140], listed.smoothed[0][100], 'the smoothed loop is patched too');
});

// ❌ Until 2026-09-08 this test asserted that shifting the loop down by one
// frame joined more smoothly than the literal reading -- which it does, and
// which is not what the game plays: the loader takes `smpl` as written and
// patches the loop's first frames past its end, so the engine's join IS the
// literal one. The measurement is kept for the record, and the assertion is
// now that the patched join is exactly the literal one.
test('the engine\'s join is the literal one, and the patch makes it so', async (t) => {
  const dir = process.env.LBP_SMP ?? 'fixtures/smp';
  if (!existsSync(dir)) {
    t.skip(`no ${dir} (extract with tools/ExtractGuid.java)`);
    return;
  }
  const { loopRegion, patchLoop } = await import('../src/wav.ts');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.smp'));
  if (files.length === 0) {
    t.skip(`no .smp files in ${dir}`);
    return;
  }

  // The join has to be phase-continuous. Measure the jump across it in units of
  // the sample's own average adjacent step, so the number is scale-free.
  let fixed = 0;
  let literal = 0;
  let n = 0;
  for (const name of files) {
    const wav = readWav(new Uint8Array(readFileSync(path.join(dir, name))));
    if (!wav.loop) continue;
    const d = wav.channels[0];
    const { start, end } = wav.loop;
    if (end - start < 64 || start < 1 || end + 1 >= d.length) continue;

    let step = 0;
    const k = Math.min(2000, end - start - 1);
    for (let i = start + 1; i < start + 1 + k; i += 1) step += Math.abs(d[i] - d[i - 1]);
    step = step / k || 1e-9;

    const region = loopRegion(wav.loop, d.length);
    const patched = patchLoop(d, region);
    // The frame the sampler's unwrapped second tap reads at the loop's last
    // frame is the loop's first, on every corpus loop.
    assert.equal(patched[region.end], d[region.start], `${name}: the patch lands`);
    fixed += Math.abs(d[region.start - 1] - d[region.end - 1]) / step;
    literal += Math.abs(patched[region.end] - patched[region.end - 1]) / step;
    n += 1;
  }
  assert.ok(n > 20, `expected a corpus of loops, saw ${n}`);
  console.log(
    `    ${n} loops — the engine's join ${(literal / n).toFixed(2)}x an adjacent step; ` +
      `the old one-frame shift would have been ${(fixed / n).toFixed(2)}x`,
  );
});
