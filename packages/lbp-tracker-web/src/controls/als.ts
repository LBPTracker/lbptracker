/**
 * The Ableton export's controls — the Convert view, `daw/als-export.ts`.
 *
 * Its own store rather than a borrow of the MIDI one: the two exports sit side
 * by side, and a swing bake ticked for one file must not quietly change the
 * other.
 */

import { createControls, type Check, type Group, type Spec } from './kit.ts';

const GROUP_SPECS = [
  // What each option does is in the help (src/help.ts, 'als'), not beside it.
  { key: 'write', title: 'how to write it', stack: true },
] as const satisfies readonly Group[];

const CHECK_SPECS = [
  { id: 'bakeSwing', group: 'write', label: 'bake the swing into the timing', start: false },
  { id: 'mergeRows', group: 'write', label: 'one track per row, not per mixer setting', start: true },
  // Off by default: on, the download carries the game's samples, and is a zip.
  { id: 'instruments', group: 'write', label: 'the instruments and their samples, as a Live project (.zip)', start: false },
  // Off by default: ours, not the game's, like the engine card's other master bus.
  { id: 'masterBus', group: 'write', label: 'our master bus on the master: glue and limiter, at the engine’s glue', start: false },
] as const satisfies readonly Check[];

export type AlsCheck = (typeof CHECK_SPECS)[number]['id'];

export const ALS: Spec<never, AlsCheck, never> = {
  groups: GROUP_SPECS,
  faders: [],
  checks: CHECK_SPECS,
};

export const als = createControls(ALS);
