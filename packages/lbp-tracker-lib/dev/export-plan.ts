/**
 * Write a `.plan` from a level, a plan, or one of this tracker's song files —
 * and print the two things that decide whether the game will take it.
 *
 * The writing is `@lbptracker/cwlib/sequencer/write-plan.ts`. This is the command-line
 * way in, for handing a file to somebody with a console and asking them to
 * import it:
 *
 * ```
 * node --experimental-strip-types dev/export-plan.ts <in> [out] [--ps4] [--seq <uid|index>]
 * ```
 *
 * `<in>` is anything with a sequencer in it: a `.lbptracker.json` song, an
 * `LVLb` level, a `PLNb` plan, or a `CHKb` chunk. A level with several
 * sequencers writes the first unless `--seq` names one, and lists the rest.
 *
 * ❗ **The two lines to read are `revision` and the dependency table.** The
 * revision has to be the one the target game writes -- PS3 and PS4 differ in
 * the subVersion and each reads only its own -- and every dependency has to be
 * a GUID. A GUID is an asset already in the player's game; a hash would be
 * somebody's own resource, and the plan would arrive with a hole in it.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { readChunk, readLevel, readPlan } from '@lbptracker/cwlib/things/level.ts';
import { partReaders } from '@lbptracker/cwlib/things/parts.ts';
import { nodeDeflate, nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { importLevel, type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { readDependencies } from '@lbptracker/cwlib/io/resource.ts';
import { LBP3_PS3, LBP3_PS4, writeSequencerPlan } from '@lbptracker/cwlib/sequencer/write-plan.ts';
import { sequencerFromSong, songFromJson, looksLikeSongJson } from '../src/song.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const wanted = args.includes('--seq') ? args[args.indexOf('--seq') + 1] : undefined;
const input = positional[0];
if (!input) {
  console.error('usage: export-plan.ts <level|plan|song.json> [out.plan] [--ps4] [--seq <uid>]');
  process.exit(2);
}

const revision = flags.has('--ps4') ? LBP3_PS4 : LBP3_PS3;
const bytes = new Uint8Array(await readFile(input));

/** Every sequencer in the input, whatever kind of file it is. */
async function sequencers(): Promise<Sequencer[]> {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 400));
  if (looksLikeSongJson(text)) {
    return [sequencerFromSong(songFromJson(new TextDecoder().decode(bytes)))];
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const read = magic === 'PLNb' ? readPlan : magic === 'CHKb' ? readChunk : readLevel;
  const kind = magic === 'PLNb' ? 'plan' : magic === 'CHKb' ? 'chunk' : 'level';
  const { things, problems } = await read(bytes, nodeInflate, partReaders());
  for (const problem of problems ?? []) console.error(`  ! ${problem}`);
  return [...importLevel(input, things, kind).sequencers];
}

const found = await sequencers();
if (found.length === 0) {
  console.error(`${input} holds no music sequencer`);
  process.exit(1);
}

const chosen = wanted === undefined
  ? found[0]
  : found.find((s, i) => String(s.uid) === wanted || String(i) === wanted);
if (!chosen) {
  console.error(`no sequencer ${wanted}; this file has ${found.map((s) => s.uid).join(', ')}`);
  process.exit(1);
}
if (found.length > 1) {
  console.log(`${found.length} sequencers in ${input}; writing uid ${chosen.uid}. The others:`);
  for (const other of found) {
    if (other === chosen) continue;
    console.log(`  --seq ${other.uid}  ${other.name || '(unnamed)'} · ${other.tracks.length} chips`);
  }
}

const out = positional[1]
  ?? `${(chosen.name || 'song').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'song'}.plan`;
const plan = await writeSequencerPlan(chosen, nodeDeflate, { revision });
await writeFile(out, plan);

const dependencies = readDependencies(plan);
const notes = chosen.tracks.reduce((sum, t) => sum + t.notes.length, 0);
console.log(`
${out}
  from        ${input}${found.length > 1 ? ` (uid ${chosen.uid})` : ''}
  name        ${chosen.name || '(unnamed)'}
  revision    0x${revision.version.toString(16)} · subVersion 0x${revision.subVersion.toString(16)} ${
  revision === LBP3_PS4 ? '(LBP3 PS4/PS5)' : '(LBP3 PS3, and RPCS3)'}
  tempo       ${chosen.tempo} BPM${chosen.swing ? `, swing ${chosen.swing}` : ''}
  board       ${chosen.tracks.length} chips · ${notes.toLocaleString()} notes · ${
  chosen.numChannels} channel${chosen.numChannels === 1 ? '' : 's'}
  size        ${plan.length.toLocaleString()} bytes
  dependencies ${dependencies.length}${
  dependencies.some((d) => d.kind === 'sha1') ? '  ⚠ SOME ARE HASHES' : '  (all GUIDs)'}`);
for (const dependency of dependencies) {
  console.log(dependency.kind === 'guid'
    ? `    GUID ${String(dependency.guid).padStart(8)}   type ${dependency.type}`
    : `    HASH ${dependency.sha1}   type ${dependency.type}`);
}
