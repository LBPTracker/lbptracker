/**
 * Are `Notes.y`, `basenote` and `Splitnotes` the same numbering? — measured.
 *
 *   node --experimental-strip-types packages/lbp-tracker-lib/dev/pitch-probe.ts [levels-dir]
 *
 * This is the evidence for open question 4, which is the one still able to
 * transpose an entire imported level. It asks two things the corpus can answer
 * without opening the eboot:
 *
 *  1. **Does each key zone contain its own sample's base note?** A sampler is
 *     voiced so that a zone's sample plays near its own pitch, so if the two
 *     fields were 20 apart -- the toolkit annotates `basenote` as MIDI and
 *     `Splitnotes` as piano-key numbers -- almost every base note would land
 *     outside the zone that owns it.
 *
 *  2. **Do composers write notes where the instrument's samples are?** If `y`
 *     were in a different numbering from `basenote`, the notes a level plays
 *     would sit at a constant offset from the samples they are played on, the
 *     same offset for every instrument.
 *
 * Both are properties of a real corpus rather than of one instrument, which is
 * what makes them worth more than the name of any single `.smp` file.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveSlot, zoneCount } from '../src/instrument.ts';
import { readLevelProject, schedule } from '@lbptracker/cwlib/sequencer/project.ts';
import { readInstrument, usedSlots, type RInstrument } from '@lbptracker/cwlib/resources/instrument.ts';
import { loadResourceFile, nodeInflate } from '@lbptracker/cwlib/platform/node.ts';

const LEVELS = process.argv[2] ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const RINST = 'fixtures/rinst';

const rinstIndex = new Map<number, { file: string }>(
  (JSON.parse(await readFile(path.join(RINST, 'manifest.json'), 'utf8')) as {
    guid: number;
    file: string;
  }[]).map((r) => [r.guid, r]),
);

const cache = new Map<number, { inst: RInstrument; name: string } | null>();
async function load(guid: number) {
  const hit = cache.get(guid);
  if (hit !== undefined) return hit;
  const row = rinstIndex.get(guid);
  if (!row) return cache.set(guid, null).get(guid)!;
  const inst = readInstrument((await loadResourceFile(path.join(RINST, row.file))).data);
  const v = { inst, name: row.file.replace(/\.\w+$/, '') };
  cache.set(guid, v);
  return v;
}

// ------------------------------------------------- 1. zones against base notes

/** The half-open note range `resolveSlot` gives zone `i`, as [low, high). */
function zoneRange(inst: RInstrument, i: number, zones: number): [number, number] {
  const splits = inst.splitNotes;
  // zone i owns notes >= splits[i+1] that are not claimed by a lower zone.
  const low = i + 1 < zones ? splits[i + 1] : -Infinity;
  const high = i === 0 ? Infinity : splits[i];
  return [low, high];
}

let zonesChecked = 0;
let baseInside = 0;
const outside: string[] = [];
for (const [guid, row] of rinstIndex) {
  const l = await load(guid);
  if (!l) continue;
  const used = [...usedSlots(l.inst)];
  const zones = Math.max(1, Math.min(used.length, zoneCount(l.inst)));
  if (zones < 2) continue; // a single zone owns every note; nothing to test
  for (let i = 0; i < zones; i += 1) {
    const [low, high] = zoneRange(l.inst, i, zones);
    const base = l.inst.slots[i].baseNote;
    zonesChecked += 1;
    if (base >= low && base < high) baseInside += 1;
    else outside.push(`${l.name} zone ${i}: base ${base} not in [${low}, ${high})`);
  }
  void row;
}

const pct = (n: number, of: number) => `${((100 * n) / (of || 1)).toFixed(1)}%`;
console.log(
  `\n1. KEY ZONES: ${baseInside} of ${zonesChecked} zones contain their own sample's ` +
    `base note (${pct(baseInside, zonesChecked)})`,
);
for (const line of outside.slice(0, 12)) console.log(`   ${line}`);
if (outside.length > 12) console.log(`   … and ${outside.length - 12} more`);
console.log(
  `   \u2192 a 20-semitone mismatch between the two fields would put nearly every base note\n` +
    `     outside its own zone. Shifting Splitnotes by +20 for comparison gives:`,
);
{
  let inside = 0;
  let n = 0;
  for (const [guid] of rinstIndex) {
    const l = await load(guid);
    if (!l) continue;
    const used = [...usedSlots(l.inst)];
    const zones = Math.max(1, Math.min(used.length, zoneCount(l.inst)));
    if (zones < 2) continue;
    for (let i = 0; i < zones; i += 1) {
      const [low, high] = zoneRange(l.inst, i, zones);
      const base = l.inst.slots[i].baseNote;
      n += 1;
      if (base >= low + 20 && base < high + 20) inside += 1;
    }
  }
  console.log(`     ${inside} of ${n} (${pct(inside, n)})`);
}

// ------------------------------------------- 2. what composers actually play

