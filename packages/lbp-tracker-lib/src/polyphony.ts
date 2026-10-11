/**
 * The engine's voice pool, and what happens when it runs out.
 *
 * The synthesiser has **32 voices and no more**: the DSP state reserves
 * `+0x0028`…`+0x1a27` for 32 records of `0xd0` = 208 bytes, which is most of
 * its 6,992 bytes. A player without that cap is not merely more permissive, it
 * is louder in exactly the places a composition is densest -- which is where a
 * listener notices it.
 *
 * The allocator is `fmodextinput.prx` `0x1640`-`0x1692`:
 *
 * ```
 * xmm0 = 1.0                       ; best score so far
 * ecx = 0                          ; index      edx = 0   ; best index
 * loop:
 *   cmp byte [rax], 0xff
 *   je  return                     ; a free record wins immediately
 *   xmm1 = [rax + 4] * [rax + 0xc] ; this voice's score
 *   cmovb edx, ecx                 ; remember it if it is the lowest so far
 *   xmm0 = min(xmm1, xmm0)
 *   rax += 0xd0 ; inc ecx ; cmp ecx, 0x20 ; jl loop
 * return rsi + edx * 0xd0          ; else the quietest voice
 * ```
 *
 * So: **take the first free voice; when none is free, steal the quietest.**
 *
 * The score is the product of two voice fields, both rewritten at every walk
 * -- once per step -- by `0x3930`: `+0x04` is the mixer channel's volume times
 * the clip's `Level` (`0x3afc`-`0x3b12`) and `+0x0c` is the **current control
 * point's** velocity over 127 (`0x3c29`-`0x3c3a`), caught up along the volume
 * slide (`0x3edd`-`0x3ee5`). **Neither the instrument's `Params[24]` nor the
 * amplitude envelope is in it** -- the engine ranks by what the note asked
 * for, not by how loud it currently happens to be. But it ranks by what the
 * note asks for NOW: a note whose volume automation falls becomes the cheaper
 * victim as it falls. `PooledNote.walks` carries that, `walkVelocities` reads
 * it off the note's records, and both allocators ask `scoreAt`.
 *
 * ⚠️ The initial best is **1.0**, not infinity, and the initial best index is
 * **0**. A pool in which every voice scores 1.0 or more therefore loses voice
 * 0 rather than the quietest, and that is reproduced here rather than tidied
 * away.
 */

export const VOICE_POOL_SIZE = 32;

/**
 * Pass this as the pool size to turn the cap off.
 *
 * 📝 **This belongs in the UI.** The cap is the engine's and is on by default,
 * because a faithful tracker reproduces it -- but it is also the single most
 * audible "why does my project sound different here" setting there is, and a
 * composer who has written past 32 voices will want to hear both. Expose it as
 * a voice-limit control (a number, not a checkbox: 32 is the game's, and
 * letting someone try 16 or 64 costs nothing) with the game's value as the
 * default and a note that raising it is no longer faithful.
 */
export const VOICES_UNLIMITED = Infinity;

/** Just enough of a note for the allocator to rank and place it. */
export interface PooledNote {
  /** When it starts, in whatever unit the caller uses consistently. */
  readonly start: number;
  /** When it would end if it ran to completion. */
  readonly end: number;
  /**
   * `voice[+0x04] * voice[+0x0c]`: the channel volume times the note volume,
   * as the record is claimed -- the note's first control point. Not the
   * instrument level, and not the envelope.
   */
  readonly score: number;
  /**
   * The same product after each walk the note sees once it holds a record.
   * Unset, `score` holds for the note's whole life.
   */
  readonly walks?: PoolWalks;
  /**
   * Order among notes with the same `start`, lowest first; the input order
   * breaks what this leaves tied. On the engine's clock the walk spawns a
   * step's notes clip by clip from the LAST header to the first (`0x0300`
   * counts down) and record by record inside each, so the render ranks them
   * that way. Unset, 0.
   */
  readonly rank?: number;
}

/**
 * A note's score walk by walk: `scores[k]` from the walk at `from + k` on.
 *
 * The walks are one unit apart -- a step, the unit `0x3930` runs on -- and
 * `from` is the first after the claim. The last entry is the walk that
 * closes the note's gate, and it holds from there on: a closed gate skips
 * the update (`0x395f` → `0x3f06`), so a releasing voice keeps the score it
 * had when its note ended.
 */
export interface PoolWalks {
  readonly from: number;
  readonly scores: readonly number[];
}

