/**
 * One half of the differential test against the game's own synthesiser: build
 * a scene `tools/prxsynth.py` runs through `fmodextinput.prx`, and render the
 * same song with ours, matched.
 *
 *   node packages/lbp-tracker-lib/dev/prx-scene.ts <outdir> synth <instrument> [variant]
 *   node packages/lbp-tracker-lib/dev/prx-scene.ts <outdir> level <uid> [seconds]
 *   node packages/lbp-tracker-lib/dev/prx-scene.ts <outdir> backup <save dir> [seconds]
 *
 * Writes `<outdir>/scene.json` -- the clips, headers and instruments as the
 * eboot lays them out -- and `<outdir>/ours.f32`, our render as the module's
 * lanes 0-1 (dry + echo, before the reverb): stereo float32, the fold's gain
 * taken back out. `packages/lbp-tracker-lib/dev/prx-compare.ts` reads both.
 *
 * `synth` writes a short phrase on one instrument (a file-name substring) at
 * 175.78125 bpm, 4096 frames a step, where every step is a whole number of the
 * engine's blocks and its clock is ours. The variants: `notes` (the default),
 * `chord`, `glide`, `gpitch`, `gvol`, `gmod` (one ramp alone), `gsub`
 * (sub-step records inside a note, three in one step), `gover` (a slide over
 * a third that overshoots to modulation 2.8) and `echo`.
 * `level` takes a sequencer by uid from the level files in `LBP_LEVELS`.
 * `backup` takes one out of a folder `readBackup` opens -- a PS3 save
 * directory, where `C4K3 S0NG` lives: the first whose name matches `PICK` (a
 * case-insensitive regex), or the one with the most tracks.
 *
 * Environment:
 * - `PARAMS="i=x,y;..."` overrides `Params[i]` on both sides -- the way to
 *   isolate which parameter a difference rides on.
 * - `TRACKS=i,j,...` keeps only those of `seq.tracks`, on both sides.
 * - `CLOCK=1` renders ours on the engine's step clock
 *   (`RenderOptions.engineClock`); without it a song's onsets differ by
 *   design (*3* in steering/open-questions.md) and the comparison means little
 *   past the first note off a block boundary.
 * - `TAIL=0` renders ours with the pool's release tail off, the tracker's
 *   default (*29* in steering/open-questions.md); without it the tail is on,
 *   as the module does it.
 * - `POOL=a,b` prints what our pool decided for every note whose occupancy
 *   overlaps seconds `a..b`: its clip in `scene.json`, pitch, steps, score at
 *   the claim and after its last walk, and the step it was cut at -- to set
 *   beside `VOICES=` on `tools/prxsynth.py`.
 * - `CHAIN=1` also renders the rest of the chain, for `tools/prxchain.py` and
 *   `prx-chain.ts`: `ours-reverb.f32`, the reverb's return added and the
 *   fold's gain taken back out (`master: 'none'`), and `ours-game.f32`, the
 *   whole render with the game's master bus, the WaveHammer and the fold.
 *
 * Ours runs as the module does: no declick, no reverb return, no master bus,
 * and `random` the harness's constant `rand()` scaled as the engine scales it.
 * ⚠️ A clip's length (`PInstrument+0x60`) is the chip's drawn width in the
 * game (`v0x1c49e0`); the scene takes the editor's rule from the notes, as the
 * render's row scan does, which agrees with it on every chip measured.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { FOLD_GAIN, clipHeaderOrder, renderSequencer, type LoadedInstrument } from '../src/render.ts';
import { readInstrument, usedSlots, type RInstrument } from '@lbptracker/cwlib/resources/instrument.ts';
import { clipStepsFor } from '../src/song.ts';
import { engineSample, readWav } from '../src/wav.ts';
import { readBackup } from '@lbptracker/cwlib/sequencer/backup.ts';
import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/sequencer/chips.ts';
import { decodeRecords, groupNotes } from '@lbptracker/cwlib/sequencer/notes.ts';
import { loadResourceFile, nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { readLevelProject, type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';

/** What `tools/prxrun.py`'s `rand()` returns: `standard(rand_constant=...)`. */
const RAND = 0x13333333;
const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const RINST = 'fixtures/rinst';
const SMP = 'fixtures/smp';

const [outdir, mode, arg, extra] = process.argv.slice(2);
if (!outdir || !['synth', 'level', 'backup'].includes(mode) || !arg) {
  console.error('usage: prx-scene.ts <outdir> synth <instrument> [variant] | level <uid> [seconds] | backup <dir> [seconds]');
  process.exit(1);
}

