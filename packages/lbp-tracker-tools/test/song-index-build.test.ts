/**
 * The song index's builder (`src/song-index/`), on what it does without a
 * network or the archive: cutting resources out of a zip by range, and the
 * fingerprints and the rule that make two copies one song. The cases are the
 * ones that set the rules: LittleBigMe and its longer version join, a
 * low-similarity pair that only looked contained does not.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import {
  batches,
  centralDirectory,
  cut,
  readCentralDirectory,
  readMultipart,
  zipOf,
  type Part,
} from '../src/song-index/zip-ranges.ts';
import { containment, isPart, signature, similarity } from '../src/song-index/signature.ts';

/** A stored zip of the archive's shape: `aa/bb/<sha1>` entries, a plain end record. */
function makeZip(files: Uint8Array[]): { zip: Uint8Array; shas: string[] } {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const shas: string[] = [];
  let offset = 0;
  for (const [i, data] of files.entries()) {
    const sha = createHash('sha1').update(data).digest('hex');
    shas.push(sha);
    const name = Buffer.from(`${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`, 'latin1');
    // An odd local extra field on the second entry, as real zips have: the
    // reader must take the local header's length, not the central one's.
    const extra = Buffer.alloc(i === 1 ? 9 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    chunks.push(local, name, extra, Buffer.from(data));
    offset += local.length + name.length + extra.length + data.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return { zip: Buffer.concat([...chunks, cdBytes, end]), shas };
}

/** What a server answers to the ranges: one part each. */
const serve = (zip: Uint8Array, ranges: readonly (readonly [number, number])[]): Part[] =>
  ranges.map(([a, b]) => [a, zip.subarray(a, Math.min(b, zip.length - 1) + 1)] as const);

test('the central directory places every entry, and a range cuts it back out', () => {
  const files = [new Uint8Array([1, 2, 3]), new Uint8Array(300).fill(7), new Uint8Array([9])];
  const { zip, shas } = makeZip(files);
  const where = centralDirectory(zip.subarray(Math.max(0, zip.length - 65536)));
  const entries = readCentralDirectory(zip.subarray(where.offset, where.offset + where.size));
  assert.deepEqual(entries.map((e) => e.sha1), shas);
  assert.equal(zipOf(shas[0]), shas[0].slice(0, 2));

  const [batch] = batches(entries, 200, 1 << 20);
  assert.equal(batch.ranges.length, 1, 'neighbours closer than the merge gap are one range');
  const parts = serve(zip, batch.ranges);
  for (const [i, entry] of entries.entries()) {
    const data = cut(parts, entry);
    assert.ok(data instanceof Uint8Array, `entry ${i}`);
    assert.deepEqual([...data], [...files[i]]);
  }
});

test('a request holds at most so many ranges, and so many bytes', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ sha1: 'ab'.repeat(20), offset: i * 100_000, size: 1000 }));
  assert.deepEqual(batches(entries, 4, 1 << 30).map((b) => b.entries.length), [4, 4, 2]);
  assert.deepEqual(batches(entries, 100, 2500).map((b) => b.entries.length), [2, 2, 2, 2, 2]);
});

test('an extra field longer than the slack is asked for again, exactly', () => {
  const { zip } = makeZip([new Uint8Array(50).fill(3)]);
  const where = centralDirectory(zip);
  const [entry] = readCentralDirectory(zip.subarray(where.offset, where.offset + where.size));
  // A part that stops right after the header: the data is not in it.
  const short: Part[] = [[entry.offset, zip.subarray(entry.offset, entry.offset + 30 + 46 + 10)]];
  const again = cut(short, entry);
  assert.ok(again && !(again instanceof Uint8Array));
  assert.deepEqual(again.refetch, [entry.offset + 30 + 46, entry.offset + 30 + 46 + 49]);
  assert.equal(cut([[0, new Uint8Array(200)]], entry), undefined, 'no local header there: not the entry');
});

