/**
 * The sequencer's thermometer on the page: the blue one the game keeps beside
 * an open sequencer, counting bytes of sample against `MaxSequencerMemory`.
 *
 * The rule is the game's and lives in `@lbptracker/lib/thermometer.ts`; this
 * file feeds it the song and the manifests, draws the meter beside the board and
 * prices the instrument picker's rows -- the game's own message points at the
 * thermometer "to see how expensive each instrument you place is".
 *
 * ❗ **It warns, and refuses nothing.** What was read in the eboot is a message
 * when the cost goes over, not a refusal (steering/sequencer-engine-inputs.md), and
 * a level can arrive over the limit from somebody's modded game.
 */

import {
  MAX_SEQUENCER_MEMORY, overSequencerMemory, sequencerMemory, type SequencerMemory,
} from '@lbptracker/lib/thermometer.ts';
import type { Song } from '@lbptracker/lib/song.ts';
import { instrumentSamples } from '../assets.ts';
import { ensureAssets, rinstIndex, setStatus, smpIndex, state } from './session.ts';

/** RInstrument GUID -> its used sample GUIDs; empty until the `.rinst` files are in. */
let samples = new Map<number, number[]>();
const ready = new Set<() => void>();

const sizeOf = (sampleGuid: number): number | undefined => smpIndex?.get(sampleGuid)?.size;

/** The sample lists of the song's distinct instruments, leaving one chip out if asked. */
function held(song: Song, exceptClip?: number): number[][] {
  const guids = new Set(song.clips.filter((c) => c.id !== exceptClip).map((c) => c.guid));
  return [...guids].map((g) => samples.get(g) ?? []);
}

/** What the song costs, as the game would show it for this sequencer. */
export const songMemory = (song: Song = state.song): SequencerMemory => sequencerMemory(held(song), sizeOf);

export interface InstrumentCost {
  /** Bytes this instrument would add to the board as it stands. */
  added: number;
  /** Whether the board would then be past the limit. */
  over: boolean;
}

/**
 * A pricer for the picker's rows. `exceptClip` is the chip whose sound is being
 * changed: its present instrument stops counting unless another chip plays it.
 * `null` until the instruments have been read, so the picker shows no prices
 * rather than wrong ones.
 */
export function instrumentCosts(exceptClip?: number): ((guid: number) => InstrumentCost) | null {
  if (!samples.size) return null;
  const base = held(state.song, exceptClip);
  const before = sequencerMemory(base, sizeOf).bytes;
  return (guid) => {
    const after = sequencerMemory([...base, samples.get(guid) ?? []], sizeOf).bytes;
    return { added: after - before, over: overSequencerMemory(after) };
  };
}

/** A share of the limit, as the meter and the picker write it. */
export const percentOfLimit = (bytes: number): string => {
  const p = (100 * bytes) / MAX_SEQUENCER_MEMORY;
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
};

/** Decimal megabytes, so that the game's round million reads 1.00. */
const inMegabytes = (bytes: number): string => (bytes / 1e6).toFixed(2);

/** Wire the meter in the arrange view. Safe to call before the assets are in. */
export function mountThermometer(root: HTMLElement): void {
  const fill = root.querySelector<HTMLElement>('.thermo-fill')!;
  const text = root.querySelector<HTMLElement>('.thermo-text')!;
  const megabytes = root.querySelector<HTMLElement>('.thermo-bytes')!;
  let wasOver = false;

  const draw = (): void => {
    if (!samples.size) {
      root.hidden = true;
      return;
    }
    const { bytes } = songMemory();
    const over = overSequencerMemory(bytes);
    root.hidden = false;
    root.classList.toggle('over', over);
    fill.style.height = `${Math.min(100, (100 * bytes) / MAX_SEQUENCER_MEMORY)}%`;
    text.textContent = percentOfLimit(bytes);
    // Three short lines: the column is narrow (`white-space: pre-line`).
    megabytes.textContent = `${inMegabytes(bytes)}
/ ${inMegabytes(MAX_SEQUENCER_MEMORY)}
MB`;
    root.setAttribute('aria-valuenow', String(Math.min(bytes, MAX_SEQUENCER_MEMORY)));
    root.title =
      `Sequencer thermometer: ${bytes.toLocaleString('en')} of ${MAX_SEQUENCER_MEMORY.toLocaleString('en')} bytes of samples. ` +
      'Each different sound costs its samples once, however many chips play it; notes are free. ' +
      (over ? 'This is more than the game allows on one sequencer.' : 'Past 100% the game says there are too many instruments.') +
      ' Click for more.';
    // The game says so once, when the cost goes over, and again only after it has been back under.
    if (over && !wasOver) {
      setStatus('There are too many instruments on this sequencer for the game. Try removing or replacing some.', true);
    }
    wasOver = over;
  };

  state.onChange((kind) => {
    if (kind !== 'selection' && kind !== 'look' && kind !== 'mix') draw();
  });
  ready.add(draw);
  draw();
}

/** Read every instrument's samples, once; the meter and the picker follow. */
export async function loadThermometer(): Promise<void> {
  await ensureAssets();
  if (!rinstIndex || samples.size) return;
  samples = await instrumentSamples(rinstIndex);
  for (const fn of ready) fn();
}