/**
 * Positions in the caller's unit are sums and differences of thirds and of a
 * render offset that need not be one, so a walk and a note starting on it can
 * come out an ulp apart. The two are a third of a step apart at the nearest.
 */
const WALK_EPSILON = 1e-6;

/**
 * What a held note scores when a note starting at `at` asks for a record.
 *
 * ❗ **The walk at `at` has already run.** `0xa90` calls `0x3930` on every
 * record (`0x0eef`) and only then `0x280`, which spawns the step's notes and
 * calls the allocator (`0x04ef`), so a note on a step meets the scores that
 * step's walk wrote.
 */
export function scoreAt(note: PooledNote, at: number): number {
  const walks = note.walks;
  if (walks === undefined || walks.scores.length === 0) return note.score;
  const k = Math.floor(at - walks.from + WALK_EPSILON);
  if (k < 0) return note.score;
  return walks.scores[Math.min(k, walks.scores.length - 1)];
}

/** One control point as the walk reads it. */
export interface WalkRecord {
  /** Its position in thirds of a step, on the song's grid. */
  readonly thirds: number;
  /** Its velocity gain, `voice[+0x0c]`'s unit: the velocity over 127. */
  readonly gain: number;
}

/**
 * `voice[+0x0c]` after each walk from the one after the claim to the one that
 * closes the gate -- `PoolWalks.scores` before the channel factor.
 *
 * `0x3930`, transcribed for the one field. The playhead it reads is the
 * walk's whole step (`vroundss … 1` at `0x398e`, `[rbp-0x2c]`); the record
 * cursor `+0x3c` starts on the note's first record:
 *
 * ```
 * 0x3a41  if playhead > rec[cursor].step:         ; the integer step, sub-step ignored
 * 0x3a46    if rec[cursor] ends the note: close the gate   ; this walk still writes +0x0c
 *           else cursor += 1                      ; ONE record per walk, never more
 * 0x3c1c  cur = playhead < rec[cursor].step && cursor > 0 ? cursor - 1 : cursor
 * 0x3c3a  [+0x0c] = rec[cur].velocity / 127
 * 0x3e66  slide   = (rec[cur+1].velocity / 127 - [+0x0c]) / (pos(cur+1) - pos(cur))
 * 0x3e9b  if rec[cur].step < playhead <= rec[cur+1].step:
 * 0x3ee5    [+0x0c] += (playhead - pos(cur)) * slide        ; caught up to the whole step
 * ```
 *
 * where `pos` is step plus sub-step thirds and the slide needs a next record
 * strictly later than this one (`0x3d86`). So the score is the note's volume
 * ramp read at each whole step, with two departures a sampled ramp would not
 * make: a record on a sub-step is taken at its whole step's walk at its own
 * velocity, and a note with two records inside one step trails its ramp by a
 * walk, because the cursor moves once per walk.
 *
 * ⚠️ `0x3a5a` closes the gate when the cursor reaches the clip's record count,
 * and `0x3a1f` when a record's step is past the clip's length; the first
 * cannot happen inside a note and the second needs `PInstrument+0x60`, which
 * nothing reads (*Residues* in steering/open-questions.md).
 */
export function walkVelocities(records: readonly WalkRecord[]): number[] {
  const n = records.length;
  if (n === 0) return [];
  const step = (i: number) => Math.floor(records[i].thirds / 3);
  const out: number[] = [];
  let cursor = 0;
  for (let playhead = step(0) + 1; ; playhead += 1) {
    let closes = false;
    if (playhead > step(cursor)) {
      if (cursor === n - 1) closes = true;
      else cursor += 1;
    }
    const cur = cursor > 0 && playhead < step(cursor) ? cursor - 1 : cursor;
    let gain = records[cur].gain;
    const next = records[cur + 1];
    if (next !== undefined && next.thirds > records[cur].thirds && playhead > step(cur) &&
      playhead <= step(cur + 1)) {
      const span = (next.thirds - records[cur].thirds) / 3;
      gain += (playhead - records[cur].thirds / 3) * ((next.gain - gain) / span);
    }
    out.push(gain);
    if (closes) return out;
  }
}

/** What the pool decided for one note. */
export interface PooledResult {
  /** Index into the input array. */
  readonly index: number;
  /**
   * When the note actually stops. Equal to its own `end` unless a later note
   * stole its voice, in which case it is that note's `start`.
   */
  readonly end: number;
}

/**
 * Run notes through the pool, returning each note's real end.
 *
 * Notes are taken in start order, which is the order the sequencer triggers
 * them. A note whose voice is stolen stops at the moment of the theft; it is
 * never dropped outright, because the engine does not drop it either -- it
 * overwrites the record, and the sound stops there.
 */
