import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync as exists } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { type SampleBuffer } from '../src/audio/mixer.ts';
import { RATE, renderSequencer, toPcm16, type LoadedInstrument } from '../src/render.ts';
import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/chips.ts';
import { readLevelProject, type Sequencer } from '@lbptracker/cwlib/project.ts';
import { readInstrument, usedSlots } from '../src/rinstrument.ts';
import { loadResourceFile, nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { engineSample, readWav } from '../src/wav.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const RINST = 'fixtures/rinst';
const SMP = 'fixtures/smp';

/**
 * Load the reference sequencer and a Node instrument loader.
 *
 * ⚠️ This is the *same* loader shape `packages/lbp-tracker-web/src/render-worker.ts` builds from `fetch`,
 * and that is the whole point of `packages/lbp-tracker-lib/src/render.ts`: a browser render differs
 * from a Node one only in how bytes arrive. On 2026-09-02 both were run on
 * `This Is Halloween` end to end and produced the **same 70,704,044-byte file
 * with the same SHA-256** (`1785d0d8…`). ⚠️ That file predates the voice-pool
 * fix later the same day; the equality it demonstrates does not. A test cannot
 * drive a browser, so what
 * is pinned below is the property that made that comparison meaningful: the
 * pipeline is deterministic, and its output depends on the seed and on nothing
 * else.
 */
async function fixture(): Promise<{
  seq: Sequencer;
  load: (guid: number) => Promise<LoadedInstrument | null>;
} | null> {
  if (!exists(LEVELS) || !exists(RINST) || !exists(SMP)) return null;
  const manifest = async (dir: string) =>
    new Map<number, { file: string }>(
      (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
        guid: number;
        file: string;
      }[]).map((r) => [r.guid, r]),
    );
  const rinstIndex = await manifest(RINST);
  const smpIndex = await manifest(SMP);

  const all: Sequencer[] = [];
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      const project = await readLevelProject(
        entry.name,
        new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
        nodeInflate,
      );
      all.push(...project.sequencers);
    } catch {
      // A file that is not a level, or one this walk cannot read yet.
      // `packages/cwlib-ts/dev/verify-levels.ts` is where that is a failure; here it is noise.
    }
  }
  const seq = all
    .filter((s) => s.tracks.length >= 3 && s.lengthSteps > 32)
    .sort((a, b) => b.tracks.length - a.tracks.length)[0];
  if (!seq) return null;

  const cache = new Map<number, LoadedInstrument | null>();
  const load = async (guid: number) => {
    const hit = cache.get(guid);
    if (hit !== undefined) return hit;
    const row = rinstIndex.get(guid);
    if (!row) {
      cache.set(guid, null);
      return null;
    }
    const inst = readInstrument((await loadResourceFile(path.join(RINST, row.file))).data);
    const slots = [];
    for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
      const s = smpIndex.get(sampleGuid);
      if (!s) continue;
      const wav = readWav(await readFile(path.join(SMP, s.file)));
      // The loader's loop region and its 16-frame patch: see `engineSample`.
      const engine = engineSample(wav);
      slots.push({
        base: slot.baseNote,
        wav: {
          channels: engine.channels,
          sampleRate: wav.sampleRate,
          loop: engine.loop,
          mips: engine.channels.map((c) => buildMipChain(c)),
        } satisfies SampleBuffer,
      });
    }
    const loaded = { inst, slots };
    cache.set(guid, loaded);
    return loaded;
  };
  return { seq, load };
}

const sha = (pcm: Int16Array) =>
  createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');