const manifest = async (dir: string) =>
  new Map<number, { file: string }>(
    (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { guid: number; file: string }[])
      .map((r) => [r.guid, r]),
  );
const rinst = await manifest(RINST);
const smp = await manifest(SMP);

const OVERRIDE = new Map<number, { x: number; y: number }>(
  (process.env.PARAMS ?? '').split(';').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    const [x, y] = v.split(',').map(Number);
    return [Number(k), { x, y }];
  }),
);
const patched = (inst: RInstrument): RInstrument =>
  OVERRIDE.size === 0 ? inst : { ...inst, params: inst.params.map((p, i) => OVERRIDE.get(i) ?? p) };

const cache = new Map<number, LoadedInstrument | null>();
const load = async (guid: number): Promise<LoadedInstrument | null> => {
  if (cache.has(guid)) return cache.get(guid)!;
  const row = rinst.get(guid);
  if (!row) {
    cache.set(guid, null);
    return null;
  }
  const inst = patched(readInstrument((await loadResourceFile(path.join(RINST, row.file))).data));
  const slots = [];
  for (const { slot, guid: g } of usedSlots(inst)) {
    const s = smp.get(g);
    if (!s) continue;
    const wav = readWav(await readFile(path.join(SMP, s.file)));
    const engine = engineSample(wav);
    slots.push({
      base: slot.baseNote,
      wav: { channels: engine.channels, sampleRate: wav.sampleRate, loop: engine.loop, mips: engine.channels.map((c) => buildMipChain(c)) },
    });
  }
  const loaded = { inst, slots };
  cache.set(guid, loaded);
  return loaded;
};

const rec = (step: number, pitch: number, end: boolean, volume = 96, mod = 0, subStep: 0 | 1 | 2 = 0) => ({
  // A sub-step is bit 7 of the first byte, doubled by bit 30 -- the fourth byte's 0x40.
  step, pitch, volume, timbre: (mod & 0x0f) | (subStep === 2 ? 0x40 : 0), modulation: (mod & 0x0f) / 15, subStep, end,
});
const encode = (rs: ReturnType<typeof rec>[]): Uint8Array => {
  const b = new Uint8Array(rs.length * 4);
  rs.forEach((r, i) => {
    b[4 * i] = (r.step & 0x7f) | (r.subStep > 0 ? 0x80 : 0);
    b[4 * i + 1] = (r.pitch & 0x7f) | (r.end ? 0x80 : 0);
    b[4 * i + 2] = r.volume;
    b[4 * i + 3] = r.timbre;
  });
  return b;
};

