/**
 * The song index's reader and search, on rows written the way the export
 * writes them (`song-index.ts` has the format). The real index, when this
 * checkout has one under `fixtures/songindex`, is read too: its list must turn
 * into rows and its first song's detail must give targets the archive can open.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  credited,
  creditOf,
  detailFrom,
  fold,
  makerOf,
  openTarget,
  rowsFrom,
  searchSongs,
  shardFile,
  type SongColumns,
  type SongFilter,
} from '../src/song-index.ts';

const COLS: SongColumns = {
  id: [80, 1, 7, 9],
  name: ['Inner Space', 'LMFAO - Party Rock Anthem', '', 'Pokémon Theme'],
  author: ['Festerd_Jester', 'moyron', '', 'ashketchum'],
  variants: [4, 44, 1, 2],
  levels: [97, 1211, 3, 10],
  plays: [1138738, 10496958, 300, 5000],
  year: [2011, 2011, 0, 2013],
  tempo: [140, 130, 120, 100],
  notes: [6212, 6960, 20, 400],
  origin: ["FJ's Jukebox. 20 Original songs :)", 'PARTY ROCK ANTHEM! - by MOYRON (ORIGINAL)', '', ''],
  originAuthor: ['FJMusic', 'moyron', '', ''],
  alt: ['Festerd_Jester - "Inner Space" / INNER-SPACE', '', '', ''],
  game: [0, 0, 0, 1],
};
const ROWS = rowsFrom(COLS);
const ALL: SongFilter = { query: '', sort: 'levels', descending: true, minVariants: 0, minLevels: 0, year: 0 };
const ids = (filter: Partial<SongFilter>) => searchSongs(ROWS, { ...ALL, ...filter }).map((r) => r.id);

test('columns become rows, field by field', () => {
  assert.equal(ROWS.length, 4);
  assert.deepEqual(ROWS[0], {
    id: 80, name: 'Inner Space', author: 'Festerd_Jester', variants: 4, levels: 97, plays: 1138738,
    year: 2011, tempo: 140, notes: 6212, origin: "FJ's Jukebox. 20 Original songs :)",
    originAuthor: 'FJMusic', alt: 'Festerd_Jester - "Inner Space" / INNER-SPACE', game: false,
  });
});

test('a song out of the game is shown as the game, and format 2 has none', () => {
  assert.equal(makerOf(ROWS[3]), 'LittleBigPlanet (the game)');
  assert.equal(makerOf(ROWS[0]), 'Festerd_Jester');
  assert.equal(makerOf(ROWS[2]), 'unknown');
  const { game: _, ...format2 } = COLS;
  assert.ok(rowsFrom(format2).every((r) => r.game === false));
});

test('every word has to match, anywhere in the row', () => {
  assert.deepEqual(ids({ query: 'inner space' }), [80]);
  assert.deepEqual(ids({ query: 'inner festerd' }), [80], 'name and author together');
  assert.deepEqual(ids({ query: 'fjmusic' }), [80], "the origin level's creator");
  assert.deepEqual(ids({ query: 'inner-space' }), [80], 'a name only a copy carries');
  assert.deepEqual(ids({ query: 'inner moyron' }), [], 'all words, not any');
  assert.deepEqual(ids({ query: '  PARTY   rock ' }), [1], 'case and spaces');
  assert.deepEqual(ids({ query: 'pokemon' }), [9], 'accents folded');
  assert.deepEqual(ids({ query: 'pace' }), [], 'a word has to START a word: not "Space"');
  assert.deepEqual(ids({ query: 'rock anth' }), [1], 'but it may stop short of its end');
  assert.equal(fold('Pokémon'), 'pokemon');
});

test('filters and sorts', () => {
  assert.deepEqual(ids({}), [1, 80, 9, 7], 'most levels first');
  assert.deepEqual(ids({ descending: false }), [7, 9, 80, 1]);
  assert.deepEqual(ids({ minVariants: 2 }), [1, 80, 9]);
  assert.deepEqual(ids({ minLevels: 50 }), [1, 80]);
  assert.deepEqual(ids({ year: 2013 }), [9]);
  assert.deepEqual(ids({ sort: 'plays' }), [1, 80, 9, 7]);
  // An unknown year goes last whichever way, and so does a song with no name;
  // within a year, the song in more levels comes first.
  assert.deepEqual(ids({ sort: 'year', descending: false }), [1, 80, 9, 7]);
  assert.deepEqual(ids({ sort: 'year' }), [9, 1, 80, 7]);
  assert.deepEqual(ids({ sort: 'name', descending: false }), [80, 1, 9, 7]);
  assert.deepEqual(ids({ sort: 'name' }), [9, 1, 80, 7]);
});

test('a detail entry, with and without something to open', () => {
  const sha = '7f8dbff3db595f90bab24935e8c4dc5a7dc57d9e';
  const detail = detailFrom({
    o: 32377169,
    v: [
      [1, 140, 6212, 91, 2011, sha, 189814, 'Inner Space', 'SonicBoomXD', 'center'],
      [null, 120, 10, 0, 2012, null, null, 'Short one', '', 'same_music'],
      [0.41, 125, 18920, 4, 2013, sha, 296818, 'Velvet--Audio - LittleBigMe', 'Velvet--Audio', 'extended'],
    ],
    a: [['Festerd_Jester', 40, 32, 1302980276841, 1], ['SonicBoomXD', 65, 60, 1319962308952, 0]],
    l: [
      [32377169, "FJ's Jukebox. 20 Original songs :)", 'FJMusic', 3068, 1, 1371608899539, sha, 32211],
      [11727985, 'PONG Reloaded', 'ScorpSkull', 194528, 1, 1388187805017, 'not a hash', 1],
    ],
  });
  assert.deepEqual(detail.variants[0].target, { sha1: sha, uid: 189814 });
  assert.equal(detail.variants[0].name, 'Inner Space');
  assert.equal(detail.variants[1].target, undefined, 'null, null is no copy to open');
  assert.equal(detail.variants[1].name, 'Short one', 'and the names stay where they are');
  assert.equal(detail.variants[1].similarity, null);
  assert.deepEqual(detail.variants.map((v) => v.relation), ['center', 'same_music', 'extended']);
  assert.deepEqual(detail.authors.map((a) => [a.author, a.candidate]), [['Festerd_Jester', true], ['SonicBoomXD', false]]);
  assert.equal(detail.levels[0].origin, true);
  assert.equal(detail.levels[1].origin, false);
  assert.equal(detail.levels[1].target, undefined, 'a hash that is not one is not opened');
  assert.deepEqual(openTarget(detail), { target: { sha1: sha, uid: 32211 }, original: true },
    'the origin level first, though the main variant is elsewhere');
  const unopenable = { ...detail, levels: [{ ...detail.levels[0], target: undefined }, detail.levels[1]] };
  assert.deepEqual(openTarget(unopenable), { target: { sha1: sha, uid: 189814 }, original: false },
    'then the main variant');
  assert.equal(openTarget({ ...unopenable, variants: [detail.variants[1]] }), undefined);
  assert.equal(shardFile(80, 256), 'song/080.json');
  assert.equal(shardFile(33141, 256), 'song/117.json');
});

test('the real index, when this checkout has one', async (t) => {
  const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'fixtures', 'songindex');
  let head: { version: string; shards: number; songs: number };
  try {
    head = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
  } catch {
    t.skip('no fixtures/songindex here');
    return;
  }
  const rows = rowsFrom(JSON.parse(await readFile(path.join(root, head.version, 'songs.json'), 'utf8')));
  assert.equal(rows.length, head.songs);
  const first = rows[0];
  const shard = JSON.parse(await readFile(path.join(root, head.version, shardFile(first.id, head.shards)), 'utf8'));
  const detail = detailFrom(shard[first.id]);
  assert.ok(detail.variants.length >= 1);
  assert.ok(detail.variants.some((v) => v.target), 'something to open');
  assert.ok(detail.levels.every((l) => l.target === undefined || /^[0-9a-f]{40}$/.test(l.target.sha1)));

  // "Haze - Velvet--Audio": the main variant's copy is in "LittleBigCity 2",
  // and open has to go to the gallery it came from.
  const haze = rows.find((r) => r.name === 'Haze - Velvet--Audio' && r.author === 'Velvet--Audio');
  if (haze) {
    const entry = detailFrom(JSON.parse(await readFile(path.join(root, head.version, shardFile(haze.id, head.shards)), 'utf8'))[haze.id]);
    const origin = entry.levels.find((l) => l.origin);
    assert.equal(origin?.name, "Velvet--Audio's Music Gallery (V.2)");
    assert.deepEqual(openTarget(entry), { target: origin.target, original: true });
  }
});

test("the index's maker fills in only where the level names nobody", () => {
  const sha1 = 'ad4f399cf2952d49878d56940e3c76cdc2ed0199';
  const credit = creditOf(ROWS[0], { sha1, uid: 27943 });
  assert.deepEqual(credit, { sha1, uid: 27943, author: 'Festerd_Jester' });
  assert.equal(creditOf(ROWS[3], { sha1, uid: 1 }), undefined, 'a song out of the game names no person');
  assert.equal(creditOf(ROWS[2], { sha1, uid: 1 }), undefined, 'nor does one with no maker');
  assert.equal(creditOf({ ...ROWS[0], author: 'Velvet--Audio!' }, { sha1, uid: 1 })?.author, 'Velvet--Audio',
    'only what a handle can hold');

  const haze = { uid: 27943, author: '' };
  assert.equal(credited(haze, sha1, credit).author, 'Festerd_Jester');
  assert.equal(credited({ uid: 27187, author: '' }, sha1, credit).author, '', 'another sequencer of the level');
  assert.equal(credited(haze, 'f'.repeat(40), credit).author, '', 'the same uid in a plan the walk fetched');
  assert.equal(credited({ uid: 27943, author: 'sethe99' }, sha1, credit).author, 'sethe99', 'never over a name the file carries');
  assert.equal(credited(haze, sha1, undefined), haze);
});