test('the pipeline is deterministic, which is what makes a cross-platform hash mean anything', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS} / ${RINST} / ${SMP} — see the header of packages/lbp-tracker-lib/dev/render-level.ts`);
    return;
  }
  const options = { secondsArg: 4 };
  const a = await renderSequencer(f.seq, f.load, options);
  const b = await renderSequencer(f.seq, f.load, options);
  assert.equal(a.frames, RATE * 4);
  assert.equal(sha(toPcm16(a.left, a.right).pcm), sha(toPcm16(b.left, b.right).pcm));
  // ⚠️ Not a tautology: `VoiceSpec.random` once came from `Math.random`, so two
  // runs of the same build produced different files and a hash could not be used
  // to check that an optimisation had changed nothing.
  assert.ok(a.played > 0, 'the window has notes in it');
  assert.ok(Number.isFinite(a.peak) && a.peak > 0);
});

test('the seed is actually used', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  // ⚠️ 20 seconds, not 2. The PRNG only reaches the output through an LFO phase
  // or a stack layer after the first, and the reference sequencer's opening two
  // seconds have neither -- 61 notes, all `Numstack` 1, no LFO depth -- so a
  // 2-second window renders identically under any seed and this test passed
  // vacuously in the other direction. At 20 seconds, 821 notes in, it does not.
  const a = await renderSequencer(f.seq, f.load, { secondsArg: 20 });
  const b = await renderSequencer(f.seq, f.load, { secondsArg: 20, seed: 0x1234567 });
  assert.notEqual(sha(toPcm16(a.left, a.right).pcm), sha(toPcm16(b.left, b.right).pcm));
});

test('the effects reach the mix, and turning the clip off changes the output', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  const withClip = await renderSequencer(f.seq, f.load, { secondsArg: 4 });
  assert.ok(withClip.reverbRel > 0, 'the reverb send reaches the reverb');
  const noClip = await renderSequencer(f.seq, f.load, { secondsArg: 4, clip: false });
  // The clip may or may not engage on this window; what must hold is that the
  // switch is wired to the output rather than only to the report.
  if (withClip.clippedFrames > 0) {
    assert.notEqual(
      sha(toPcm16(withClip.left, withClip.right).pcm),
      sha(toPcm16(noClip.left, noClip.right).pcm),
    );
  }
  assert.equal(noClip.clippedFrames, 0, 'a disabled clip counts nothing');
});

// ------------------------------------------------------------- the ramps

/**
 * The engine's slides are per unit of STEPS (`0x3930` sets `(next - current) /
 * span` with the span in thirds; the renderer adds `t * slide` with `t` the
 * chunk's advance in steps), so under swing a glide bends at every step
 * boundary in frame time. `render.ts` cuts every ramp at the integer steps it
 * crosses, which is exact because `swungFrame` is linear inside a step.
 */
test('a glide is linear in steps, so under swing it bends at every step it crosses', async () => {
  const { groupNotes } = await import('@lbptracker/cwlib/notes.ts');
  const { DEFAULT_SLOT } = await import('../src/instrument.ts');
  const { swungFrame } = await import('../src/swing.ts');
  const { samplesPerStep } = await import('../src/voice.ts');
  const rec = (step: number, pitch: number, end: boolean) => ({
    step, pitch, volume: 96, timbre: 0, modulation: 0, subStep: 0 as const, end,
  });
  const { notes } = groupNotes([rec(0, 60, false), rec(3, 72, true)]);
  const seq: Sequencer = {
    uid: 1, name: 'ramp', author: '', tempo: 120, swing: 0.5,
    echoFeedback: 0, echoTime: 1, echoMix: 0, reverb: 5,
    loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [{
      guid: 1, name: 't', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0, level: 1, pan: 0.5,
      echoSend: 0.5, reverbSend: 0, key: 0, scale: 0, notes,
      records: new Uint8Array(0), trailingRecords: 0,
    }],
    lengthSteps: 8,
  };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[13] = { x: 1, y: 1 };
  params[24] = { x: 1, y: 1 };
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
  let automation: readonly { frame: number; pitch: number; gain: number }[] | undefined;
  let steps: readonly number[] = [];
  // The tracker's clock: on the engine's the voice reads its slides off the
  // clock's playhead instead (`engine` in the next tests).
  await renderSequencer(seq, loader, {
    planOnly: true,
    engineClock: false,
    onVoice: (voice, where) => {
      automation = voice.automation;
      steps = where.pointSteps;
    },
  });
  // Two points three steps apart become four: one at every integer step, the
  // semitones shared out evenly in steps.
  assert.deepEqual(steps, [0, 1, 2, 3]);
  assert.deepEqual(automation?.map((p) => p.pitch), [0, 4, 8, 12]);
  // And each sits where the swung clock puts that step, so the frame ramp
  // between two of them is the engine's step ramp inside that step.
  const fps = samplesPerStep(RATE, 120);
  assert.deepEqual(
    automation?.map((p) => p.frame),
    [0, 1, 2, 3].map((s) => Math.round(swungFrame(s, fps, 0.5))),
  );
  const frames = automation!.map((p) => p.frame);
  assert.ok(frames[1] - frames[0] > frames[2] - frames[1], 'the stretched step is longer than the squeezed one');
});

/** A one-slot instrument on a constant sample, for plans that need no audio. */
async function planOf(
  tracks: readonly { gridX?: number; gridY?: number; notes: Parameters<typeof import('@lbptracker/cwlib/notes.ts').groupNotes>[0] }[],
  options: Parameters<typeof renderSequencer>[2] = {},
  slot: {
    pitched?: boolean; numStack?: number; startOffset?: number; frames?: number; loop?: { start: number; end: number };
    /** A sine of this period in frames instead of a constant, for a test that listens. */
    period?: number;
    params?: Readonly<Record<number, { x: number; y: number }>>;
  } = {},
  tempo = 120,
) {
  const { groupNotes, encodeNotes } = await import('@lbptracker/cwlib/notes.ts');
  const { DEFAULT_SLOT } = await import('../src/instrument.ts');
  const seq: Sequencer = {
    uid: 1, name: 'plan', author: '', tempo, swing: 0,
    echoFeedback: 0, echoTime: 1, echoMix: 0, reverb: 5,
    loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: tracks.map((t) => {
      const { notes } = groupNotes(t.notes);
      return {
        guid: 1, name: 't', colour: DEFAULT_CHIP_COLOUR, gridX: t.gridX ?? 0, gridY: t.gridY ?? 0,
        stepOffset: (t.gridX ?? 0) * 16, level: 1, pan: 0.5, echoSend: 0.5, reverbSend: 0, key: 0, scale: 0,
        notes, records: encodeNotes(notes), trailingRecords: 0,
      };
    }),
    lengthSteps: 32,
  };
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[13] = { x: 1, y: 1 };
  params[24] = { x: 1, y: 1 };
  params[2] = { x: slot.startOffset ?? 0, y: slot.startOffset ?? 0 };
  for (const [i, value] of Object.entries(slot.params ?? {})) params[Number(i)] = value;
  const frames = slot.frames ?? 4800;
  const channel = new Float32Array(slot.loop ? Math.max(frames, slot.loop.end + 16) : frames).fill(0.5);
  if (slot.period !== undefined) {
    for (let i = 0; i < channel.length; i += 1) channel[i] = 0.5 * Math.sin((2 * Math.PI * i) / slot.period);
  }
  const loader = async () => ({
    inst: {
      slots: [{ ...DEFAULT_SLOT, pitched: slot.pitched ?? true }], sampleGuids: [1],
      splitNotes: [87, 0, 0, 0, 0, 0, 0, 0, 0], numStack: slot.numStack ?? 1, params, arpeggio: [], arpeggiate: false,
    },
    slots: [{
      wav: { channels: [channel], sampleRate: RATE, loop: slot.loop ? { ...slot.loop, frames } : undefined },
      base: 60,
    }],
  });
  const voices: {
    voice: import('../src/audio/mixer.ts').VoiceSpec;
    track: number;
    startFrame: number;
    walks: import('../src/polyphony.ts').PoolWalks;
    startStep: number;
    endStep?: number;
  }[] = [];
  await renderSequencer(seq, loader, {
    planOnly: true,
    ...options,
    onVoice: (voice, where) =>
      voices.push({
        voice, track: where.track, startFrame: where.startFrame, walks: where.walks,
        startStep: where.startStep, endStep: where.endStep,
      }),
  });
  return voices;
}

const hit = (step: number, pitch = 60, end = true) => ({
  step, pitch, volume: 96, timbre: 0, modulation: 0, subStep: 0 as const, end,
});

test('the walk takes one clip per row and stops once rows 0..7 are taken', async () => {
  // Nine rows, row 8 first in the clip array: the walk scans from the LAST
  // header (`0x0300`), so rows 7..0 fill the mask to 0xff before it reaches
  // row 8, and `0x05dc` ends the scan there.
  const rows = [8, 0, 1, 2, 3, 4, 5, 6, 7];
  const dropped = await planOf(rows.map((r) => ({ gridY: r, notes: [hit(0)] })));
  assert.deepEqual(dropped.map((v) => v.track).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Row 8 last in the array is scanned first, its bit keeps the mask off
  // 0xff, and every row plays.
  const kept = await planOf([...rows.slice(1), 8].map((r) => ({ gridY: r, notes: [hit(0)] })));
  assert.equal(kept.length, 9);
  // Two clips on one row at once: the later header wins the row.
  const shared = await planOf([{ gridY: 2, notes: [hit(0)] }, { gridY: 2, notes: [hit(0, 64)] }]);
  assert.deepEqual(shared.map((v) => v.track), [1]);
});

test('the pool scores a held note at its current point, walk by walk', async () => {
  const at = (step: number, volume: number, end = false) => ({
    step, pitch: 60, volume, timbre: 0, modulation: 0, subStep: 0 as const, end,
  });
  // Two notes claimed together on a pool of two: one held at 100, one opening
  // at 127 and fading to 10 by step 4. A third arrives at step 5 and must take
  // the record that is quiet NOW (`0x3930` rewrites +0x0c at every walk); scored
  // at their claims, the note held at 100 would go, on either clock.
  const tracks = [
    { gridY: 0, notes: [at(0, 100), at(8, 100, true)] },
    { gridY: 1, notes: [at(0, 127), at(4, 10), at(8, 10, true)] },
    { gridY: 2, notes: [at(5, 100), at(6, 100, true)] },
  ];
  for (const engineClock of [false, true]) {
    // Looped, or each note gives its record back when its sample runs out.
    const voices = await planOf(tracks, { voiceLimit: 2, engineClock }, { loop: { start: 0, end: 4800 } });
    const of = (track: number) => voices.find((v) => v.track === track)!;
    assert.equal(of(0).voice.cutFrame, undefined, 'the note held at 100 keeps its record');
    assert.notEqual(of(1).voice.cutFrame, undefined, 'the faded note is stolen');
    // Its walks: the ramp at steps 1..4, flat to its end at 8, and the walk at
    // 9 that closes its gate -- each times the channel's 0.75.
    const { from, scores } = of(1).walks;
    assert.equal(from, 1);
    assert.equal(scores.length, 9);
    [127 - 117 / 4, 127 - 117 / 2, 127 - 351 / 4, 10, 10, 10, 10, 10, 10].forEach((v, i) =>
      assert.ok(Math.abs(scores[i] - 0.75 * v / 127) < 1e-12, `walk ${i + 1}`));
  }
});

test('an unpitched slot ignores a glide', async () => {
  const glide = [hit(0, 60, false), hit(2, 72, true)];
  const pitched = await planOf([{ notes: glide }]);
  assert.deepEqual(pitched[0].voice.automation?.map((p) => p.pitch), [0, 6, 12]);
  const unpitched = await planOf([{ notes: glide }], {}, { pitched: false });
  assert.deepEqual(unpitched[0].voice.automation?.map((p) => p.pitch), [0, 0, 0]);
});

test('a random start scales the sample’s own frames, not the patched buffer', async () => {
  // A loop ending on the last frame makes the buffer 16 frames longer than the
  // sample; `0x1ad1` reads the slot's `+0x78`, the sample's length.
  const voices = await planOf([{ notes: [hit(0)] }], { random: () => 0.5 }, {
    numStack: 2, startOffset: 1, frames: 4800, loop: { start: 100, end: 4800 },
  });
  assert.equal(voices[0].voice.layers?.[1].startPosition, Math.fround(4800 * 0.5));
});

test('on the engine’s clock a voice carries the walk the module runs, and its chunks', async () => {
  // 60 to 72 over two steps: the spawn's values and slide, the walk at 1
  // caught up to 66, the end record's at 2, and the walk at 3 that closes the
  // gate -- each holding from its walk's chunk end.
  const voices = await planOf([{ notes: [hit(0, 60, false), hit(2, 72, true)] }], { engineClock: true }, {}, 180);
  const { engine, engineGrid, endFrame } = voices[0].voice;
  assert.ok(engine && engineGrid?.chunks, 'the record and the chunks travel together');
  assert.deepEqual(engine.walks.map((w) => [w.pitch, w.pitchSlide]), [[60, 6], [66, 6], [72, 0], [72, 0]]);
  assert.equal(engine.walks[0].frame, 0);
  assert.equal(voices[0].startFrame + engine.walks[3].frame, endFrame, 'the closing walk is the gate');
  const plain = await planOf([{ notes: [hit(0, 60, false), hit(2, 72, true)] }], { engineClock: false }, {}, 180);
  assert.equal(plain[0].voice.engine, undefined, 'the tracker’s clock keeps the double voice');
  const live = await planOf([{ notes: [hit(0, 60, false), hit(2, 72, true)] }], { exactLadder: false }, {}, 180);
  assert.equal(live[0].voice.engine?.ladder64, true, 'the live player’s plan asks for the double ladder');
});

test('records bunched inside a step close the gate a walk late', async () => {
  // 6, 6⅓, 6⅔ and 8: the cursor reaches the end record at walk 9 and the
  // module closes at walk 10 (`closingWalk`), not at the end's step plus one.
  const at = (subStep: 0 | 1 | 2, step: number, end = false) => ({ ...hit(step, 60, end), subStep });
  // On the tracker's clock, where the gate is the step's own frame.
  const voices = await planOf([{ notes: [at(0, 6), at(1, 6), at(2, 6), at(0, 8, true)] }], { engineClock: false });
  assert.equal(voices[0].voice.endFrame, 10 * 6000);
  // 6, 6⅓ and 8: the cursor is on the end record by walk 8, in time.
  const spread = await planOf([{ notes: [at(0, 6), at(1, 6), at(0, 8, true)] }], { engineClock: false });
  assert.equal(spread[0].voice.endFrame, 9 * 6000, 'a gap lets the cursor catch up');
});

test('on the engine’s clock a voice starts and is gated where the module does', async () => {
  const voices = await planOf([{ notes: [hit(0), hit(2)] }], { engineClock: true }, {}, 180);
  assert.deepEqual(voices.map((v) => v.startFrame), [256, 8192]);
  assert.deepEqual(voices.map((v) => v.voice.endFrame), [4096, 12032]);
  assert.equal(voices[1].voice.engineGrid?.origin, 8192);
  const byDefault = await planOf([{ notes: [hit(0), hit(2)] }], {}, {}, 180);
  assert.deepEqual(byDefault.map((v) => v.startFrame), [256, 8192], 'the engine’s clock is the default');
  const ours = await planOf([{ notes: [hit(0), hit(2)] }], { engineClock: false }, {}, 180);
  assert.deepEqual(ours.map((v) => v.startFrame), [0, 8000], 'the tracker’s own clock, one switch away');
});

test('a voice placed on the clock with its window plays exactly as the render’s', async () => {
  // What the live player posts: the frames re-derived from the note's steps on
  // a clock of its own, and only the chunks the voice lives in.
  const { engineClock } = await import('../src/engine-clock.ts');
  const { placeOnClock } = await import('../src/engine-place.ts');
  const { Mixer } = await import('../src/audio/mixer.ts');
  const at = (subStep: 0 | 1 | 2, step: number, pitch: number, end = false) => ({ ...hit(step, pitch, end), subStep });
  // 130 bpm, where the clock splits blocks; a glide across two octaves, a
  // sub-step, and a resonant filter that a frame off would ring differently.
  const voices = await planOf(
    [{ notes: [at(0, 1, 48), at(1, 3, 72), at(0, 5, 60, true), at(2, 7, 55, true)] }],
    {},
    { period: 109, loop: { start: 0, end: 4800 }, params: { 3: { x: 0.5, y: 0.5 }, 4: { x: 0.6, y: 0.6 }, 14: { x: 0.2, y: 0.2 } } },
    130,
  );
  const frames = Math.round((32 * 720000) / 130) + 6 * RATE;
  const clock = engineClock(130, 0, frames);
  assert.equal(voices.length, 2);
  for (const v of voices) {
    const placed = placeOnClock(v.voice, v.startStep, v.endStep, clock)!;
    assert.equal(placed.startFrame, v.voice.startFrame);
    assert.equal(placed.endFrame, v.voice.endFrame);
    assert.deepEqual(placed.engine.walks, v.voice.engine!.walks);
    assert.ok(placed.engineGrid.chunks!.starts.length < clock.chunks.starts.length / 4, 'a window, not the song');
    const render = (spec: import('../src/audio/mixer.ts').VoiceSpec) => {
      const mixer = new Mixer(RATE);
      mixer.play(spec);
      const left = new Float32Array(10 * RATE);
      const right = new Float32Array(10 * RATE);
      mixer.render(left, right);
      return left;
    };
    const whole = render(v.voice);
    const windowed = render({ ...v.voice, ...placed });
    let peak = 0;
    for (let i = 0; i < whole.length; i += 1) {
      peak = Math.max(peak, Math.abs(whole[i]));
      assert.equal(windowed[i], whole[i], `frame ${i}`);
    }
    assert.ok(peak > 0.01, 'it sounds');
  }
});