interface Play {
  name: string;
  notes: number;
  sum: number;
  min: number;
  max: number;
  /** Sum of (note - the base note of the slot it resolves to). */
  offsetSum: number;
  offsets: number[];
}
const played = new Map<number, Play>();

for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  let project;
  try {
    project = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
  } catch {
    continue;
  }
  for (const seq of project.sequencers) {
    for (const event of schedule(seq)) {
      const l = await load(event.guid);
      if (!l) continue;
      const used = [...usedSlots(l.inst)];
      if (used.length === 0) continue;
      const zone = resolveSlot(l.inst, event.pitch, used.length);
      const base = l.inst.slots[Math.min(zone, l.inst.slots.length - 1)].baseNote;
      let p = played.get(event.guid);
      if (!p) {
        played.set(event.guid, (p = {
          name: l.name, notes: 0, sum: 0, min: 127, max: 0, offsetSum: 0, offsets: [],
        }));
      }
      p.notes += 1;
      p.sum += event.pitch;
      p.min = Math.min(p.min, event.pitch);
      p.max = Math.max(p.max, event.pitch);
      p.offsetSum += event.pitch - base;
      if (p.offsets.length < 200000) p.offsets.push(event.pitch - base);
    }
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

console.log(`\n2. WHAT COMPOSERS PLAY, against the base note of the slot each note resolves to`);
console.log('instrument            notes   y range    mean y   median offset  mean offset');
const rows = [...played.values()].filter((p) => p.notes >= 200).sort((a, b) => b.notes - a.notes);
for (const p of rows) {
  console.log(
    p.name.slice(0, 21).padEnd(22) +
      String(p.notes).padStart(6) +
      `  ${p.min}..${p.max}`.padEnd(11) +
      (p.sum / p.notes).toFixed(1).padStart(8) +
      String(median(p.offsets)).padStart(15) +
      (p.offsetSum / p.notes).toFixed(1).padStart(13),
  );
}
const allOffsets = rows.flatMap((p) => p.offsets);
const allNotes = rows.reduce((a, p) => a + p.notes, 0);
console.log(
  `\n   over ${allNotes} notes on ${rows.length} instruments: median offset ` +
    `${median(allOffsets)}, mean ${(allOffsets.reduce((a, b) => a + b, 0) / allOffsets.length).toFixed(2)}`,
);
console.log('   -> an offset centred on 0 says y and basenote are the same numbering.');
console.log('      A constant -12, -20 or -24 on every instrument would say they are not.');

// --------------------------------------- 3. does `Key` rotate the scale table?

/**
 * `quantise` snaps to a table rooted at 0 (C) and knows nothing about `Key`.
 * Two readings of that, and the corpus can separate them:
 *
 *  (a) `Key` only constrains what the editor lets you place. Then a track's
 *      notes are already on the scale rooted at `Key`, and the engine's root-0
 *      table would MOVE them -- audibly, for every `Key != 0` track.
 *  (b) `Key` rotates the table: `key + quantise(y - key, scale)`.
 *
 * Whichever reading leaves the corpus's notes where they already are is the one
 * the editor was writing against.
 */
{
  const { quantise: q, SCALE_NAMES: names } = await import('../src/scale.ts');
  type Cell = { notes: number; fixedRoot0: number; fixedRotated: number };
  const cells = new Map<string, Cell>();
  let scaled = 0;
  let total = 0;

  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let project;
    try {
      project = await readLevelProject(
        entry.name,
        new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
        nodeInflate,
      );
    } catch {
      continue;
    }
    for (const seq of project.sequencers) {
      for (const track of seq.tracks) {
        for (const note of track.notes) {
          total += 1;
          if (track.scale < 1 || track.scale > 5) continue;
          scaled += 1;
          const key = `${track.scale}|${track.key}`;
          let cell = cells.get(key);
          if (!cell) cells.set(key, (cell = { notes: 0, fixedRoot0: 0, fixedRotated: 0 }));
          cell.notes += 1;
          const y = note.points[0].pitch;
          if (q(y, track.scale) === y) cell.fixedRoot0 += 1;
          if (track.key + q(y - track.key, track.scale) === y) cell.fixedRotated += 1;
        }
      }
    }
  }

  console.log(
    `\n3. KEY AND SCALE: ${scaled} of ${total} corpus notes are on a non-chromatic scale`,
  );
  if (scaled === 0) {
    console.log('   nothing to measure here -- the corpus never uses one.');
  } else {
    console.log('   scale             key    notes   already on root-0   already on rotated');
    for (const [k, c] of [...cells].sort((a, b) => b[1].notes - a[1].notes)) {
      const [scale, key] = k.split('|').map(Number);
      console.log(
        `   ${(names[scale] ?? scale).padEnd(18)}${String(key).padStart(3)}` +
          String(c.notes).padStart(9) +
          `${((100 * c.fixedRoot0) / c.notes).toFixed(1)}%`.padStart(20) +
          `${((100 * c.fixedRotated) / c.notes).toFixed(1)}%`.padStart(21),
      );
    }
  }
}
