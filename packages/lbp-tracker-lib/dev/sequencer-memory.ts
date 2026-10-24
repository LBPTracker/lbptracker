/**
 * The sequencer's thermometer, as the game computes it -- measured over real levels.
 *
 *   node packages/lbp-tracker-lib/dev/sequencer-memory.ts [dir ...]
 *
 * The eboot's `v0x1c4720` walks every `PInstrument` on a sequencer's board, puts
 * the eight `SampleGuids` of each loaded `RInstrument` into one set, and sums the
 * FileDB size of every distinct sample; `v0x74b960` shows that against
 * `MaxSequencerMemory`, which `gamedata/data/limits_settings.lmt` sets to
 * 1,000,000 (steering/sequencer-engine-inputs.md). This runs the same sum over a
 * corpus: if the reading is right, what creators managed to build sits under the
 * limit, and the fullest boards sit just under it.
 *
 * ⚠️ A sample missing from `fixtures/smp/manifest.json` counts as 0 here and is
 * reported, so a low total with misses is not evidence of anything.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readLevelProject } from '@lbptracker/cwlib/sequencer/project.ts';
import { loadResourceFile, nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { readInstrument, usedSlots } from '@lbptracker/cwlib/resources/instrument.ts';

const LIMIT = 1_000_000;
const RINST = process.env.LBP_RINST ?? 'fixtures/rinst';
const SMP = process.env.LBP_SMP ?? 'fixtures/smp';
const DIRS = process.argv.length > 2
  ? process.argv.slice(2)
  : [process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data', 'fixtures/archive', 'fixtures/plans'];

interface Row { guid: number; file: string; size: number }
const manifest = async (dir: string) =>
  new Map((JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Row[]).map((r) => [r.guid, r]));

const rinst = await manifest(RINST);
const smp = await manifest(SMP);

/** RInstrument GUID -> the sample GUIDs in its used slots. */
const samplesOf = new Map<number, number[]>();
for (const [guid, row] of rinst) {
  const inst = readInstrument((await loadResourceFile(path.join(RINST, row.file))).data);
  samplesOf.set(guid, usedSlots(inst).map((s) => s.guid));
}

// ---------------------------------------------------------- per instrument
const cost = (guids: Iterable<number>) => {
  let bytes = 0;
  let missing = 0;
  for (const g of new Set(guids)) {
    const row = smp.get(g);
    if (row) bytes += row.size;
    else missing += 1;
  }
  return { bytes, missing };
};

console.log(`one instrument alone, of ${LIMIT.toLocaleString('en')} bytes:`);
const alone = [...rinst].map(([guid, row]) => ({ name: row.file.replace(/\.rinst$/, ''), ...cost(samplesOf.get(guid) ?? []) }));
alone.sort((a, b) => b.bytes - a.bytes);
for (const a of alone) {
  console.log(`  ${a.name.padEnd(28)} ${String(a.bytes).padStart(8)}  ${(100 * a.bytes / LIMIT).toFixed(1).padStart(5)}%${a.missing ? `  (${a.missing} samples not in the manifest)` : ''}`);
}

// ------------------------------------------------------------ over a corpus
interface Seen { where: string; name: string; bytes: number; instruments: number; missing: number; unknown: number }
const seen: Seen[] = [];
for (const dir of DIRS) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) continue;
    let project;
    try {
      project = await readLevelProject(entry.name, new Uint8Array(await readFile(path.join(dir, entry.name))), nodeInflate);
    } catch { continue; }
    for (const seq of project.sequencers) {
      const guids = new Set(seq.tracks.map((t) => t.guid));
      if (!guids.size) continue;
      const samples: number[] = [];
      let unknown = 0;
      for (const g of guids) {
        const s = samplesOf.get(g);
        if (s) samples.push(...s);
        else unknown += 1;
      }
      seen.push({ where: `${path.basename(dir)}/${entry.name}`, name: seq.name, instruments: guids.size, unknown, ...cost(samples) });
    }
  }
}

seen.sort((a, b) => b.bytes - a.bytes);
const over = seen.filter((s) => s.bytes > LIMIT);
console.log(`\n${seen.length} sequencers with chips; ${over.length} over the limit`);
const buckets = [0.25, 0.5, 0.75, 0.9, 1, Infinity];
let lo = 0;
for (const hi of buckets) {
  const n = seen.filter((s) => s.bytes / LIMIT > lo && s.bytes / LIMIT <= hi).length;
  console.log(`  ${(lo * 100).toFixed(0).padStart(3)}% .. ${hi === Infinity ? '    ' : `${(hi * 100).toFixed(0).padStart(3)}%`}  ${n}`);
  lo = hi;
}
console.log('\nthe fullest:');
for (const s of seen.slice(0, 15)) {
  console.log(`  ${String(s.bytes).padStart(8)}  ${(100 * s.bytes / LIMIT).toFixed(1).padStart(5)}%  ${String(s.instruments).padStart(2)} instruments  ${s.where}  "${s.name}"${s.unknown ? `  (${s.unknown} unknown instruments)` : ''}${s.missing ? `  (${s.missing} samples missing)` : ''}`);
}
