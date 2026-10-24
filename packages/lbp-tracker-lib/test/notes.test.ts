import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DEFAULT_TIMBRE,
  DEFAULT_VOLUME,
  decodeRecord,
  encodeRecord,
  groupNotes,
  readNotes,
  type NoteRecord,
} from '@lbptracker/cwlib/sequencer/notes.ts';

function rec(
  step: number,
  pitch: number,
  opts: Partial<NoteRecord> = {},
): NoteRecord {
  return {
    step,
    pitch,
    volume: DEFAULT_VOLUME,
    timbre: DEFAULT_TIMBRE,
    modulation: 0,
    subStep: 0,
    end: false,
    ...opts,
  };
}

// ------------------------------------------------------------------ the key

test('Key transposes, and 0 is the untouched default rather than C', async () => {
  const { blockRoot, keyOffset, notePitch } = await import('../src/scale.ts');

  // v0x160806: `lea ecx, [rax + 0xc]` then `cmovae ecx, eax` on `cmp eax, 0xc`.
  assert.equal(blockRoot(0), 12, 'an untouched key becomes C');
  assert.equal(blockRoot(11), 23);
  assert.equal(blockRoot(12), 12, 'a key at or above 12 passes straight through');
  assert.equal(blockRoot(23), 23);

  // ⚠️ The net transposition is `key mod 12` over the whole range the corpus
  // uses, and the two halves of that come from different binaries: the `+ 12`
  // from the eboot, the `- 12` from the DSP at fmodextinput 0x3c4e.
  for (let key = 0; key <= 23; key += 1) {
    assert.equal(keyOffset(key), key % 12, `key ${key}`);
  }

  // 0 must not drop an octave. 125,447 of the corpus's 129,696 placements carry
  // it, so getting this branch wrong transposes almost every level ever made.
  assert.equal(notePitch(60, 0, blockRoot(0)), 60);
  assert.equal(notePitch(60, 0, blockRoot(12)), 60);
  assert.equal(notePitch(60, 0, blockRoot(15)), 63);
  assert.equal(notePitch(60, 0, blockRoot(3)), 63, 'a key below 12 means the same thing');
});

test('the scale snaps before the key transposes, not after', async () => {
  const { blockRoot, notePitch, quantise } = await import('../src/scale.ts');
  // `lea eax, [rax + rcx - 0xc]` takes rax from the call to the quantiser, so
  // the order is fixed by the instruction. Snapping after would put a
  // transposed note back on a root-0 scale degree, which is a different note.
  const scale = 1; // major
  const note = 61; // a black key: the table sends it to 60
  assert.equal(quantise(note, scale), 60);
  assert.equal(notePitch(note, scale, blockRoot(15)), 63, 'snap to 60, then +3');
  // Doing it the other way round would give quantise(61 + 3) = quantise(64) = 64.
  assert.notEqual(quantise(note + 3, scale), 63);
});

test('decodeRecord splits the flag bits off the step and pitch', () => {
  // Byte 3 is 0x40, so bit 30 is set: the sub-step is `1 << 1` = two thirds.
  const r = decodeRecord(new Uint8Array([0x85, 0xa5, 0x60, 0x40]));
  assert.equal(r.step, 5);
  assert.equal(r.subStep, 2);
  assert.equal(r.pitch, 0x25);
  assert.equal(r.end, true);
  assert.equal(r.volume, 0x60);
  assert.equal(r.timbre, 0x40);
});

test('the sub-step is bit 7 shifted by bit 30, and bit 30 is in the fourth byte', () => {
  const sub = (b0: number, b3: number) =>
    decodeRecord(new Uint8Array([b0, 0x00, 0x60, b3])).subStep;
  assert.equal(sub(0x05, 0x00), 0, 'bit 7 clear is on the beat');
  assert.equal(sub(0x05, 0x40), 0, 'bit 30 alone means nothing -- it is only a shift');
  assert.equal(sub(0x85, 0x00), 1, 'bit 7 alone is one third');
  assert.equal(sub(0x85, 0x40), 2, 'bit 7 with bit 30 is two thirds');
  // ⚠️ The first byte's 0x40 is step bit 6, NOT a sub-step bit. 32,515 corpus
  // records use it; masking the step with 0x3f moves every one by 64 steps.
  assert.equal(decodeRecord(new Uint8Array([0x45, 0x00, 0x60, 0x00])).step, 69);
  assert.equal(decodeRecord(new Uint8Array([0x45, 0x00, 0x60, 0x00])).subStep, 0);
});

test('a record round-trips through encode and decode, sub-step included', () => {
  for (const bytes of [[0x05, 0xa5, 0x60, 0x00], [0x85, 0x25, 0x7f, 0x40], [0x45, 0x00, 0x01, 0x4f]]) {
    const source = new Uint8Array(bytes);
    const out = new Uint8Array(4);
    encodeRecord(decodeRecord(source), out);
    assert.deepEqual([...out], bytes);
  }
});

test('volume and timbre are unsigned', () => {
  // The toolkit reads these as signed Java bytes; 0xff must not come back as -1.
  const r = decodeRecord(new Uint8Array([0x00, 0x00, 0xff, 0x80]));
  assert.equal(r.volume, 255);
  assert.equal(r.timbre, 128);
});

test('encodeRecord round-trips every byte value', () => {
  const buf = new Uint8Array(4);
  for (let b0 = 0; b0 < 256; b0 += 1) {
    for (const b1 of [0x00, 0x7f, 0x80, 0xff]) {
      const original = new Uint8Array([b0, b1, 0x5a, 0xa5]);
      encodeRecord(decodeRecord(original), buf);
      assert.deepEqual([...buf], [...original]);
    }
  }
});