export function allocateVoices(
  notes: readonly PooledNote[],
  poolSize: number = VOICE_POOL_SIZE,
): PooledResult[] {
  // `VOICES_UNLIMITED` short-circuits: nothing is ever stolen, so every note
  // keeps the end it was given.
  if (!Number.isFinite(poolSize)) {
    return notes.map((note, index) => ({ index, end: note.end }));
  }
  const order = notes
    .map((note, index) => ({ note, index }))
    .sort(
      (a, b) =>
        a.note.start - b.note.start || (a.note.rank ?? 0) - (b.note.rank ?? 0) || a.index - b.index,
    );

  /** One slot per voice record; `undefined` is `+0x00 == 0xff`. */
  const pool: ({ index: number; note: PooledNote } | undefined)[] = new Array(poolSize).fill(
    undefined,
  );
  const ends = new Map<number, number>();

  for (const { note, index } of order) {
    // A record frees itself when its voice finishes, so retire the expired
    // ones before looking for a free slot.
    for (let i = 0; i < poolSize; i += 1) {
      const held = pool[i];
      if (held && held.note.end <= note.start) pool[i] = undefined;
    }

    let chosen = pool.findIndex((slot) => slot === undefined);
    if (chosen === -1) {
      // ⚠️ Best starts at 1.0 and best index at 0, exactly as at 0x1640-0x164d.
      let best = 1;
      chosen = 0;
      for (let i = 0; i < poolSize; i += 1) {
        const score = scoreAt(pool[i]!.note, note.start);
        if (score < best) {
          best = score;
          chosen = i;
        }
      }
      const stolen = pool[chosen]!;
      ends.set(stolen.index, note.start);
    }

    pool[chosen] = { index, note };
    ends.set(index, note.end);
  }

  return notes.map((_, index) => ({ index, end: ends.get(index) ?? notes[index].end }));
}

/**
 * The same allocator, fed one note at a time.
 *
 * ⚠️ **`allocateVoices` is causal** -- it walks notes in start order, retires
 * the slots whose voices have ended, and steals the lowest-scoring survivor,
 * never looking at a note it has not reached. That is the engine's own runtime
 * behaviour (`0x1640`-`0x164d`), so the offline pass is a model of something
 * that can be done live, and this is that same rule with the loop turned inside
 * out. A held note's `walks` are no look-ahead either: they come from its own
 * records, which the engine holds from the claim on.
 *
 * `add` returns the note's own end, plus the note whose voice it stole and the
 * frame the theft happens at -- everything a live scheduler needs to revise a
 * voice it has already handed over.
 *
 * ⚠️ **Notes must arrive in the order `allocateVoices` would have sorted them**:
 * by `start`, ties broken by the order they were added. `packages/lbp-tracker-lib/test/polyphony.test.ts`
 * pins the equivalence, because the moment these two disagree the live player
 * and the renderer are different instruments.
 */
export class LiveVoicePool {
  private readonly pool: ({ index: number; note: PooledNote } | undefined)[];
  private readonly poolSize: number;

  constructor(poolSize: number = VOICE_POOL_SIZE) {
    // A parameter property would be tidier and `erasableSyntaxOnly` forbids it:
    // this project type-strips rather than compiles, so nothing may survive
    // erasure. See tsconfig.
    this.poolSize = poolSize;
    this.pool = new Array(Number.isFinite(poolSize) ? poolSize : 0).fill(undefined);
  }

  add(index: number, note: PooledNote): { end: number; stole?: { index: number; at: number } } {
    if (!Number.isFinite(this.poolSize)) return { end: note.end };

    for (let i = 0; i < this.pool.length; i += 1) {
      const held = this.pool[i];
      if (held && held.note.end <= note.start) this.pool[i] = undefined;
    }

    let chosen = this.pool.findIndex((slot) => slot === undefined);
    let stole: { index: number; at: number } | undefined;
    if (chosen === -1) {
      // ⚠️ Best starts at 1.0 and best index at 0, exactly as at 0x1640-0x164d.
      let best = 1;
      chosen = 0;
      for (let i = 0; i < this.pool.length; i += 1) {
        const score = scoreAt(this.pool[i]!.note, note.start);
        if (score < best) {
          best = score;
          chosen = i;
        }
      }
      stole = { index: this.pool[chosen]!.index, at: note.start };
    }
    this.pool[chosen] = { index, note };
    return { end: note.end, stole };
  }
}
