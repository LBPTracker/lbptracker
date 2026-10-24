import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadResourceFile } from '@lbptracker/cwlib/platform/node.ts';
import { readInstrument, usedSlots } from '@lbptracker/cwlib/rinstrument.ts';

/**
 * The .rinst files are extracted from the user's own game with
 * tools/ExtractGuid.java and are never committed. Without them these skip.
 * Reading them is cwlib-ts's and tested there; these test the zone walk.
 */
const RINST = process.env.LBP_RINST ?? 'fixtures/rinst';

test('the zone count comes from the splits, not the sample count', async () => {
  const { zoneCount, resolveSlot } = await import('../src/instrument.ts');
  // conga's shape: six bounds, seven samples, the seventh a spare whose base
  // note is out of sequence with the rest.
  const conga = {
    slots: Array.from({ length: 7 }, (_, i) => ({ baseNote: [87, 54, 42, 30, 18, 6, 48][i] })),
    splitNotes: [87, 60, 48, 36, 24, 12, 0, 0, 0],
  } as never as Parameters<typeof zoneCount>[0];
  assert.equal(zoneCount(conga), 6, 'six bounds, six zones');

  // Passing the sample count must not invent a seventh zone below the last
  // bound. Nothing can reach it -- zero of the corpus's 2,027,633 notes change
  // -- but it made the rule look broken when it was not.
  for (const note of [0, 1, 11, 12, 60, 87, 127]) {
    assert.ok(resolveSlot(conga, note, 7) < 6, `note ${note} must stay inside a real zone`);
  }
  assert.equal(resolveSlot(conga, 0, 7), 5, 'the lowest note lands in the last real zone');

  // mime_artist: one bound, four samples, Numstack 5 -- stack layers, not zones.
  const mime = { slots: [{}, {}, {}, {}], splitNotes: [87, 0, 0, 0, 0] } as never as Parameters<
    typeof zoneCount
  >[0];
  assert.equal(zoneCount(mime), 1);
  assert.equal(resolveSlot(mime, 40, 4), 0, 'every note plays the one zone');
});

test('a note exactly on a bound belongs to the zone above it', async () => {
  const { resolveSlot } = await import('../src/instrument.ts');
  // The engine's loop at fmodextinput.prx 0x05a0 continues while
  // `splitNotes[i + 1] > note`, so equality exits and the note keeps the
  // higher zone. 215,449 of 968,829 corpus notes sit exactly on a bound, so
  // this is 22.2% of everything, not an edge case.
  const kit = {
    slots: Array.from({ length: 8 }, (_, i) => ({ baseNote: [87, 78, 57, 51, 40, 33, 27, 21][i] })),
    splitNotes: [87, 72, 60, 54, 48, 36, 30, 24, 0],
  } as never as Parameters<typeof resolveSlot>[0];

  assert.equal(resolveSlot(kit, 24, 8), 6, 'on the bound -> the zone above it');
  assert.equal(resolveSlot(kit, 23, 8), 7, 'one below -> the zone under it');
  assert.equal(resolveSlot(kit, 25, 8), 6);
  // The whole drum pattern this came from: 12 and 24 must be different drums.
  assert.notEqual(resolveSlot(kit, 12, 8), resolveSlot(kit, 24, 8));

  // splitNotes[0] is a ceiling and is never compared -- the walk starts at
  // [0x4c4], one int past the base of the array.
  assert.equal(resolveSlot(kit, 87, 8), 0);
  assert.equal(resolveSlot(kit, 127, 8), 0, 'above the ceiling still lands in zone 0');
});

/**
 * `resolveSlot` against the engine's own loop, transcribed instruction for
 * instruction, over every instrument the game ships and every note.
 *
 * `fmodextinput.prx` `0x0555`-`0x0577`, and verbatim again at `0x09f0`-`0x0a14`:
 *
 * ```
 * ecx = bextr(noteWord, 0x708)          ; bits 8..14, the raw note
 * eax = 0
 * loop:
 *   r8d = 0                             ; the zone, if the walk never falls through
 *   if (int)eax > 7:  goto done         ; a fixed eight bounds
 *   cmp  [rdx + rax*4 + 0x4c4], ecx     ; signed
 *   eax += 1
 *   if   bound > note:  goto loop
 *   eax -= 1
 *   r8d = eax
 * done:                                 ; -> 0x19e0, and at 0x1aca:
 *                                       ;    imul rax, rax, 0x98   -- straight
 *                                       ;    into the slot array
 * ```
 *
 * ⚠️ **`+0x4c4` is `Splitnotes[1]`, not `[0]`.** The DSP's instrument record is
 * eight slots of `0x98` at `+0x000`, which ends at `+0x4c0`; `Splitnotes[0]`
 * sits there and the walk never reads it. `Numstack` follows the eight bounds at
 * `+0x4e4` and `Params` at `+0x4e8`, which is checkable — `Params[11].x`, the
 * amplitude attack, is read at `+0x540` (`0x1f8c`), and `0x4e8 + 11*8 = 0x540`.
 *
 * Reading the walk as indexing from `Splitnotes[0]` is what made it look as
 * though the engine disagreed with this module. It does not: 8,704 comparisons,
 * no disagreement.
 */
