/**
 * The whole chain against the game's own modules, stage by stage: compare
 * what `tools/prxchain.py` wrote with what `prx-scene.ts` (`CHAIN=1`) wrote,
 * in every scene directory under a root.
 *
 *   node packages/lbp-tracker-lib/dev/prx-chain.ts <root>
 *
 * Two readings per stage, so that a mismatch names its stage:
 *
 * - **chained** -- the modules in series against our render in series, at
 *   each boundary: the synthesiser's lanes 0-1 (`prx.f32` against
 *   `ours.f32`), after `SMS Reverb` (`prx-reverb.f32` against
 *   `ours-reverb.f32`), after `SMS WaveHammer` (`prx-hammer.f32` against
 *   `ours-game.f32` with the fold taken back out), and after the fold. Each
 *   carries everything upstream of it.
 * - **local** -- our stage alone, fed the module's own input: `Reverb` on
 *   `prx.f32`'s send lanes added to its dry pair, against `prx-reverb.f32`;
 *   `WaveHammer` on `prx-reverb.f32`, against `prx-hammer.f32`; and
 *   `FOLD_CENTRE` on `prx-hammer.f32`, against FMOD's 7.1 matrix and the
 *   platform's downmix as read (below). An error here is that stage's own.
 *
 * Each reading is the error over the whole render against the module's power,
 * and the worst 1024-frame window against the loudest window (prx-compare.ts
 * says why that one, not the window's own power). `WINDOW=a,b` compares
 * seconds `a..b` only.
 *
 * The fold as the game's side does it, in float32: FMOD's 4 → 7.1 matrix for
 * a channel at `setSpeakerMix(1, 1, 1, 1, ...)` (eboot `v0xa2599f`): FL = ch0,
 * FR = ch1, FC = 0.5·ch0 + 0.5·ch1, the surrounds 0.5·ch2 and 0.5·ch3; then
 * shadPS4's `DownmixF32_8CHToStereoPS4`: L = FL + 0.7071f·FC +
 * 0.7071f·(SL + BL), the LFE unread. *The output stage* in
 * steering/lbp-audio-engine.md. ⚠️ The platform's, not the game's code.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { WaveHammer } from '../src/audio/compressor.ts';
import { FOLD_CENTRE, Reverb, reverbPreset } from '../src/audio/effects.ts';

const root = process.argv[2];
if (!root) {
  console.error('usage: prx-chain.ts <root>');
  process.exit(1);
}
const RATE = 48000;
const W = 1024;
const [from, to] = process.env.WINDOW
  ? process.env.WINDOW.split(',').map((s) => Math.round(Number(s) * RATE))
  : [0, Infinity];

const f32 = async (p: string): Promise<Float32Array | null> => {
  try {
    const x = await readFile(p);
    return new Float32Array(x.buffer, x.byteOffset, x.byteLength / 4);
  } catch {
    return null;
  }
};

/** A stereo pair read out of an interleaved buffer of `stride` lanes. */
interface Pair {
  readonly data: Float32Array;
  readonly stride: number;
}
const lanes = (data: Float32Array, stride: number): Pair => ({ data, stride });

/** The error of `ours` against `ref` over `[from, frames)`, as prx-compare.ts reads it. */
function measure(ref: Pair, ours: Pair, frames: number) {
  const end = Math.min(frames, to);
  let e = 0;
  let p = 0;
  let loud = 0;
  const windows: { at: number; err: number }[] = [];
  for (let w = from; w < end; w += W) {
    let a = 0;
    let b = 0;
    for (let i = w; i < Math.min(w + W, end); i += 1) {
      const rl = ref.data[ref.stride * i];
      const rr = ref.data[ref.stride * i + 1];
      const dl = rl - ours.data[ours.stride * i];
      const dr = rr - ours.data[ours.stride * i + 1];
      a += dl * dl + dr * dr;
      b += rl * rl + rr * rr;
    }
    windows.push({ at: w, err: a });
    loud = Math.max(loud, b);
    e += a;
    p += b;
  }
  let worst = -Infinity;
  let worstAt = 0;
  for (const { at, err } of windows) {
    const r = loud > 0 ? 10 * Math.log10(err / loud + 1e-30) : -Infinity;
    if (r > worst) [worst, worstAt] = [r, at];
  }
  return { err: p > 0 ? 10 * Math.log10(e / p + 1e-30) : -Infinity, worst, worstAt };
}

const f = Math.fround;
const DOWNMIX = f(0.7071);
/** FMOD's matrix, then the platform's downmix, from four lanes to a stereo pair. */
function gameFold(x: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const [c0, c1, c2, c3] = [x[4 * i], x[4 * i + 1], x[4 * i + 2], x[4 * i + 3]];
    const fc = f(f(0.5 * c0) + f(0.5 * c1));
    const centre = f(DOWNMIX * fc);
    out[2 * i] = f(f(c0 + centre) + f(DOWNMIX * f(f(0.5 * c2) + f(0.5 * c2))));
    out[2 * i + 1] = f(f(c1 + centre) + f(DOWNMIX * f(f(0.5 * c3) + f(0.5 * c3))));
  }
  return out;
}

/** `master-stage.ts`'s fold, alone. */
function ourFold(x: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const centre = FOLD_CENTRE * (x[4 * i] + x[4 * i + 1]);
    out[2 * i] = x[4 * i] + centre;
    out[2 * i + 1] = x[4 * i + 1] + centre;
  }
  return out;
}

