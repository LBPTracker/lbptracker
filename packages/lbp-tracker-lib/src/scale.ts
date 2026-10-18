/**
 * The sequencer's scale quantiser -- `0x240` in `fmodextinput.prx` (⚠️ not
 * `0x250`, an older label that is mid-function).
 *
 * A note in the sequencer is **not** played at the semitone it names. The
 * engine snaps it to the sequencer's scale first, so a note the editor shows on
 * a black key can sound a semitone or two away. Skipping this does not merely
 * lose a feature, it detunes anything authored on a non-chromatic scale.
 *
 * ⚠️ The snap is to a nearby tone, **not** reliably downward: the blues table
 * sends position 2 up to 3, and its ties break in both directions. The tables
 * are the fact; do not replace them with a rule.
 *
 * The tables are at module vaddr **`0x80c0`**, which is the addend of the
 * `R_X86_64_RELATIVE` relocation on the pointer slot at `0x8020` -- not a
 * figure derived from a segment mapping. Six rows of twelve `int32`. See
 * steering/sequencer-engine-inputs.md.
 *
 * ⚠️ **An earlier reading of this table was off by one row**, which named every
 * scale wrongly and lost one entirely. It came from computing the address from
 * the segment mapping instead of reading the relocation, landing 48 bytes
 * early on a row of zeros that looked like a plausible "unused" row 0. Read the
 * relocation.
 */

/**
 * Semitone for each chromatic position, per scale. Index with the scale id.
 *
 * Row 0 exists only so the ids line up with the engine's; it is never read,
 * since `quantise` passes scale 0 through unchanged.
 */
export const SCALE_TABLES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic -- the identity
  [0, 0, 2, 2, 4, 5, 5, 7, 7, 9, 9, 11], // major            {0,2,4,5,7,9,11}
  [0, 0, 2, 3, 3, 5, 5, 7, 8, 8, 10, 10], // natural minor    {0,2,3,5,7,8,10}
  [0, 0, 0, 3, 3, 5, 5, 7, 7, 7, 10, 10], // minor pentatonic {0,3,5,7,10}
  [0, 0, 3, 3, 5, 5, 6, 6, 7, 7, 10, 10], // blues            {0,3,5,6,7,10}
  [0, 0, 2, 2, 4, 4, 6, 7, 7, 9, 9, 11], // lydian           {0,2,4,6,7,9,11}
];

/**
 * Names in the engine's id order, for display.
 *
 * Row 0 is never reached through `quantise` -- the engine returns early for
 * scale 0 -- but it holds the identity, so naming it chromatic is honest: an id
 * of 0 and an id out of range both leave the note alone.
 */
export const SCALE_NAMES: readonly string[] = [
  'chromatic',
  'major',
  'natural minor',
  'minor pentatonic',
  'blues',
  'lydian',
];

/** The highest scale id the engine accepts; anything else is chromatic. */
export const MAX_SCALE = 5;

/**
 * Snap a note to `scale`, preserving its octave.
 *
 * ⚠️ The engine's guard is `(unsigned)(scale - 1) > 4`, so **scale 0 and
 * anything above 5 pass through unchanged** -- an out-of-range id is not an
 * error and must not be treated as one.
 *
 * The division is signed and truncating, matching the engine's `imul`/`sar`
 * sequence, so negative notes fold the same way they do there.
 */
export function quantise(note: number, scale: number): number {
  if (scale < 1 || scale > MAX_SCALE) return note;
  const octave = Math.trunc(note / 12);
  const within = note - octave * 12;
  // A negative note leaves `within` negative; the engine indexes the table with
  // it just the same, so guard rather than reproduce an out-of-bounds read.
  if (within < 0 || within > 11) return note;
  return octave * 12 + SCALE_TABLES[scale][within];
}

