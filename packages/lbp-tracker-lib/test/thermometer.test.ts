import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadResourceFile } from '@lbptracker/cwlib/platform/node.ts';

import { readInstrument, usedSlots } from '@lbptracker/cwlib/rinstrument.ts';
import {
  MAX_SEQUENCER_MEMORY, addedSequencerMemory, overSequencerMemory, sequencerMemory,
} from '../src/thermometer.ts';

const sizes = new Map([[1, 100], [2, 250], [3, 4000]]);
const sizeOf = (guid: number) => sizes.get(guid);

test('a sample is paid for once, however many instruments hold it', () => {
  // v0x1c4720 puts every SampleGuid in one std::set before it sums.
  assert.deepEqual(sequencerMemory([[1, 2], [2, 3], [1, 2]], sizeOf), { bytes: 4350, missing: 0 });
  assert.deepEqual(sequencerMemory([], sizeOf), { bytes: 0, missing: 0 });
});

test('an empty slot is not a sample, and a sample with no row adds nothing', () => {
  assert.deepEqual(sequencerMemory([[1, 0, 0], [9]], sizeOf), { bytes: 100, missing: 1 });
});

test('another instrument costs only the samples it brings', () => {
  assert.equal(addedSequencerMemory([[1, 2]], [2, 3], sizeOf), 4000);
  assert.equal(addedSequencerMemory([[1, 2]], [1, 2], sizeOf), 0, 'a second chip of the same sound is free');
});

test('the limit is the game’s, and only past it is over', () => {
  // `cmp ecx, [rax + 0x248] ; jbe` at v0x74cb7f: equal is still fine.
  assert.equal(MAX_SEQUENCER_MEMORY, 1_000_000);
  assert.equal(overSequencerMemory(1_000_000), false);
  assert.equal(overSequencerMemory(1_000_001), true);
});

// The real instruments come out of the user's own copy of the game through
// tools/ExtractGuid.java and are never committed. Without them this skips.
const RINST = process.env.LBP_RINST ?? 'fixtures/rinst';
const SMP = process.env.LBP_SMP ?? 'fixtures/smp';
const have = existsSync(path.join(RINST, 'manifest.json')) && existsSync(path.join(SMP, 'manifest.json'));

test('the three pianos together cost what one does', { skip: !have }, async () => {
  const rows = JSON.parse(await readFile(path.join(SMP, 'manifest.json'), 'utf8')) as { guid: number; size: number }[];
  const real = new Map(rows.map((r) => [r.guid, r.size]));
  const samples = async (file: string) =>
    usedSlots(readInstrument((await loadResourceFile(path.join(RINST, file))).data)).map((s) => s.guid);
  const piano = await samples('piano.rinst');
  const all = [piano, await samples('honky_tonk_piano.rinst'), await samples('space_piano.rinst')];
  const one = sequencerMemory([piano], (g) => real.get(g));
  assert.deepEqual(one, { bytes: 330_794, missing: 0 });
  assert.deepEqual(sequencerMemory(all, (g) => real.get(g)), one);
});
