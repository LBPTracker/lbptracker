/**
 * The other half of the differential test: compare `prx.f32` (the module's
 * four lanes, from `tools/prxsynth.py`) with `ours.f32` (two lanes, from
 * `prx-scene.ts`) in every scene directory under a root.
 *
 *   node packages/lbp-tracker-lib/dev/prx-compare.ts <root>
 *
 * Per scene: the error over the whole render, the worst 1024-frame window
 * against its OWN power, and the worst window against the LOUDEST window's.
 * ⚠️ Read the last one first. Against its own power a window in a tail at
 * -90 dB reports 0 dB for a voice that ends a block apart -- inaudible, and it
 * once looked like the worst scene of the batch.
 *
 * `WINDOW=a,b` compares seconds `a..b` only -- a passage of a song, with the
 * loudest window taken inside it too.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: prx-compare.ts <root>');
  process.exit(1);
}
const f32 = async (p: string) => {
  const x = await readFile(p);
  return new Float32Array(x.buffer, x.byteOffset, x.byteLength / 4);
};
const W = 1024;
const STEP = 4096; // the synth scenes' frames per step, for the positions printed
const [from, to] = process.env.WINDOW
  ? process.env.WINDOW.split(',').map((s) => Math.round(Number(s) * 48000))
  : [0, Infinity];
const rows = [];
for (const d of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  const dir = path.join(root, d.name);
  let prx: Float32Array;
  let ours: Float32Array;
  try {
    prx = await f32(path.join(dir, 'prx.f32'));
    ours = await f32(path.join(dir, 'ours.f32'));
  } catch {
    continue;
  }
  const frames = Math.min(prx.length / 4, ours.length / 2, to);
  const we: number[] = [];
  const wp: number[] = [];
  let e = 0;
  let p = 0;
  for (let w = from; w < frames; w += W) {
    let a = 0;
    let b = 0;
    for (let i = w; i < w + W && i < frames; i += 1) {
      const dl = prx[4 * i] - ours[2 * i];
      const dr = prx[4 * i + 1] - ours[2 * i + 1];
      a += dl * dl + dr * dr;
      b += prx[4 * i] ** 2 + prx[4 * i + 1] ** 2;
    }
    we.push(a);
    wp.push(b);
    e += a;
    p += b;
  }
  const loud = Math.max(...wp);
  let own = -Infinity;
  let ownAt = 0;
  let rel = -Infinity;
  let relAt = 0;
  we.forEach((a, k) => {
    if (wp[k] > 1e-10) {
      const r = 10 * Math.log10(a / wp[k] + 1e-30);
      if (r > own) [own, ownAt] = [r, k];
    }
    if (loud > 0) {
      const r = 10 * Math.log10(a / loud + 1e-30);
      if (r > rel) [rel, relAt] = [r, k];
    }
  });
  rows.push({ name: d.name, err: p > 0 ? 10 * Math.log10(e / p + 1e-30) : -999, own, ownAt, rel, relAt });
}
rows.sort((a, b) => b.rel - a.rel);
const at = (k: number) => ((from + k * W) / STEP).toFixed(2).padStart(6);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(36)} err ${r.err.toFixed(1).padStart(7)} dB  ` +
      `worst/own ${r.own.toFixed(1).padStart(7)} @${at(r.ownAt)}  worst/loudest ${r.rel.toFixed(1).padStart(7)} @${at(r.relAt)}`,
  );
}
console.log(
  `\n${rows.length} scenes; ${rows.filter((r) => r.rel > -60).length} with a window above -60 dB of the loudest; ` +
    `${rows.filter((r) => r.err > -60).length} above -60 dB overall`,
);