/**
 * A note that `quantise` would snap to `note`, or `note` itself if none does.
 *
 * ⚠️ **This is a section of the quantiser, not an inverse, and it cannot
 * be one.** `quantise` is a projection: on the major table both 0 and 1 land on
 * 0, so a snapped note names a SET of notes that produce it and nothing in the
 * result says which the author wrote. The convention here is the lowest of
 * them, which is what the tables' own shape makes natural -- every row is
 * non-decreasing, so the lowest preimage of a tone is the tone itself wherever
 * the scale contains it, and `unquantise(quantise(n)) === quantise(n)`.
 *
 * ❗ So a scaled placement's own pitch fields survive a round trip only where
 * the author wrote scale tones; anything they wrote off the scale comes back as
 * the tone it sounded. That is a real loss and the MIDI exporter covers it a
 * different way -- it carries the clip's records verbatim -- but the pitch here
 * still has to be a note that SOUNDS right, which this guarantees and a bare
 * copy of the sounded pitch would not.
 *
 * A target the scale never produces (the major table reaches no 1, 3, 6, 8 or
 * 10) has no preimage at all; it comes back unchanged, which is the same thing
 * scale 0 does.
 */
export function unquantise(note: number, scale: number): number {
  if (scale < 1 || scale > MAX_SCALE) return note;
  const octave = Math.trunc(note / 12);
  const within = note - octave * 12;
  if (within < 0 || within > 11) return note;
  const found = SCALE_TABLES[scale].indexOf(within);
  return found < 0 ? note : octave * 12 + found;
}

/**
 * How far `Key` transposes a placement, in semitones.
 *
 * **Measured, both ends of it, 2026-09-02.**
 *
 * The DSP adds a root and subtracts an octave -- `voice.pitch =
 * quantise(note, scale) + blockRoot - 12`, at `fmodextinput.prx` `0x3c4e` and
 * `0x3db5`, both spelled `lea eax, [rax + rcx - 0xc]` with `rcx` from the note
 * block's `+0x10`. What that entry says on its own is only "there is a root".
 *
 * What fills it is the eboot, at `v0x160806`:
 *
 * ```
 * v0x160806  mov    eax, [rdi + 0x28]     ; PInstrument.Key
 * v0x160809  lea    ecx, [rax + 0xc]      ; key + 12
 * v0x16080c  cmp    eax, 0xc
 * v0x16080f  cmovae ecx, eax              ; ... unless the key is already >= 12
 * v0x160819  mov    [rsi + 0x10], ecx     ; -> the block's root
 * v0x16081c  mov    ecx, [rdi + 0x2c]     ; PInstrument.Scale
 * v0x16081f  mov    [rsi + 0xc], ecx      ; -> the block's scale
 * ```
 *
 * `[rdi+0x28]` and `[rdi+0x2c]` are `Key` and `Scale`: the four fields after
 * them, `+0x30`, `+0x34`, `+0x38` and `+0x3c`, are copied to the block as
 * level, pan, echo send and reverb send, in `PInstrument`'s own declaration
 * order, so the struct is pinned rather than guessed.
 *
 * So the root is `key < 12 ? key + 12 : key` and the transposition is that
 * minus 12 -- which over the range the corpus uses is exactly **`key mod 12`**.
 * The corpus uses 0 and 12..23 and nothing else: `Key` is a note within one
 * octave with **C at 12**, and **0 is the untouched default**, which the
 * `< 12` branch exists to turn into C.
 *
 * ⚠️ **This project ignored `Key` entirely until it was read.** It is 0 on
 * 125,447 of the corpus's 129,696 placements, so the 4,249 that set it were
 * transposed by up to 11 semitones -- a wrong key, not a detune.
 */
export function blockRoot(key: number): number {
  return key < 12 ? key + 12 : key;
}

/**
 * The net transposition `Key` applies, in semitones: `blockRoot(key) - 12`.
 *
 * Over the range the corpus uses -- 0, and 12..23 -- that is exactly
 * `key mod 12`. Kept as its own function because the two halves it composes were
 * measured in different binaries and either could be re-checked alone.
 *
 * ⚠️ Only the **pitch** goes through this. The key-zone walk at `0x05a0` takes
 * the raw 7-bit note field, so the slot a note plays on is chosen before either
 * the quantiser or the key touches it. Feeding a transposed note to
 * `resolveSlot` would move notes between samples at key boundaries.
 */
export function keyOffset(key: number): number {
  return blockRoot(key) - 12;
}

/**
 * A note word's 7-bit field to the pitch the voice actually plays.
 *
 * `root` is the note block's `+0x10`. The `- 12` is the engine's, at `0x3c20`
 * (`lea eax, [rax + rdx - 0xc]`).
 */
export function notePitch(note: number, scale: number, root: number): number {
  return quantise(note, scale) + root - 12;
}