test('a multipart answer is cut by its Content-Range lengths', () => {
  const boundary = '00000000000000782971';
  const part = (start: number, bytes: number[]) => Buffer.concat([
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/zip\r\nContent-Range: bytes ${start}-${start + bytes.length - 1}/999\r\n\r\n`),
    Buffer.from(bytes),
  ]);
  // The data itself may hold CRLFs and dashes: only the lengths can be trusted.
  const body = Buffer.concat([part(10, [13, 10, 13, 10, 45, 45]), part(500, [1, 2, 3]), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const parts = readMultipart(body, boundary);
  assert.deepEqual(parts.map(([s, b]) => [s, [...b]]), [[10, [13, 10, 13, 10, 45, 45]], [500, [1, 2, 3]]]);
});

/** A sequencer just big enough for the fingerprints: notes as [step, pitch, length]. */
function seq(clips: { guid: number; offset: number; key?: number; scale?: number; notes: [number, number, number][] }[], tempo = 120): Sequencer {
  return {
    uid: 1, name: '', author: '', tempo, swing: 0, echoFeedback: 0, echoTime: 0, echoMix: 0, reverb: 0,
    loop: false, startPoint: 0, numChannels: 1, volumes: [1], boardRows: 1, lengthSteps: 0,
    tracks: clips.map((c) => ({
      guid: c.guid, name: '', colour: 0, gridX: 0, gridY: 0, stepOffset: c.offset, level: 1, pan: 0, echoSend: 0,
      reverbSend: 0, key: c.key ?? 0, scale: c.scale ?? 0, trailingRecords: 0,
      records: new Uint8Array(c.notes.flatMap(([s, p]) => [s, p, 0x60, 0])),
      notes: c.notes.map(([s, p, len]) => ({
        points: [{ step: s, subStep: 0, pitch: p, volume: 0x60, timbre: 0, modulation: 0, end: true }],
        startStep: s, endStep: s + len - 1, duration: len, startPosition: s, endPosition: s + len - 1,
        hasPitchAutomation: false, hasVolumeAutomation: false, hasTimbreAutomation: false,
      })),
    })),
  } as unknown as Sequencer;
}

const melody = (n: number, shift = 0): [number, number, number][] =>
  Array.from({ length: n }, (_, i) => [i * 2, 48 + ((i * 7 + shift) % 24), 2]);

test('the same notes are one music, whatever plays them and however fast', () => {
  const a = signature(seq([{ guid: 122737, offset: 0, notes: melody(40) }], 120));
  const b = signature(seq([{ guid: 125100, offset: 64, notes: melody(40) }], 150));
  assert.equal(a.musicHash, b.musicHash);
  assert.notEqual(a.contentHash, b.contentHash);
  assert.equal(a.notes, 40);
  assert.deepEqual(a.instruments, { 122737: 40 });
});

test('the key and the scale change what sounds, so they change the music', () => {
  const plain = signature(seq([{ guid: 1, offset: 0, notes: melody(40) }]));
  const up = signature(seq([{ guid: 1, offset: 0, key: 14, notes: melody(40) }]));
  const major = signature(seq([{ guid: 1, offset: 0, scale: 1, notes: melody(40) }]));
  assert.notEqual(plain.musicHash, up.musicHash, 'a key of D is two semitones up');
  assert.notEqual(plain.musicHash, major.musicHash, 'the major scale snaps the off-scale notes');
  // Key 0 is C, the same as 12: both leave the notes alone.
  assert.equal(plain.musicHash, signature(seq([{ guid: 1, offset: 0, key: 12, notes: melody(40) }])).musicHash);
});

/**
 * Notes cut into clips of eight, as on a real board: a chip spans at most 128
 * steps, so an edit changes one small clip's pattern. (One clip holding every
 * note would lose all its clip tokens to a single changed note.)
 */
const board = (notes: [number, number, number][]) =>
  Array.from({ length: Math.ceil(notes.length / 8) }, (_, c) => {
    const mine = notes.slice(c * 8, c * 8 + 8);
    const offset = mine[0][0];
    return { guid: 1, offset, notes: mine.map(([s, p, l]) => [s - offset, p, l] as [number, number, number]) };
  });

test('a few notes changed is still very similar; another melody is not', () => {
  const a = signature(seq(board(melody(80))));
  const edited = melody(80);
  edited[5] = [10, 30, 2];
  edited[40] = [80, 31, 2];
  const b = signature(seq(board(edited)));
  const other = signature(seq(board(melody(80, 5))));
  const sim = (x: typeof a, y: typeof a) => similarity(new Uint32Array(x.minhash!.buffer), new Uint32Array(y.minhash!.buffer));
  assert.ok(sim(a, b) > 0.8, `edited: ${sim(a, b)}`);
  assert.ok(sim(a, other) < 0.3, `other: ${sim(a, other)}`);
  assert.equal(signature(seq([{ guid: 1, offset: 0, notes: melody(10) }])).minhash, null, 'under 16 notes: exact only');
});

test('a longer version joins its song; a pair that only looks contained does not', () => {
  // LittleBigMe by Velvet--Audio: 6,531 notes inside 18,920, measured Jaccard 0.41.
  assert.ok(containment(0.41, 6531, 18920) >= 0.99);
  assert.equal(isPart(0.41, 6531, 18920), true);
  // KasaanCrew Theme against Painted Rain: 0.16 is inside the error of 128 values.
  assert.equal(isPart(0.16, 1649, 8066), false);
  // Riffs and fragments never join by containment, however contained.
  assert.equal(isPart(0.25, 150, 600), false, 'under 200 notes');
  assert.equal(isPart(0.15, 500, 4000), false, 'under a fifth of the longer');
});
