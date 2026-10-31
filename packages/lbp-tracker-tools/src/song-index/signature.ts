/**
 * What makes two sequencers the same song: three fingerprints of one, and the
 * comparisons between them.
 *
 * - `contentHash` — the copy exactly: the note records as the file holds them,
 *   each clip's instrument, key, scale and place on the timeline, the tempo and
 *   the swing. Equal hashes are one variant.
 * - `musicHash` — the music that sounds: every note's onset, sounded pitch and
 *   length, whatever plays it and however fast. Equal hashes are one song even
 *   with other instruments, another tempo or the board rearranged.
 * - `minhash` — for "nearly": a MinHash over two families of tokens, the
 *   piano roll (`r<step>:<pitch>`, which survives notes added, removed or
 *   changed) and each clip's own pattern (`c<pattern>#k#i`, which survives clips
 *   moved, reordered or reused), weighted alike.
 *
 * Nothing here reads a file; `scan.ts` hands it cwlib's `Sequencer`.
 */

import { createHash } from 'node:crypto';
import type { Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { blockRoot, notePitch } from '@lbptracker/lib/scale.ts';

export const MINHASH_SIZE = 128;
/**
 * LSH: 42 bands of 3 (126 of the 128). A pair at 0.40 similarity becomes a
 * candidate with p≈0.93, at 0.50 with p≈0.996; with bands of 4 a longer
 * version at 0.41 ("LittleBigMe") was compared only 60% of the time.
 */
export const LSH_ROWS = 3;
export const LSH_BANDS = Math.floor(MINHASH_SIZE / LSH_ROWS);
/** Below this many notes a sequencer is only ever matched exactly: a riff is in every song. */
export const MIN_NOTES = 16;

/** Everything the index keeps about one sequencer's music. */
export interface Signature {
  readonly contentHash: string;
  readonly musicHash: string;
  readonly tracks: number;
  readonly notes: number;
  /** RInstrument GUID → notes it plays. */
  readonly instruments: Record<number, number>;
  /** Little-endian `Uint32Array` bytes; null under `MIN_NOTES`. */
  readonly minhash: Uint8Array | null;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => fmix32(0x9e3779b9 + i * 0x7f4a7c15));

export function minhash(tokens: Iterable<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const token of tokens) {
    const x = fnv1a(token);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const h = fmix32(x ^ SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/** The estimated Jaccard similarity of two MinHash signatures. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

/** The band a signature falls into, as a map key. */
export const bandKey = (sig: Uint32Array, band: number): string =>
  sig.subarray(band * LSH_ROWS, (band + 1) * LSH_ROWS).join(',');

/** Minimum without spread: `Math.min(...a)` overflows the stack on a 16,000-note sequencer. */
function minOf<T>(items: readonly T[], value: (item: T) => number): number {
  let min = Infinity;
  for (const item of items) min = Math.min(min, value(item));
  return items.length ? min : 0;
}

/** The three fingerprints of one sequencer. */
export function signature(seq: Sequencer): Signature {
  const tracks = seq.tracks.filter((t) => t.notes.length > 0);
  const minOffset = minOf(tracks, (t) => t.stepOffset);

  const exact = tracks
    .map((t) => `${t.guid}|${t.key}|${t.scale}|${t.stepOffset - minOffset}|${Buffer.from(t.records).toString('hex')}`)
    .sort();
  const contentHash = sha1(`${seq.tempo}|${seq.swing}\n${exact.join('\n')}`);

  const events: { onset: number; pitch: number; dur: number; track: number }[] = [];
  const instruments: Record<number, number> = {};
  tracks.forEach((t, index) => {
    instruments[t.guid] = (instruments[t.guid] ?? 0) + t.notes.length;
    for (const note of t.notes) {
      events.push({
        onset: t.stepOffset + note.startPosition,
        // The pitch that sounds: snapped to the scale, then moved by the key
        // (steering/sequencer-engine-inputs.md, *Key and Scale*).
        pitch: notePitch(note.points[0].pitch, t.scale, blockRoot(t.key)),
        dur: note.endPosition - note.startPosition,
        track: index,
      });
    }
  });
  const first = minOf(events, (e) => e.onset);
  // Thirds of a step: triplets sit on them.
  const step3 = (v: number) => Math.round(v * 3);
  const musicHash = sha1(events.map((e) => `${step3(e.onset - first)}|${e.pitch}|${step3(e.dur)}`).sort().join(','));

  let sig: Uint8Array | null = null;
  if (events.length >= MIN_NOTES) {
    const tokens = new Set<string>();
    for (const e of events) tokens.add(`r${Math.round(e.onset - first)}:${e.pitch}`);
    const byTrack = new Map<number, typeof events>();
    for (const e of events) {
      const list = byTrack.get(e.track);
      if (list) list.push(e);
      else byTrack.set(e.track, [e]);
    }
    const seen = new Map<number, number>();
    for (const mine of byTrack.values()) {
      const start = minOf(mine, (e) => e.onset);
      const pattern = fnv1a(mine.map((e) => `${step3(e.onset - start)}|${e.pitch}|${step3(e.dur)}`).sort().join(','));
      const k = seen.get(pattern) ?? 0;
      seen.set(pattern, k + 1);
      // As many tokens as the clip has notes, so the two families weigh alike.
      for (let i = 0; i < mine.length; i++) tokens.add(`c${pattern}#${k}#${i}`);
    }
    sig = new Uint8Array(minhash(tokens).buffer);
  }
  return { contentHash, musicHash, tracks: tracks.length, notes: events.length, instruments, minhash: sig };
}

// --- longer and shorter versions -------------------------------------------

/**
 * A longer or shorter version of one song: nearly all of the shorter is inside
 * the longer. Jaccard undersells it ("LittleBigMe" at 6,531 notes inside its
 * 18,920-note version: 0.41); containment does not. The bounds keep a drum
 * riff that is inside a thousand songs from joining them all.
 */
export const CONTAIN_THRESHOLD = 0.8;
export const CONTAIN_MIN_NOTES = 200;
export const CONTAIN_MIN_RATIO = 0.2;

/**
 * How much of the smaller set is inside the other, from the estimated Jaccard
 * and the sizes: |A∩B| = J(|A|+|B|)/(1+J). A sequencer has about two tokens a
 * note, one on the roll and one in its clip, all distinct.
 */
export function containment(jaccard: number, notesA: number, notesB: number): number {
  const a = 2 * notesA;
  const b = 2 * notesB;
  return Math.min(1, (jaccard * (a + b)) / (1 + jaccard) / Math.min(a, b));
}

/**
 * Whether two copies are one music, one longer than the other.
 *
 * ⚠️ **On the cautious estimate**, 1.5 standard errors under the measured
 * Jaccard: with 128 values the error is about 0.03, and at a low Jaccard the
 * containment drawn from it swings by ±0.17. Without that, "KasaanCrew Theme"
 * (0.16) joined "Painted Rain"; "LittleBigMe" (0.41) still comes out at 1.0.
 */
export function isPart(jaccard: number, notesA: number, notesB: number): boolean {
  const small = Math.min(notesA, notesB);
  const big = Math.max(notesA, notesB);
  const low = jaccard - 1.5 * Math.sqrt((jaccard * (1 - jaccard)) / MINHASH_SIZE);
  return small >= CONTAIN_MIN_NOTES && small >= CONTAIN_MIN_RATIO * big && low > 0
    && containment(low, notesA, notesB) >= CONTAIN_THRESHOLD;
}
