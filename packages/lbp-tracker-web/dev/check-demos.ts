/**
 * The check on `src/demo-songs.ts`: every demo is fetched from the archive the
 * way the page fetches it, and the uid it names has to be a sequencer in there.
 *
 *   node packages/lbp-tracker-web/dev/check-demos.ts            the list in src/demo-songs.ts
 *   node packages/lbp-tracker-web/dev/check-demos.ts <sha1> ... every sequencer of those levels
 *
 * ⚠️ Network, and other people's levels: a dev tool, never a test.
 */
import { readBackup, sequencersOf } from '@lbptracker/cwlib/sequencer/backup.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';

import { DEMO_SONGS } from '../src/demo-songs.ts';
import { rootLevelUrl } from '../src/lbparchive.ts';

const levels = new Map<string, Awaited<ReturnType<typeof readBackup>>>();
async function level(sha1: string) {
  let got = levels.get(sha1);
  if (!got) {
    const answer = await fetch(rootLevelUrl(sha1));
    if (!answer.ok) throw new Error(`${answer.status} for ${sha1}`);
    got = await readBackup([{ name: sha1, bytes: new Uint8Array(await answer.arrayBuffer()) }], nodeInflate);
    levels.set(sha1, got);
  }
  return got;
}

const asked = process.argv.slice(2);
if (asked.length > 0) {
  for (const sha1 of asked) {
    const result = await level(sha1);
    for (const p of result.projects) for (const s of p.sequencers) {
      console.log(`${sha1} #${s.uid}  ${s.tracks.length} chips  "${s.name}"  by ${s.author || '?'}`);
    }
  }
} else {
  let bad = 0;
  for (const demo of DEMO_SONGS) {
    try {
      const result = await level(demo.level);
      const row = sequencersOf(result).find((r) => r.uid === demo.uid);
      const seq = result.projects.flatMap((p) => p.sequencers).find((s) => s.uid === demo.uid);
      if (!row || !seq) { bad += 1; console.log(`✖ ${demo.level} #${demo.uid}  no such sequencer`); continue; }
      console.log(`✔ ${demo.level.slice(0, 8)} #${demo.uid}  ${seq.tracks.length} chips  "${seq.name}"  by ${seq.author || '?'}`);
    } catch (error) {
      bad += 1;
      console.log(`✖ ${demo.level} #${demo.uid}  ${(error as Error).message}`);
    }
  }
  console.log(`${DEMO_SONGS.length - bad} of ${DEMO_SONGS.length} demos open`);
  process.exitCode = bad > 0 ? 1 : 0;
}
