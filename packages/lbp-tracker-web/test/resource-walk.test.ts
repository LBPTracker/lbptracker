/**
 * The dependency walk both online stores share: `src/resource-walk.ts`.
 *
 * The resources are built here with nothing in them but a magic and a
 * dependency table, which is all the walk reads (the table's layout is pinned
 * in `../cwlib-ts/test/resource.test.ts`); `grab` is a map lookup, so
 * what is tested is what gets asked for, in what order, and what is said about
 * what did not come.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEPENDENCY_CHUNK, DEPENDENCY_LEVEL, DEPENDENCY_PLAN, DEPENDENCY_TEXTURE,
} from '@lbptracker/cwlib/resource.ts';
import { mustWalk, StopWalk, walkNote, walkParts } from '../src/resource-walk.ts';

/** `HEADER_MIN` in `resource.ts`: the shortest header a real resource has. */
const HEAD = 0x16;

/** A resource of this magic whose dependency table names these hashes. */
function resource(magic: string, deps: (readonly [string, number])[] = [], guids = 0): Uint8Array {
  const body: number[] = [];
  const u32 = (n: number) => body.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  u32(deps.length + guids);
  for (const [sha1, type] of deps) {
    body.push(1, ...sha1.match(/../g)!.map((b) => parseInt(b, 16)));
    u32(type);
  }
  for (let i = 0; i < guids; i += 1) {
    body.push(2);
    u32(0x1000 + i);
    u32(DEPENDENCY_TEXTURE);
  }
  const head = new Array(HEAD).fill(0);
  [...magic].forEach((c, i) => (head[i] = c.charCodeAt(0)));
  head[11] = HEAD;
  return new Uint8Array([...head, ...body]);
}

const h = (n: number) => n.toString(16).padStart(40, '0');

/** A store: hash to bytes, and a log of what was asked for. */
function store(entries: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const grab = async (sha1: string) => {
    asked.push(sha1);
    const bytes = entries[sha1];
    if (!bytes) throw new Error('404');
    return bytes;
  };
  return { asked, grab };
}

test('the walk follows levels, plans and chunks, from whatever came back, once each', async () => {
  const root = resource('LVLb', [
    [h(1), DEPENDENCY_PLAN],
    [h(2), DEPENDENCY_TEXTURE], // a user texture: never asked for
    [h(3), DEPENDENCY_CHUNK],
    [h(1), DEPENDENCY_PLAN], // named twice, asked for once
  ], 5);
  const { asked, grab } = store({
    [h(1)]: resource('PLNb', [[h(4), DEPENDENCY_PLAN], [h(0), DEPENDENCY_LEVEL]]),
    [h(3)]: resource('CHKb'),
    [h(4)]: resource('PLNb'),
  });
  const walked = await walkParts({ root: { sha1: h(0), bytes: root }, grab, limit: 100, atATime: 6 });
  assert.deepEqual(asked, [h(1), h(3), h(4)], 'the root itself is never asked for again');
  assert.deepEqual(walked.files.map((f) => f.name), [h(0), h(1), h(3), h(4)]);
  assert.equal(walked.missing, 0);
  assert.equal(walkNote(walked, 'on Bonsai'), '');
});

test('a part that will not come is counted, and the rest still open', async () => {
  const root = resource('LVLb', [[h(1), DEPENDENCY_PLAN], [h(2), DEPENDENCY_PLAN]]);
  const { grab } = store({ [h(2)]: resource('PLNb') });
  const walked = await walkParts({ root: { sha1: h(0), bytes: root }, grab, limit: 100, atATime: 6 });
  assert.deepEqual(walked.files.map((f) => f.name), [h(0), h(2)]);
  assert.equal(walkNote(walked, 'in the archive'), '1 of its parts is not in the archive');
});

// Bonsai answered `200` with an empty body for eight plans it does not hold,
// and the archive answers a missing entry with a short one. Counted as parts
// that came, they made a walk that fetched nothing say it was complete.
test('a body too short to be a resource is a part that did not come', async () => {
  const root = resource('LVLb', [[h(1), DEPENDENCY_PLAN], [h(2), DEPENDENCY_PLAN]]);
  const { grab } = store({ [h(1)]: new Uint8Array(0), [h(2)]: new Uint8Array(12) });
  const walked = await walkParts({ root: { sha1: h(0), bytes: root }, grab, limit: 100, atATime: 6 });
  assert.deepEqual(walked.files.map((f) => f.name), [h(0)]);
  assert.equal(walkNote(walked, 'on Bonsai'), '2 of its parts are not on Bonsai');
});

// The cap counts the root, and what it cut off is said, not swallowed.
test('the cap holds the pile to its size and says how much was left', async () => {
  const deps = Array.from({ length: 9 }, (_, i) => [h(i + 1), DEPENDENCY_PLAN] as const);
  const entries = Object.fromEntries(deps.map(([sha1]) => [sha1, resource('PLNb')]));
  const { asked, grab } = store(entries);
  const walked = await walkParts({ root: { sha1: h(0), bytes: resource('LVLb', deps) }, grab, limit: 5, atATime: 3 });
  assert.equal(walked.files.length, 5);
  assert.equal(asked.length, 4, 'nothing past the cap is even asked for');
  assert.equal(walked.skipped, 5);
  assert.equal(walkNote(walked, 'on Bonsai'), '5 of its parts past the cap were not fetched');
});

// A server that says "slow down" says it to everything still queued; asking
// anyway keeps its block going.
test('a StopWalk ends the walk, and the note says why', async () => {
  const deps = Array.from({ length: 6 }, (_, i) => [h(i + 1), DEPENDENCY_PLAN] as const);
  const asked: string[] = [];
  const grab = async (sha1: string) => {
    asked.push(sha1);
    if (sha1 === h(2)) throw new StopWalk('Bonsai asked to slow down');
    return resource('PLNb');
  };
  const walked = await walkParts({ root: { sha1: h(0), bytes: resource('LVLb', deps) }, grab, limit: 100, atATime: 2 });
  assert.deepEqual(asked, [h(1), h(2)]);
  assert.equal(walked.files.length, 2);
  assert.equal(walked.stopped, 'Bonsai asked to slow down');
  assert.equal(walkNote(walked, 'on Bonsai'), 'Bonsai asked to slow down: 5 of its parts did not come');
});

// An adventure has no world of its own: unwalked, it would open nothing.
test('an adventure is walked whether or not the box is ticked', () => {
  assert.equal(mustWalk(resource('ADCb'), false), true);
  assert.equal(mustWalk(resource('LVLb'), false), false);
  assert.equal(mustWalk(resource('LVLb'), true), true);
});