let seq: Sequencer | undefined;
let seconds: number;
if (mode === 'synth') {
  const hit = [...rinst.entries()].find(([, r]) => r.file.includes(arg));
  if (!hit) throw new Error(`no instrument matching ${arg}`);
  const variant = extra ?? 'notes';
  // Notes on whole steps from step 1: with 4096 frames a step the engine's
  // chunks land on every one of them, and 256/4096 is exact in float32.
  const rs =
    variant === 'gpitch' ? [rec(1, 48, false, 100), rec(4, 60, false, 100), rec(7, 55, true, 100)]
    : variant === 'gvol' ? [rec(1, 60, false, 110), rec(4, 60, false, 40), rec(7, 60, true, 110)]
    : variant === 'gmod' ? [rec(1, 60, false, 100, 0), rec(4, 60, false, 100, 15), rec(7, 60, true, 100, 5)]
    : variant === 'glide' ? [rec(1, 48, false, 110, 0), rec(4, 60, false, 60, 15), rec(7, 55, true, 110, 5)]
    // Sub-step records inside a note, and three records inside one step: the
    // walk takes each at its whole step and moves one record per walk.
    : variant === 'gsub'
      ? [rec(1, 48, false, 100, 0), rec(2, 60, false, 40, 15, 1), rec(3, 55, false, 110, 5, 2), rec(5, 50, true, 90),
        rec(6, 48, false, 100, 0), rec(6, 60, false, 110, 3, 1), rec(6, 52, false, 120, 6, 2), rec(8, 48, true, 100)]
    // The slide over the first third runs to the walk: the modulation reaches
    // 2.8 and the pitch 84 before step 7 takes the second record.
    : variant === 'gover'
      ? [rec(1, 48, false, 100, 0), rec(1, 60, false, 110, 15, 1), rec(1, 52, false, 120, 8, 2), rec(3, 48, true, 100)]
    : variant === 'chord'
      ? [rec(1, 48, true), rec(1, 55, true), rec(1, 60, true, 80, 15), rec(5, 36, true, 127), rec(5, 72, true, 40, 8)]
      : [rec(1, 48, true), rec(3, 60, false, 120), rec(4, 60, true, 120), rec(6, 67, true, 70, 15), rec(9, 36, true, 127, 7)];
  const records = encode(rs);
  const { notes } = groupNotes(decodeRecords(records));
  const echo = variant === 'echo';
  seq = {
    uid: 1, name: `synth ${arg}`, author: '', tempo: 175.78125, swing: 0,
    echoFeedback: echo ? 0.5 : 0, echoTime: 1, echoMix: echo ? 0.6 : 0, reverb: 5,
    loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [{
      guid: hit[0], name: 't', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0, level: 1, pan: 0.3,
      echoSend: echo ? 1 : 0.5, reverbSend: 0.4, key: 0, scale: 0, notes, records, trailingRecords: 0,
    }],
    lengthSteps: 16,
  };
  seconds = (16 * 4096) / 48000;
} else {
  if (mode === 'level') {
    for (const e of await readdir(LEVELS, { withFileTypes: true })) {
      if (!e.isFile() || seq) continue;
      try {
        const p = await readLevelProject(e.name, new Uint8Array(await readFile(path.join(LEVELS, e.name))), nodeInflate);
        seq = p.sequencers.find((s) => s.uid === Number(arg));
      } catch {
        // not a level
      }
    }
  } else {
    const files = [];
    for (const e of await readdir(arg, { withFileTypes: true })) {
      if (e.isFile()) files.push({ name: e.name, bytes: new Uint8Array(await readFile(path.join(arg, e.name))) });
    }
    const all = (await readBackup(files, nodeInflate)).projects.flatMap((p) => p.sequencers);
    const pick = process.env.PICK ? new RegExp(process.env.PICK, 'i') : undefined;
    seq = pick
      ? all.find((s) => pick.test(s.name))
      : all.reduce<Sequencer | undefined>((a, s) => (a && a.tracks.length >= s.tracks.length ? a : s), undefined);
  }
  if (!seq) throw new Error(`no sequencer ${arg}`);
  if (process.env.TRACKS) {
    const keep = process.env.TRACKS.split(',').map(Number);
    seq = { ...seq, tracks: seq.tracks.filter((_, i) => keep.includes(i)) };
  }
  seconds = Number(extra ?? 20);
}

// --- the scene, as the eboot lays it out (synth-engine.md, *The clip*)
const instIndex = new Map<number, number>();
const instruments = [];
for (const t of seq.tracks) {
  if (instIndex.has(t.guid)) continue;
  const row = rinst.get(t.guid);
  if (!row) continue;
  const inst = patched(readInstrument((await loadResourceFile(path.join(RINST, row.file))).data));
  instIndex.set(t.guid, instruments.length);
  instruments.push({
    guid: t.guid, file: row.file, splitNotes: inst.splitNotes, numStack: inst.numStack,
    params: inst.params.map((p) => [p.x, p.y]), arpeggiate: inst.arpeggiate,
    slots: inst.slots.map((s, i) => ({
      root: s.baseNote, tempo: s.baseBpm, fineTune: s.fineTune, pitched: s.pitched, synced: s.fitBpm,
      smp: smp.get(inst.sampleGuids[i]) ? path.resolve(SMP, smp.get(inst.sampleGuids[i])!.file) : null,
    })),
  });
}
const count = Math.min(8, Math.max(1, seq.numChannels));
const rows = seq.boardRows ?? 0;
const channelOf = (gridY: number) =>
  rows > 0
    ? Math.min(count - 1, Math.max(0, Math.floor(gridY / Math.max(Math.floor(rows / count), 1))))
    : ((gridY % count) + count) % count;
