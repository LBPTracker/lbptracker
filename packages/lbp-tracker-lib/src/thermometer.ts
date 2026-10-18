/**
 * The sequencer's thermometer: what a board costs, as the game counts it.
 *
 * The game keeps a budget per sequencer, in bytes of sample, apart from the
 * level's thermometer. The eboot's `v0x1c4720` is the whole rule:
 *
 * ```
 * for every PInstrument on the board:
 *   if its RInstrument is loaded:
 *     for each of SampleGuids_0..7 that is not empty:   ; +0xc8 .. +0xe4
 *       set.insert(guid)                                ; v0xb3ab30, a std::set
 * for guid in set:
 *   row = file databases' row for guid                  ; v0x10680
 *   if row: total += row.size                           ; [row + 4]
 * ```
 *
 * So a second chip of the same sound is free, two instruments that share a
 * sample pay for it once -- the three pianos together cost what one does -- and
 * notes cost nothing. `v0x74b960` shows the total against `MaxSequencerMemory`,
 * which `gamedata/data/limits_settings.lmt` sets to 1,000,000, and past it the
 * game says there are "too many instruments on this sequencer".
 *
 * `dev/sequencer-memory.ts` holds this against real levels: of 183 sequencers
 * none is over and the fullest is at 999,562. The readings, and what was not
 * read, are in steering/sequencer-engine-inputs.md.
 */

/** `MaxSequencerMemory`, in bytes of `.smp` file. */
export const MAX_SEQUENCER_MEMORY = 1_000_000;

export interface SequencerMemory {
  /** The summed size of every distinct sample. */
  bytes: number;
  /** Distinct samples with no known size, which the game's sum skips too. */
  missing: number;
}

/**
 * The cost of a set of instruments, each given as the sample GUIDs of its used
 * slots. `sizeOf` is the FileDB's size for a sample, or `undefined` where there
 * is no row.
 */
export function sequencerMemory(
  instruments: Iterable<readonly number[]>,
  sizeOf: (sampleGuid: number) => number | undefined,
): SequencerMemory {
  const samples = new Set<number>();
  for (const guids of instruments) {
    for (const guid of guids) if (guid) samples.add(guid);
  }
  let bytes = 0;
  let missing = 0;
  for (const guid of samples) {
    const size = sizeOf(guid);
    if (size === undefined) missing += 1;
    else bytes += size;
  }
  return { bytes, missing };
}

/**
 * What adding one more instrument would cost on top of what is there: the
 * samples it brings that the board does not already hold.
 */
export function addedSequencerMemory(
  instruments: Iterable<readonly number[]>,
  added: readonly number[],
  sizeOf: (sampleGuid: number) => number | undefined,
): number {
  const held = [...instruments];
  return sequencerMemory([...held, added], sizeOf).bytes - sequencerMemory(held, sizeOf).bytes;
}

/** The game's test, `v0x74cb7f`: over only when strictly past the limit. */
export const overSequencerMemory = (bytes: number): boolean => bytes > MAX_SEQUENCER_MEMORY;