/** The fold taken back out of a stereo render: its matrix is `[1+c, c; c, 1+c]`. */
function unfold(x: Float32Array, frames: number): Float32Array {
  const c = FOLD_CENTRE;
  const det = 1 + 2 * c;
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const l = x[2 * i];
    const r = x[2 * i + 1];
    out[2 * i] = ((1 + c) * l - c * r) / det;
    out[2 * i + 1] = ((1 + c) * r - c * l) / det;
  }
  return out;
}

const db = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-inf').padStart(7);
const at = (frame: number) => `${(frame / RATE).toFixed(2).padStart(6)} s`;
const show = (label: string, m: ReturnType<typeof measure>) =>
  `  ${label.padEnd(16)} err ${db(m.err)} dB   worst/loudest ${db(m.worst)} dB @${at(m.worstAt)}`;

for (const d of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  const dir = path.join(root, d.name);
  const [prx, prxRev, prxHam, ours, oursRev, oursGame] = await Promise.all(
    ['prx.f32', 'prx-reverb.f32', 'prx-hammer.f32', 'ours.f32', 'ours-reverb.f32', 'ours-game.f32'].map((n) =>
      f32(path.join(dir, n)),
    ),
  );
  if (!prx || !prxRev || !prxHam || !ours || !oursRev || !oursGame) continue;
  const scene = JSON.parse(await readFile(path.join(dir, 'scene.json'), 'utf8')) as { reverb: number };
  const frames = Math.min(prx.length / 4, prxRev.length / 4, prxHam.length / 4, ours.length / 2, oursGame.length / 2);

  // The send the reverb is given, and the lanes the game's code leaves empty.
  let send = 0;
  let sendLeft = 0;
  let hammerSurround = 0;
  for (let i = 0; i < frames; i += 1) {
    send = Math.max(send, Math.abs(prx[4 * i + 2]), Math.abs(prx[4 * i + 3]));
    sendLeft = Math.max(sendLeft, Math.abs(prxRev[4 * i + 2]), Math.abs(prxRev[4 * i + 3]));
    hammerSurround = Math.max(hammerSurround, Math.abs(prxHam[4 * i + 2]), Math.abs(prxHam[4 * i + 3]));
  }

  // Our stages on the module's own input.
  const reverb = new Reverb(RATE, reverbPreset(scene.reverb));
  const localRev = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const r = reverb.process(prx[4 * i + 2], prx[4 * i + 3]);
    localRev[2 * i] = prx[4 * i] + r.left;
    localRev[2 * i + 1] = prx[4 * i + 1] + r.right;
  }
  const hammer = new WaveHammer();
  const localHam = new Float32Array(frames * 2);
  let gainErr = 0;
  let gainErrAt = 0;
  let deepestPrx = 1;
  let deepestOurs = 1;
  for (let i = 0; i < frames; i += 1) {
    const l = prxRev[4 * i];
    const r = prxRev[4 * i + 1];
    const g = hammer.gainFor(l, r);
    localHam[2 * i] = l * g;
    localHam[2 * i + 1] = r * g;
    deepestOurs = Math.min(deepestOurs, g);
    // The module's gain, read where the input is far enough from zero to divide by.
    const big = Math.abs(l) >= Math.abs(r) ? 0 : 1;
    const x = big === 0 ? l : r;
    if (Math.abs(x) > 1e-3) {
      const gp = prxHam[4 * i + big] / x;
      deepestPrx = Math.min(deepestPrx, gp);
      const e = Math.abs(20 * Math.log10(gp / g));
      if (e > gainErr) [gainErr, gainErrAt] = [e, i];
    }
  }
  const fold = gameFold(prxHam, frames);

  let peak = 0;
  for (let i = 0; i < 2 * frames; i += 1) peak = Math.max(peak, Math.abs(prxRev[(i >> 1) * 4 + (i & 1)]));
  console.log(
    `${d.name}: reverb ${scene.reverb}, send peak ${send > 0 ? (20 * Math.log10(send)).toFixed(1) + ' dBFS' : 'silent'}, ${(frames / RATE).toFixed(2)} s; into the WaveHammer peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, ` +
      `its deepest gain ${(20 * Math.log10(deepestPrx)).toFixed(2)} dB (ours on its input ${(20 * Math.log10(deepestOurs)).toFixed(2)})`,
  );
  console.log(`  lanes 2-3 after the reverb max ${sendLeft.toExponential(1)}, after the WaveHammer max ${hammerSurround.toExponential(1)}`);
  console.log(' chained');
  console.log(show('synth', measure(lanes(prx, 4), lanes(ours, 2), frames)));
  console.log(show('+ reverb', measure(lanes(prxRev, 4), lanes(oursRev, 2), frames)));
  console.log(show('+ WaveHammer', measure(lanes(prxHam, 4), lanes(unfold(oursGame, frames), 2), frames)));
  console.log(show('+ fold', measure(lanes(fold, 2), lanes(oursGame, 2), frames)));
  console.log(' local');
  console.log(show('reverb', measure(lanes(prxRev, 4), lanes(localRev, 2), frames)));
  console.log(
    show('WaveHammer', measure(lanes(prxHam, 4), lanes(localHam, 2), frames)) +
      `   gain off by ${gainErr.toExponential(1)} dB at most, @${at(gainErrAt)}`,
  );
  console.log(show('fold', measure(lanes(fold, 2), lanes(ourFold(prxHam, frames), 2), frames)));
}
