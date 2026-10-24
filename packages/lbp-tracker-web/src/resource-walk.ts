/**
 * Fetching a root level and the openable resources it depends on, from any
 * store that serves resources by their SHA-1.
 *
 * Two stores do: the Internet Archive (`lbparchive.ts`) and Bonsai
 * (`bonsai.ts`). The walk is the same over both -- the dependency table names
 * what to ask for and the bytes that come back name what to ask for next -- so
 * it lives here once and each panel hands it a `grab`.
 *
 * ⚠️ **The walk fetches only what can be opened, and the list is measured.** A
 * level's dependency table names its textures, meshes and materials too, and
 * `../cwlib-ts/src/sequencer/backup.ts` would throw every one of them away -- it
 * opens `LVLb`, `PLNb` and `CHKb` and nothing else. So the walk follows exactly
 * the three types that are those: 9, 38 and 61. See `OPENABLE_DEPENDENCIES`.
 *
 * ⚠️ **A missing part is not a failed open.** Only the root is required, and
 * the panel fetches that itself so its failure can say something specific to
 * the store; anything else that will not come is counted and said out loud.
 */

import { HEADER_MIN, OPENABLE_DEPENDENCIES, readDependencies } from '@lbptracker/cwlib/io/resource.ts';
import { looksLikeLevel, type BackupFile } from '@lbptracker/cwlib/sequencer/backup.ts';

/**
 * Whether to walk at all: when the reader asked to, and whenever the root
 * cannot be opened on its own.
 *
 * ⚠️ **The second half is not optional.** An adventure (`ADCb`) has no world
 * of its own: `readBackup` skips it on its magic and its levels are type-9
 * dependencies, so with the box unticked a perfectly good adventure would open
 * nothing whatsoever. Four of twelve "adventure map" hashes taken off the
 * archive's index are `ADCb`, so this is not a corner case.
 */
export const mustWalk = (root: Uint8Array, deep: boolean): boolean => deep || !looksLikeLevel(root);

/** What a walk brought back. */
export interface Walked {
  /** The root first, then every part that came, each named after its SHA-1. */
  readonly files: BackupFile[];
  /** Parts that were asked for and did not come. */
  readonly missing: number;
  /** Parts never asked for, because the walk was stopped or hit its cap. */
  readonly skipped: number;
  /** Why the walk stopped early, when `stop` said so. */
  readonly stopped?: string;
}

/**
 * Thrown by a `grab` to end the walk rather than skip one part: a store that
 * has said "slow down" will say it to every part still in the queue.
 */
export class StopWalk extends Error {}

/**
 * The openable resources this one depends on that have not been asked for yet.
 *
 * A resource whose tail will not parse contributes nothing and is not an
 * error: the level itself is already in hand, and one unreadable dependency
 * table is no reason to refuse the songs that did arrive.
 */
function partsOf(bytes: Uint8Array, seen: Set<string>): string[] {
  const out: string[] = [];
  let deps;
  try {
    deps = readDependencies(bytes);
  } catch {
    return out;
  }
  for (const dep of deps) {
    if (dep.kind !== 'sha1' || seen.has(dep.sha1)) continue;
    if (!OPENABLE_DEPENDENCIES.includes(dep.type)) continue;
    seen.add(dep.sha1);
    out.push(dep.sha1);
  }
  return out;
}

/**
 * Walk from a root already in hand to the parts it depends on.
 *
 * ❗ **The walk continues from what came back** rather than stopping at the
 * root's own list: an adventure names levels, a level names chunks and plans,
 * and a plan can name further plans.
 *
 * `limit` counts the root, so the pile never holds more than `limit` files.
 */
export async function walkParts(opts: {
  root: { readonly sha1: string; readonly bytes: Uint8Array };
  grab: (sha1: string) => Promise<Uint8Array>;
  limit: number;
  atATime: number;
  progress?: (have: number, known: number) => void;
}): Promise<Walked> {
  const { root, grab, limit, atATime, progress } = opts;
  const files: BackupFile[] = [{ name: root.sha1, bytes: root.bytes }];
  const seen = new Set([root.sha1]);
  const queue = partsOf(root.bytes, seen);
  let missing = 0;
  let stopped: string | undefined;
  while (queue.length > 0 && files.length < limit && stopped === undefined) {
    progress?.(files.length, files.length + queue.length);
    const room = limit - files.length;
    const wave = await Promise.all(
      queue.splice(0, Math.min(atATime, room)).map(async (hash) => {
        try {
          return [hash, await grab(hash)] as const;
        } catch (error) {
          if (error instanceof StopWalk) stopped = error.message;
          return [hash, undefined] as const;
        }
      }),
    );
    for (const [hash, bytes] of wave) {
      // ⚠️ **A 200 is not a resource**, from either store. The archive answers
      // a missing entry with a short body, and Bonsai answered `200` with
      // `Content-Length: 0` for all eight plans "Random Music Sequencer
      // Melodies" (#19986) names, whose asset-info route says 404 (measured
      // 2026-10-04; a hash it has never seen gets a real 404). Kept, those
      // read as parts that arrived and held nothing, and the note said the
      // walk was complete.
      if (!bytes || bytes.length < HEADER_MIN) {
        missing += 1;
        continue;
      }
      files.push({ name: hash, bytes });
      queue.push(...partsOf(bytes, seen));
    }
  }
  return { files, missing, skipped: queue.length, stopped };
}

/**
 * One line on what a walk could not bring, or nothing when it brought it all.
 *
 * `where` finishes "3 of its parts are not …": `in the archive`, `on Bonsai`.
 */
export function walkNote(walked: Walked, where: string): string {
  const { missing, skipped, stopped } = walked;
  const parts = (n: number) => `${n} of its parts`;
  if (stopped) return `${stopped}: ${parts(missing + skipped)} did not come`;
  const notes: string[] = [];
  if (missing > 0) notes.push(`${parts(missing)} ${missing === 1 ? 'is' : 'are'} not ${where}`);
  if (skipped > 0) notes.push(`${parts(skipped)} past the cap ${skipped === 1 ? 'was' : 'were'} not fetched`);
  return notes.join('; ');
}
