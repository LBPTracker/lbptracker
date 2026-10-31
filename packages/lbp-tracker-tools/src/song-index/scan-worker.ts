/**
 * One thread of `scan`: resources in, every sequencer's signature out.
 *
 * ❗ **Read through `readThings` and `importLevel`, not `readLevelProject`**,
 * which is the two of them in one: the Things are needed for what the project
 * leaves out — the sequencer's `planGuid` and the creator of the group nearest
 * to it, which is how a song out of the game is told from a player's (`cluster.ts`).
 */

import { open, readFile } from 'node:fs/promises';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { importLevel } from '@lbptracker/cwlib/sequencer/project.ts';
import { readThings } from '@lbptracker/cwlib/things/level.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import type { Thing } from '@lbptracker/cwlib/things/thing.ts';
import { resourcePath } from './db.ts';
import { signature, type Signature } from './signature.ts';

/** The resources a sequencer can be in: a level, a plan, an LBP3 streaming chunk. */
export const SEQUENCER_MAGICS = new Set(['LVLb', 'PLNb', 'CHKb']);

export interface Found extends Signature {
  readonly uid: number;
  readonly name: string;
  readonly author: string;
  readonly tempo: number;
  readonly swing: number;
  readonly lengthSteps: number;
  /** The game item it was placed from (`Thing.planGuid`), 0 for none. */
  readonly planGuid: number;
  /** The group nearest to it is MM_Studio's: it came out of the game. */
  readonly mmGroup: boolean;
}

export interface ResourceResult {
  readonly sha: string;
  magic: string;
  problems: number;
  error: string | null;
  sequencers: Found[];
}

/**
 * Whether the group nearest to a Thing is the game's.
 *
 * `sequencerAuthor` in cwlib skips MM_Studio and climbs to whoever put the
 * sequencer in their level, which is right for a placed popit sequencer and
 * wrong for a song out of the story: there the nearest group is the game's.
 */
function nearestGroupIsGame(thing: Thing | undefined): boolean {
  for (let at = thing, hops = 0; at && hops < 64; at = at.groupHead, hops++) {
    const creator = (at.parts.get('GROUP') as { creator?: string } | undefined)?.creator;
    if (creator) return creator === 'MM_Studio';
  }
  return false;
}

async function read(archive: string, sha: string): Promise<ResourceResult> {
  const result: ResourceResult = { sha, magic: '', problems: 0, error: null, sequencers: [] };
  try {
    const file = resourcePath(archive, sha);
    const handle = await open(file, 'r');
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    await handle.close();
    result.magic = head.toString('latin1');
    if (!SEQUENCER_MAGICS.has(result.magic)) return result;
    const { things, problems, kind } = await readThings(await readFile(file), nodeInflate);
    const project = importLevel(sha, things, kind, problems);
    const byUid = new Map<number, Thing>();
    for (const t of things) if (t) byUid.set(t.uid, t);
    result.problems = project.problems?.length ?? 0;
    result.sequencers = project.sequencers.map((s) => {
      const thing = byUid.get(s.uid);
      return {
        ...signature(s),
        uid: s.uid, name: s.name ?? '', author: s.author ?? '', tempo: s.tempo, swing: s.swing,
        lengthSteps: s.lengthSteps, planGuid: thing?.planGuid ?? 0, mmGroup: nearestGroupIsGame(thing),
      };
    });
  } catch (e) {
    result.error = String(e instanceof Error ? e.message : e).slice(0, 500);
  }
  return result;
}

// Only inside a thread: `scan.ts` imports this file's types on the main one.
if (!isMainThread) {
  const { archive } = workerData as { archive: string };
  parentPort!.on('message', async (shas: string[]) => {
    const out: ResourceResult[] = [];
    for (const sha of shas) out.push(await read(archive, sha));
    parentPort!.postMessage(out);
  });
  parentPort!.postMessage('ready');
}