// ❗ The headers go in the eboot's order, sorted by column and then row
// (`clipHeaderOrder`), not the file's: the module's row scan reads that order.
const headers = clipHeaderOrder(seq.tracks).filter((i) => instIndex.has(seq.tracks[i].guid));
const clips = headers.map((i) => seq.tracks[i]).map((t) => {
  const words: number[] = [];
  for (let i = 0; i + 4 <= t.records.length; i += 4) {
    const w = (t.records[i] | (t.records[i + 1] << 8) | (t.records[i + 2] << 16) | (t.records[i + 3] << 24)) >>> 0;
    words.push((w & 0xcfffffff) >>> 0); // v0x160884: bits 28..29 cleared
  }
  // ⚠️ The header's length is what keeps a finished clip off its row (`0x0393`);
  // 0x7fffffff here once let a clip hold its row for the whole song.
  const length = mode === 'synth' ? 0x7fffffff : clipStepsFor(Math.max(0, ...words.map((w) => w & 0x7f)));
  return {
    cell: Math.max(0, t.gridX), channel: channelOf(t.gridY), row: t.gridY, length,
    level: t.level, pan: t.pan, echoSend: t.echoSend, reverbSend: t.reverbSend,
    root: t.key < 12 ? t.key + 12 : t.key, scale: t.scale, inst: instIndex.get(t.guid), words,
  };
});
const frames = Math.ceil((seconds * 48000) / 1024) * 1024;
await mkdir(outdir, { recursive: true });
await writeFile(path.join(outdir, 'scene.json'), JSON.stringify({
  tempo: seq.tempo, swing: seq.swing, echoTime: seq.echoTime, echoFeedback: seq.echoFeedback, echoMix: seq.echoMix,
  volumes: seq.volumes, numChannels: seq.numChannels, reverb: seq.reverb, rand: RAND, frames, clips, instruments,
}));

const clipOf = new Map(headers.map((i, k) => [i, k]));
const [poolFrom, poolTo] = (process.env.POOL ?? '').split(',').map(Number);
const pool: string[] = [];
const seen = new Map<string, number>();
const sequencer = seq;
const r = await renderSequencer(seq, load, {
  secondsArg: frames / 48000, master: 'none', reverb: false, declick: false,
  releaseTail: process.env.TAIL !== '0',
  engineClock: process.env.CLOCK === '1',
  random: () => RAND / 2 ** 30,
  onVoice: process.env.POOL
    ? (voice, at) => {
        const fps = 720000 / sequencer.tempo;
        if (at.poolEnd * fps < poolFrom * 48000 || at.poolStart * fps > poolTo * 48000) return;
        // A chord is several notes at one position: the k-th call there is the
        // k-th of them, as `schedule` keeps a track's order.
        const track = sequencer.tracks[at.track];
        const key = `${at.track}@${at.startStep}`;
        const k = seen.get(key) ?? 0;
        seen.set(key, k + 1);
        const note = track.notes.filter((n) => Math.abs(track.stepOffset + n.startPosition - at.startStep) < 1e-6)[k];
        const cut = voice.cutFrame === undefined ? '' : `  CUT at ${(voice.cutFrame / 48000).toFixed(3)} s`;
        pool.push(
          `${(at.startFrame / 48000).toFixed(3).padStart(7)} s  c${clipOf.get(at.track)} ${rinst.get(at.guid)?.file ?? at.guid} ` +
            `pitch ${note?.points[0].pitch} steps ${at.poolStart.toFixed(2)}..${at.poolEnd.toFixed(2)} ` +
            `score ${at.score.toFixed(4)}>${(at.walks.scores.at(-1) ?? at.score).toFixed(4)}${cut}`,
        );
      }
    : undefined,
});
for (const line of pool.sort()) console.log(line);
const out = new Float32Array(frames * 2);
for (let i = 0; i < frames; i += 1) {
  out[2 * i] = r.left[i] / FOLD_GAIN;
  out[2 * i + 1] = r.right[i] / FOLD_GAIN;
}
await writeFile(path.join(outdir, 'ours.f32'), new Uint8Array(out.buffer));
console.log(`${seq.name}: ${clips.length} clips, ${instruments.length} instruments, ${frames} frames; ours peak ${r.peak.toFixed(4)}`);

if (process.env.CHAIN === '1') {
  const options = {
    secondsArg: frames / 48000, declick: false,
    releaseTail: process.env.TAIL !== '0',
    engineClock: process.env.CLOCK === '1',
    random: () => RAND / 2 ** 30,
  };
  const wet = await renderSequencer(seq, load, { ...options, master: 'none' });
  for (let i = 0; i < frames; i += 1) {
    out[2 * i] = wet.left[i] / FOLD_GAIN;
    out[2 * i + 1] = wet.right[i] / FOLD_GAIN;
  }
  await writeFile(path.join(outdir, 'ours-reverb.f32'), new Uint8Array(out.buffer));
  const game = await renderSequencer(seq, load, { ...options, master: 'game' });
  for (let i = 0; i < frames; i += 1) {
    out[2 * i] = game.left[i];
    out[2 * i + 1] = game.right[i];
  }
  await writeFile(path.join(outdir, 'ours-game.f32'), new Uint8Array(out.buffer));
  console.log(`  the chain: reverb ${seq.reverb}, WaveHammer deepest ${(20 * Math.log10(game.compressorGain)).toFixed(2)} dB, peak ${game.peak.toFixed(4)}`);
}