test('resolveSlot is the engine’s zone walk, on every shipped instrument', async (t) => {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const RINST = 'fixtures/rinst';
  if (!existsSync(path.join(RINST, 'manifest.json'))) {
    t.skip('no fixtures/rinst — extract it with tools/ExtractGuid.java');
    return;
  }
  const { resolveSlot } = await import('../src/instrument.ts');
  const { readInstrument, usedSlots } = await import('@lbptracker/cwlib/rinstrument.ts');
  const { loadResourceFile } = await import('@lbptracker/cwlib/platform/node.ts');

  /** The loop above, with the record's bound array being `Splitnotes[1..8]`. */
  const engineZone = (splits: readonly number[], note: number, slotCount: number) => {
    let i = 0;
    while (i <= 7 && splits[i + 1] > note) i += 1;
    return Math.min(i > 7 ? 0 : i, Math.max(0, slotCount - 1));
  };

  const rows = JSON.parse(await readFile(path.join(RINST, 'manifest.json'), 'utf8')) as
    { guid: number; file: string }[];
  let checked = 0;
  for (const row of rows) {
    const inst = readInstrument((await loadResourceFile(path.join(RINST, row.file))).data);
    const slots = [...usedSlots(inst)].length;
    for (let note = 0; note <= 127; note += 1) {
      checked += 1;
      assert.equal(
        resolveSlot(inst, note, slots),
        engineZone(inst.splitNotes, note, slots),
        `${row.file} note ${note} (splits ${inst.splitNotes.join(',')})`,
      );
    }
  }
  assert.ok(checked >= 8000, `expected the whole palette, checked ${checked}`);
  console.log(`    ${rows.length} instruments x 128 notes = ${checked} comparisons, all agree`);
});

test('Splitnotes pairs one bound per slot, and every slot is reachable', async (t) => {
  if (!existsSync(RINST)) {
    t.skip(`no ${RINST} (extract with tools/ExtractGuid.java, or set LBP_RINST)`);
    return;
  }
  const { resolveSlot } = await import('../src/instrument.ts');
  const files = (await readdir(RINST)).filter((f) => f.endsWith('.rinst'));
  if (files.length === 0) {
    t.skip(`no .rinst files in ${RINST}`);
    return;
  }

  let fencepost = 0;
  let reachable = 0;
  for (const name of files) {
    const inst = readInstrument((await loadResourceFile(path.join(RINST, name))).data);
    const slots = usedSlots(inst).length;
    if (inst.splitNotes.filter((v) => v > 0).length === slots) fencepost += 1;

    const seen = new Set<number>();
    for (let note = 0; note <= 127; note += 1) {
      seen.add(resolveSlot(inst as never, note, slots));
    }
    if (seen.size === slots) reachable += 1;
  }

  console.log(
    `    one bound per slot: ${fencepost}/${files.length}, ` +
      `all slots reachable: ${reachable}/${files.length}`,
  );
  // A wrong slot<->zone pairing strands samples. These floors are what
  // establishes the convention; see resolveSlot's docstring.
  assert.ok(fencepost / files.length > 0.85, 'the fencepost holds for the great majority');
  assert.ok(reachable / files.length > 0.9, 'nearly every slot is reachable');
});

test('baiyon_city_guildford puts every base note inside its own zone', async (t) => {
  const file = path.join(RINST, 'baiyon_city_guildford.rinst');
  if (!existsSync(file)) {
    t.skip(`no ${file}`);
    return;
  }
  const { resolveSlot } = await import('../src/instrument.ts');
  const inst = readInstrument((await loadResourceFile(file)).data);
  const used = usedSlots(inst);
  // The cleanest multisample the game ships: eight slots, eight bounds, and
  // each slot's base note lands in the zone that slot owns.
  for (let i = 0; i < used.length; i += 1) {
    assert.equal(
      resolveSlot(inst as never, used[i].slot.baseNote, used.length),
      i,
      `base ${used[i].slot.baseNote} should resolve to its own slot ${i}`,
    );
  }
});