test('duration is the span between first and last record, not the record count', () => {
  // Two control points eight steps apart: an eighth-note-grid whole note.
  const { notes, trailing } = groupNotes([
    rec(0, 60),
    rec(7, 60, { end: true }),
  ]);
  assert.equal(trailing.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].points.length, 2);
  assert.equal(notes[0].duration, 8);
  assert.equal(notes[0].startStep, 0);
  assert.equal(notes[0].endStep, 7);
});

test('a single-record note lasts one step', () => {
  const { notes } = groupNotes([rec(3, 60, { end: true })]);
  assert.equal(notes[0].duration, 1);
});

test('out-of-order points are sorted before the span is taken', () => {
  // ~81 notes in 1.6 million real ones store their points reversed. Without the
  // sort this note reports a duration of -3.
  const { notes } = groupNotes([rec(7, 60), rec(4, 60, { end: true })]);
  assert.equal(notes[0].startStep, 4);
  assert.equal(notes[0].endStep, 7);
  assert.equal(notes[0].duration, 4);
});

test('automation flags follow what varies along the chain', () => {
  const glide = groupNotes([rec(0, 60), rec(2, 64, { end: true })]).notes[0];
  assert.equal(glide.hasPitchAutomation, true);
  assert.equal(glide.hasVolumeAutomation, false);

  const swell = groupNotes([
    rec(0, 60),
    rec(2, 60, { volume: 100, end: true }),
  ]).notes[0];
  assert.equal(swell.hasPitchAutomation, false);
  assert.equal(swell.hasVolumeAutomation, true);

  const plain = groupNotes([rec(0, 60), rec(2, 60, { end: true })]).notes[0];
  assert.equal(plain.hasPitchAutomation, false);
  assert.equal(plain.hasVolumeAutomation, false);
  assert.equal(plain.hasTimbreAutomation, false);
});

test('records after the last end flag are reported, not silently dropped', () => {
  const { notes, trailing } = groupNotes([
    rec(0, 60, { end: true }),
    rec(1, 61),
  ]);
  assert.equal(notes.length, 1);
  assert.equal(trailing.length, 1);
});

test('readNotes rejects a byte length that is not a multiple of 4', () => {
  assert.throws(() => readNotes(new Uint8Array(6)), RangeError);
});

test('readNotes decodes a real clip from the corpus', () => {
  // First instrument of "Levity - Festerd_Jester", a harp at tempo 130.
  const hex =
    '0025604001a56040042f604005af6040082c604009ac60400c2560400da56040' +
    '102f604011af6040142c604015ac60401823604019a360401c2f60401daf6040';
  const bytes = Uint8Array.from(
    hex.match(/../g)!.map((h) => Number.parseInt(h, 16)),
  );
  const { notes, trailing } = readNotes(bytes);
  assert.equal(trailing.length, 0);
  assert.equal(notes.length, 8);
  // Every note is two points one step apart, one note every four steps.
  for (const note of notes) {
    assert.equal(note.duration, 2);
    assert.equal(note.points.length, 2);
    assert.equal(note.hasPitchAutomation, false);
  }
  assert.deepEqual(
    notes.map((n) => n.startStep),
    [0, 4, 8, 12, 16, 20, 24, 28],
  );
  assert.deepEqual(
    notes.map((n) => n.points[0].pitch),
    [0x25, 0x2f, 0x2c, 0x25, 0x2f, 0x2c, 0x23, 0x2f],
  );
});

test('the modulation is the low nibble of the fourth byte, over 15', () => {
  const mod = (b3: number) => decodeRecord(new Uint8Array([0x04, 0x00, 0x60, b3])).modulation;
  assert.equal(mod(0x00), 0);
  assert.equal(mod(0x0f), 1);
  assert.equal(mod(0x40), 0, 'bit 30 is not part of the modulation');
  assert.equal(mod(0x4f), 1, 'nor does it disturb a full one');
  assert.ok(Math.abs(mod(0x09) - 9 / 15) < 1e-12);
  // ⚠️ Bits 28..29 select a per-block table and must not leak in either.
  assert.equal(mod(0x30), 0);
});

// ------------------------------------------------ creator-authored names

test('the editor’s XML escaping is undone in names', async () => {
  const { decodeEntities } = await import('@lbptracker/cwlib/things/parts.ts');

  // The only two the corpus actually contains: &apos; 46 times across the
  // sequencer names and 416 across the instrument names, &amp; 7 times.
  assert.equal(decodeEntities('&apos;Sands of the Cosmos&apos;'), "'Sands of the Cosmos'");
  assert.equal(
    decodeEntities('Voltaic - Festerd_Jester &amp; iChaosClay'),
    'Voltaic - Festerd_Jester & iChaosClay',
  );
  assert.equal(decodeEntities('Don&apos;t Touch the Monocle'), "Don't Touch the Monocle");

  // The rest of the XML five, and both numeric forms.
  assert.equal(decodeEntities('&lt;a&gt; &quot;b&quot;'), '<a> "b"');
  assert.equal(decodeEntities('&#39;&#x27;'), "''");

  // ⚠️ One pass, not five. Replacing &amp; and then &apos; would turn a literal
  // `&amp;apos;` into an apostrophe -- the classic double-unescape.
  assert.equal(decodeEntities('&amp;apos;'), '&apos;');

  // Anything not in the XML five is left exactly as found: the game escapes for
  // XML, so decoding HTML names would be a guess.
  assert.equal(decodeEntities('a &nbsp; b'), 'a &nbsp; b');
  assert.equal(decodeEntities('R&D &; &#; &#xzz;'), 'R&D &; &#; &#xzz;');
  // A lone surrogate and an out-of-range code point stay visible rather than
  // throwing or becoming a replacement character.
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;');

  assert.equal(decodeEntities('nothing to do'), 'nothing to do');
});
